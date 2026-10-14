#!/usr/bin/env node
'use strict';
/*
 * SQUAD/CODE bridge: serves index.html, spawns headless Claude Code (`claude -p`) and keeps the app's data in SQLite (db.js).
 * Only dependency: better-sqlite3 (`npm install`). Binds to 127.0.0.1 only and requires a per-start token on every API call.
 *
 *   node server.js [--port 4317]
 *
 * Environment:
 *   SQUAD_PORT        port (default 4317)
 *   SQUAD_CLAUDE_BIN  claude executable to use when the UI does not set one (default: "claude")
 *   SQUAD_HOME        overrides the home dir used for ~/.claude/settings.json (tests)
 *   SQUAD_PROJECTS_DIR root of the per-project folders (default: ./projects next to this file)
 *   SQUAD_DATA_DIR    folder of the SQLite database, squad.db (default: ./data next to this file)
 *   SQUAD_REPOS       list of existing repositories an operation can link to (default: SQUAD_DATA_DIR/repos.json)
 */
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const ROOT = __dirname;
const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort > -1 ? process.argv[argPort + 1] : process.env.SQUAD_PORT) || 4317;
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(24).toString('hex');
const HOME = process.env.SQUAD_HOME || os.homedir();
const DEFAULT_BIN = process.env.SQUAD_CLAUDE_BIN || 'claude';
const IS_WIN = process.platform === 'win32';
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'squad-code-'));
// Every project runs in its own folder under PROJECTS_DIR (created on the first run).
const PROJECTS_DIR = path.resolve(process.env.SQUAD_PROJECTS_DIR || path.join(ROOT, 'projects'));
const FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const RESERVED_RE = /^(con|prn|aux|nul|com\d|lpt\d)$/;
try { fs.mkdirSync(PROJECTS_DIR, { recursive: true }); } catch {} // otherwise the first project run creates it
// The app's data (workspace, versions, operation rooms, chats, run history) lives in DATA_DIR/squad.db (db.js).
// It is opened at start only when it exists (or a data/workspace.json from the file version waits to be imported); otherwise the
// page asks the person to create it (POST /api/setup) and nothing is written to disk before that.
const DATA_DIR = path.resolve(process.env.SQUAD_DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'squad.db');
const LEGACY_FILE = path.join(DATA_DIR, 'workspace.json');
const MAX_WORKSPACE = 64 * 1024 * 1024;
const dbModule = require('./db.js');
if (dbModule.driverError) { console.error(`SQUAD/CODE: ${dbModule.driverError}`); process.exit(1); }
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) console.warn(`SQUAD/CODE pede o Node 22 ou mais novo (este é o ${process.version}). Atualize se algo falhar.`);
let store = null;
function openDb() {
  store = dbModule.openStore(DATA_DIR);
  if (store.migration?.imported) console.log(`Workspace migrado de data/workspace.json para ${store.file} (${store.migration.versions} versões antigas). Os arquivos JSON foram para ${path.join(DATA_DIR, 'legacy-json')}.`);
  if (store.migration?.warning) console.warn(store.migration.warning);
  if (store.migration?.error) console.warn(store.migration.error);
  return store;
}
// No database, or one without a workspace yet: the page shows "Nenhum banco de dados encontrado" before anything else.
const setupNeeded = () => !store || !store.readWorkspace(false).exists;
function needStore() {
  if (!store) throw Object.assign(new Error('Nenhum banco de dados ainda. Crie um na tela inicial do SQUAD/CODE.'), { status: 503 });
  return store;
}

const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const TOOL_RE = /^[A-Za-z][A-Za-z0-9_]*(\([^()\r\n"]{0,200}\))?$|^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_*-]+)?$/;
const MODEL_RE = /^[A-Za-z0-9._\-\[\]]{1,80}$/;
const MAX_EVENTS = 5000;
const MAX_BODY = 2 * 1024 * 1024;

const runs = new Map();
let maxConcurrent = 2;
const versionCache = new Map();

/* ---------- helpers ---------- */
function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}
function fail(res, status, message) { json(res, status, { ok: false, error: message }); }

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Corpo da requisição muito grande.'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON inválido.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function allowedHost(value) {
  if (!value) return false;
  return value === `${HOST}:${PORT}` || value === `localhost:${PORT}`;
}
function allowedOrigin(origin) {
  if (!origin) return true; // same-origin GET/navigation, curl
  return origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
}
function tokenOk(req, url) {
  const given = req.headers['x-squad-token'] || url.searchParams.get('token') || '';
  const a = Buffer.from(String(given)); const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Resolve an executable name to a full path (Windows needs to know .exe vs .cmd). */
function resolveBin(bin) {
  return new Promise(resolve => {
    if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\')) return resolve(fs.existsSync(bin) ? path.resolve(bin) : null);
    execFile(IS_WIN ? 'where' : 'which', [bin], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const lines = String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const pick = IS_WIN ? (lines.find(l => /\.(exe|cmd|bat)$/i.test(l)) || lines[0]) : lines[0];
      resolve(pick || null);
    });
  });
}

/** Expand Windows 8.3 short names (C:\USER~1) that Claude Code's path safety checks reject. */
const longPath = p => { try { return fs.realpathSync.native(p); } catch { return p; } };

/* Claude Code loads CLAUDE.md from every folder above the cwd: project runs skip this app's own instructions.
 * Absolute patterns plus a `**`-anchored variant (last two segments of ROOT), in case the drive letter does not match. */
const MEMORY_FILES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', '.claude/CLAUDE.md', '.claude/rules/**'];
const APP_MEMORY_EXCLUDES = (() => {
  const root = longPath(ROOT).replace(/\\/g, '/'), tail = root.split('/').filter(Boolean).slice(-2).join('/');
  return [...MEMORY_FILES.map(f => `${root}/${f}`), ...MEMORY_FILES.map(f => `**/${tail}/${f}`)];
})();

/* Each project folder is its own git repository (git init before its first run, when git is installed). Otherwise Claude Code, which
 * takes the enclosing repository as the project (git status, .claude/settings.json outside Windows), and the agents' git commands
 * would work on whatever repository holds PROJECTS_DIR, such as this app's clone. GIT_CEILING_DIRECTORIES (startRun) covers the rest. */
const gitCeiling = () => [longPath(PROJECTS_DIR), process.env.GIT_CEILING_DIRECTORIES].filter(Boolean).join(path.delimiter);
let gitMissing = false;
function ensureProjectRepo(dir) {
  if (gitMissing || fs.existsSync(path.join(dir, '.git'))) return Promise.resolve();
  return new Promise(resolve => {
    execFile('git', ['init', '-q'], { cwd: dir, windowsHide: true, timeout: 15000, env: { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling() } }, err => {
      if (err?.code === 'ENOENT') { gitMissing = true; console.warn('git não encontrado: as pastas dos projetos ficam sem repositório próprio. Instale o Git para isolá-las.'); }
      else if (err) console.warn(`git init em ${dir} falhou: ${err.message}`);
      resolve();
    });
  });
}

/* Existing repositories an operation can link to (project.repoId). The person lists them in REPOS_FILE, read on every use (it can be
 * edited while the bridge runs, and the bridge never writes it): {"repos":[{"id":"billing","name":"Faturamento","path":"C:/code/billing"
 * (or "url":"https://..."),"baseBranch":"main"}]}. The page only names an id, never a path. A linked operation's folder becomes a
 * clone of that repository (checkProjectClone, cloneProject), so the agents never touch the person's own working copy. */
const REPOS_FILE = path.resolve(process.env.SQUAD_REPOS || path.join(DATA_DIR, 'repos.json'));
const BRANCH_RE = /^(?![-/.])(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const REPO_URL_RE = /^(https:\/\/|ssh:\/\/|git@)[^\s"']{3,500}$/;
function loadRepos() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(REPOS_FILE, 'utf8')); }
  catch (e) { return { file: REPOS_FILE, repos: [], error: e.code === 'ENOENT' ? null : `${REPOS_FILE}: ${e.message}` }; }
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.repos) ? raw.repos : [];
  const seen = new Set(), repos = [];
  for (const r of list.slice(0, 50)) {
    const id = String(r?.id || '').trim();
    if (!FOLDER_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    const dir = !url && typeof r.path === 'string' && r.path.trim() ? path.resolve(path.dirname(REPOS_FILE), r.path.trim()) : '';
    const baseBranch = typeof r.baseBranch === 'string' ? r.baseBranch.trim() : '';
    let error = null;
    if (url) { if (!REPO_URL_RE.test(url)) error = 'URL inválida (use https://, ssh:// ou git@).'; }
    else if (!dir) error = 'Informe "path" ou "url".';
    else if (!fs.existsSync(path.join(dir, '.git')) && !fs.existsSync(path.join(dir, 'HEAD'))) error = 'O caminho não é um repositório git.';
    if (baseBranch && !BRANCH_RE.test(baseBranch)) error = 'baseBranch inválida.';
    const prepare = typeof r.prepare === 'string' ? r.prepare.trim().slice(0, 500) : '';
    repos.push({ id, name: String(r.name || id).slice(0, 80), source: url || (fs.existsSync(dir) ? longPath(dir) : dir), baseBranch, prepare, error });
  }
  return { file: REPOS_FILE, repos, error: null };
}
// What the page sees: no path or URL (a URL may carry credentials).
const publicRepos = () => { const r = loadRepos(); return { file: r.file, error: r.error, repos: r.repos.map(({ id, name, baseBranch, error }) => ({ id, name, baseBranch, error })) }; };

// track(child) receives each git process, so a cancelled run can kill the one in progress.
const gitRun = (args, cwd, timeout = 15000, track, env = {}) => new Promise((resolve, reject) => {
  const child = execFile('git', args, { cwd, windowsHide: true, timeout, env: { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling(), GIT_TERMINAL_PROMPT: '0', ...env } },
    (err, out, errOut) => err ? reject(Object.assign(new Error(String(errOut || err.message).trim().slice(0, 500)), { code: err.code })) : resolve(String(out).trim()));
  track?.(child);
});
const sameSource = (a, b) => {
  const norm = s => REPO_URL_RE.test(s) ? s.replace(/\/+$/, '').replace(/\.git$/, '') : path.resolve(s).replace(/[\\/]+$/, '');
  return IS_WIN ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};
/** What a linked operation's folder needs, checked before the run is accepted: 'ready' (already a clone of that repository), 'clone'
 * (empty) or 'reinit' (only the empty repository of an earlier git init, from a chat before the link). Anything else is refused. */
async function checkProjectClone(dir, repo) {
  if (repo.error) throw new Error(`Repositório ${repo.id}: ${repo.error}`);
  const entries = fs.readdirSync(dir), unused = 'o vínculo com um repositório existente vale só para operações que ainda não trabalharam na pasta';
  if (!entries.includes('.git')) {
    if (entries.length) throw new Error(`A pasta da operação já tem arquivos: ${unused}.`);
    return 'clone';
  }
  let origin = '';
  try { origin = await gitRun(['remote', 'get-url', 'origin'], dir); } catch {}
  if (origin) {
    if (sameSource(origin, repo.source)) return 'ready';
    throw new Error(`A pasta da operação já é clone de outro repositório, não de ${repo.id}.`);
  }
  let head = true;
  try { await gitRun(['rev-parse', '--verify', '-q', 'HEAD'], dir); } catch { head = false; }
  if (head || entries.length > 1) throw new Error(`A pasta da operação já tem um repositório próprio: ${unused}.`);
  return 'reinit';
}
async function cloneProject(dir, repo, state, track) {
  if (state === 'reinit') fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  // Windows: worktrees (<clone>/.wt/<feature>/...) easily pass the 260-character path limit; core.longpaths lifts it in Git for Windows.
  try { await gitRun(['clone', '-q', '-c', 'core.longpaths=true', ...(repo.baseBranch ? ['--branch', repo.baseBranch] : []), '--', repo.source, dir], PROJECTS_DIR, 600000, track); }
  catch (e) { throw new Error(e.code === 'ENOENT' ? 'Git não encontrado: instale o Git para vincular um repositório existente.' : `git clone de ${repo.id} falhou: ${e.message}`); }
}
/* Agents never push, whatever the command looks like (git -C . push, sh -c, another remote): the clone's origin has no push URL,
 * and a pre-push hook refuses any push without the bridge's mark (SQUAD_BRIDGE_PUSH), which only "Enviar branch" sets. Both are
 * re-applied before every run. They do not stop someone who rewrites the git config or passes --no-verify on purpose: the real
 * guarantee is the server's (branch protection on the base branch). A repository with its own core.hooksPath skips the hook. */
const NO_PUSH_URL = 'no-push://squad-code-use-enviar-branch';
const PRE_PUSH = '#!/bin/sh\n# SQUAD/CODE: os agentes não enviam branches; use "Enviar branch" no app.\n[ "$SQUAD_BRIDGE_PUSH" = "1" ] && exit 0\necho "SQUAD/CODE: push bloqueado. Use Enviar branch no app." >&2\nexit 1\n';
async function guardClone(root) {
  await gitRun(['config', 'remote.origin.pushurl', NO_PUSH_URL], root).catch(() => {});
  await gitRun(['config', 'core.longpaths', 'true'], root).catch(() => {}); // clones made before cloneProject set it
  const hook = path.join(root, '.git', 'hooks', 'pre-push');
  try { if (!fs.existsSync(hook) || fs.readFileSync(hook, 'utf8') !== PRE_PUSH) { fs.mkdirSync(path.dirname(hook), { recursive: true }); fs.writeFileSync(hook, PRE_PUSH, { mode: 0o755 }); } } catch {}
}

/* Linked operations: each feature works in its own git worktree of the operation's clone, <clone>/.wt/<feature> on branch
 * squad/<feature>, created on its first run from the freshly fetched base branch and reused until its approval removes it (the branch
 * stays, for the PR). Until docs/squad is on the base branch, features start from the reconnaissance branch (featureBase) so they get
 * the map. A new worktree runs the repository's "prepare" command (npm ci...) until it succeeds once. All of it is the run's
 * preparing phase (prepareRun): say(step, text) reports each step. */
const WT_DIR = '.wt';
const preparedMark = (root, slug) => path.join(root, '.git', `squad-prepared-${slug}`);
// Commit a feature branch started from, kept after approval: a branch without commits of its own is not reported as merged.
const startMark = (root, slug) => path.join(root, '.git', `squad-start-${slug}`);
const gitOk = (args, cwd) => gitRun(args, cwd).then(() => true, () => false);
async function ensureWorktree(root, repo, slug, baseSlug, track, say) {
  const dir = path.join(root, WT_DIR, slug), branch = `squad/${slug}`, notes = [];
  if (fs.existsSync(path.join(dir, '.git'))) return { dir, branch, notes, created: false };
  // .wt stays out of the clone's own git status.
  try {
    const exclude = path.join(root, '.git', 'info', 'exclude'), cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes(`/${WT_DIR}/`)) { fs.mkdirSync(path.dirname(exclude), { recursive: true }); fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}/${WT_DIR}/\n`); }
  } catch {}
  await gitRun(['worktree', 'prune'], root).catch(() => {});
  try {
    if (await gitOk(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], root)) await gitRun(['worktree', 'add', '-q', dir, branch], root, 120000, track);
    else {
      say('fetch', 'Atualizando a branch base (git fetch).');
      try { await gitRun(['fetch', '-q', 'origin'], root, 300000, track); } catch (e) { notes.push(`git fetch falhou, a feature parte da cópia local: ${e.message}`); }
      let start = repo.baseBranch ? `origin/${repo.baseBranch}` : 'origin/HEAD';
      if (!await gitOk(['rev-parse', '--verify', '-q', `${start}^{commit}`], root)) start = repo.baseBranch || 'HEAD';
      if (baseSlug && !await gitOk(['cat-file', '-e', `${start}:docs/squad/mapa.md`], root) && await gitOk(['rev-parse', '--verify', '-q', `refs/heads/squad/${baseSlug}`], root)) {
        start = `squad/${baseSlug}`;
        notes.push(`O mapa ainda não está na branch base: a feature parte de ${start}.`);
      }
      say('worktree', `Criando o worktree na branch ${branch}.`);
      await gitRun(['worktree', 'add', '-q', '-b', branch, dir, start], root, 120000, track);
      try { fs.writeFileSync(startMark(root, slug), await gitRun(['rev-parse', `${start}^{commit}`], root)); } catch {}
    }
  } catch (e) {
    // A half-made worktree folder would make the next attempt fail too; the branch, if created, is reused then.
    if (!fs.existsSync(path.join(dir, '.git'))) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} await gitRun(['worktree', 'prune'], root).catch(() => {}); }
    throw new Error(e.code === 'ENOENT' ? 'Git não encontrado.' : `Não foi possível criar o worktree ${slug}: ${e.message}`);
  }
  return { dir, branch, notes, created: true };
}
/** Runs the repository's prepare command in a new worktree, its output going to onOutput as it comes. null = nothing to prepare. */
function prepareWorktree(root, dir, repo, slug, track, onOutput) {
  if (!repo.prepare || fs.existsSync(preparedMark(root, slug))) return Promise.resolve(null);
  return new Promise(resolve => {
    let out = '', done = false;
    const finish = (ok, text) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok, text }); } };
    const child = spawn(repo.prepare, { cwd: dir, shell: true, windowsHide: true, detached: !IS_WIN, env: { ...process.env, GIT_CEILING_DIRECTORIES: gitCeiling() } });
    track?.(child);
    const keep = d => { out = (out + d).slice(-4000); onOutput?.(d.slice(0, 4000)); };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { killTree(child); finish(false, `Preparo "${repo.prepare}" passou de 15 minutos e foi interrompido.`); }, 900000);
    child.on('error', e => finish(false, `Preparo "${repo.prepare}" falhou: ${e.message}`));
    child.on('close', code => {
      if (code === 0) { try { fs.writeFileSync(preparedMark(root, slug), new Date().toISOString()); } catch {} finish(true, `Preparo concluído: ${repo.prepare}`); }
      else finish(false, `Preparo "${repo.prepare}" saiu com código ${code}:\n${out.trim().slice(-1500)}`);
    });
  });
}
/** Removes an approved feature's worktree (never with uncommitted work: git refuses it). The branch stays. */
async function removeWorktree(root, slug) {
  const dir = path.join(root, WT_DIR, slug);
  if (!fs.existsSync(dir)) return { removed: false, branch: `squad/${slug}` };
  try { await gitRun(['worktree', 'remove', dir], root, 60000); }
  catch (e) { throw Object.assign(new Error(`O worktree ${slug} não foi removido: ${e.message}`), { status: 409 }); }
  try { fs.rmSync(preparedMark(root, slug), { force: true }); } catch {}
  return { removed: true, branch: `squad/${slug}` };
}

/* Map freshness. docs/squad/.reconhecimento holds the base commit the map describes (and its date); what changed on the base branch
 * since then, outside docs/squad, comes from git, never from the model. A commit that left the history (rewritten base) falls back
 * to the last base commit before the map's date. 'fresh' = nothing changed, 'changed' = a few files (steps get the list), 'stale' =
 * structural changes (manifests, migrations, CI, top-level folders) or more than MAP_SMALL files: time to update the map. */
const MAP_FILE = 'docs/squad/.reconhecimento';
const MAP_SMALL = 30;
const STRUCTURAL_RE = /(^|\/)(package\.json|pnpm-workspace\.yaml|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|go\.mod|Cargo\.toml|requirements[^/]*\.txt|pyproject\.toml|Gemfile|composer\.json|[^/]+\.csproj|[^/]+\.sln|Dockerfile|docker-compose[^/]*\.ya?ml)$|(^|\/)migrations?\/|^\.github\/workflows\//i;
const baseRef = repo => repo.baseBranch ? `origin/${repo.baseBranch}` : 'origin/HEAD';
async function mapStatus(cwd, target) {
  let text = '';
  try { text = await gitRun(['show', `${target}:${MAP_FILE}`], cwd); } catch { return { status: 'missing', target }; }
  const commit = (text.match(/\b[0-9a-f]{7,40}\b/) || [])[0] || null, date = (text.match(/\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?/) || [])[0] || null;
  let ref = null, fallback = false;
  if (commit && await gitOk(['cat-file', '-e', `${commit}^{commit}`], cwd) && await gitOk(['merge-base', '--is-ancestor', commit, target], cwd)) ref = commit;
  else if (date) { try { ref = await gitRun(['rev-list', '-1', `--before=${date}`, target], cwd) || null; fallback = !!ref; } catch {} }
  if (!ref) return { status: 'unknown', target, commit, date };
  const out = await gitRun(['diff', '--name-status', '--no-renames', ref, target, '--', '.', ':(exclude)docs/squad'], cwd, 30000);
  const files = out ? out.split('\n').map(l => { const [s, ...p] = l.split('\t'); return { s: s.charAt(0), path: p.join('\t') }; }) : [];
  const tops = async r => new Set((await gitRun(['ls-tree', '--name-only', r], cwd).catch(() => '')).split('\n').filter(Boolean));
  const [before, after] = files.length ? await Promise.all([tops(ref), tops(target)]) : [new Set(), new Set()];
  // Top-level folders that appeared or went away, seen through the changed files (docs/squad is out of the diff).
  const top = f => f.path.split('/')[0];
  const structural = [...new Set([...files.filter(f => STRUCTURAL_RE.test(f.path)).map(f => f.path), ...files.filter(f => f.s === 'A' && !before.has(top(f))).map(f => `+ ${top(f)}`), ...files.filter(f => f.s === 'D' && !after.has(top(f))).map(f => `- ${top(f)}`)])];
  const status = !files.length ? 'fresh' : structural.length || files.length > MAP_SMALL ? 'stale' : 'changed';
  return { status, target, commit, date, ref: ref.slice(0, 12), fallback, total: files.length, files: files.slice(0, 40).map(f => `${f.s} ${f.path}`), structural: structural.slice(0, 20) };
}
/** What a step gets about the map: nothing when it is fresh or missing, else the changed files since its commit. */
function mapPromptNote(m) {
  if (!['changed', 'stale', 'unknown'].includes(m?.status)) return '';
  if (m.status === 'unknown') return '\n\n## Mapa do repositório sem referência\nNão foi possível achar o commit descrito em docs/squad/.reconhecimento na branch base. Confira a estrutura dos trechos do mapa que você usar antes de confiar neles.';
  return `\n\n## Mudanças no repositório desde o mapa (docs/squad)\nO mapa descreve o commit ${m.ref}${m.date ? ` (${m.date})` : ''}${m.fallback ? ', achado pela data porque o commit registrado saiu do histórico' : ''}. Desde então, ${m.total} arquivo${m.total > 1 ? 's mudaram' : ' mudou'} fora de docs/squad (A = novo, M = alterado, D = removido):\n${m.files.join('\n')}${m.total > m.files.length ? `\n(e mais ${m.total - m.files.length})` : ''}\nLeia desses arquivos só os que importam para a sua tarefa; o resto do mapa continua valendo.${m.status === 'stale' ? `\nO mapa está desatualizado${m.structural.length ? ` (mudanças estruturais: ${m.structural.slice(0, 8).join(', ')})` : ''}: confira a estrutura dos trechos que você usar e registre no relatório o que o mapa precisa corrigir.` : ''}`;
}

/** The commander's plan of a linked operation gets docs/squad/mapa.md from the base branch (or the clone, before the merge). */
async function mapForPlan(root, repo) {
  let target = baseRef(repo), text = await gitRun(['show', `${target}:docs/squad/mapa.md`], root).catch(() => '');
  if (!text) { target = 'HEAD'; text = await gitRun(['show', 'HEAD:docs/squad/mapa.md'], root).catch(() => ''); }
  if (!text) return '\n\n## Mapa do repositório\nAinda não há docs/squad/mapa.md: não indique arquivos.';
  const m = await mapStatus(root, target).catch(() => null);
  return `\n\n## Mapa do repositório (docs/squad/mapa.md)\n${text.length > 20000 ? text.slice(0, 20000) + '\n[...]' : text}${mapPromptNote(m)}`;
}

/* Merges. A linked operation's approved feature waits for its branch to reach the base branch before its dependents run. Merged =
 * the branch is in the base's history (merge commit, fast-forward) or, after a squash or rebase merge, every file the branch changed
 * is identical on the base. 'empty' = the branch has no commits since it started (startMark), so there is nothing to merge. */
const BRANCH_NAME_RE = /^squad\/[a-z0-9][a-z0-9-]{0,79}$/;
async function mergeState(root, branch, target) {
  if (!await gitOk(['rev-parse', '--verify', '-q', `refs/heads/${branch}^{commit}`], root)) return { exists: false, merged: false };
  const start = (() => { try { return fs.readFileSync(startMark(root, branch.slice(6)), 'utf8').trim(); } catch { return ''; } })();
  if (/^[0-9a-f]{40}$/.test(start) && (await gitRun(['rev-list', '--count', `${start}..${branch}`], root).catch(() => '1')) === '0') return { exists: true, merged: false, empty: true };
  if (await gitOk(['merge-base', '--is-ancestor', branch, target], root)) return { exists: true, merged: true, how: 'history' };
  const base = await gitRun(['merge-base', branch, target], root).catch(() => '');
  const changed = base ? (await gitRun(['diff', '--name-only', base, branch], root)).split('\n').filter(Boolean) : [];
  if (!changed.length || changed.length > 400) return { exists: true, merged: false };
  // Squash or rebase: some base commit after the fork point had every file the branch changed exactly as the branch has it. Looking
  // through those commits (newest first) still finds the merge after later commits changed the same files again.
  const commits = (await gitRun(['log', '--format=%H', '-n', '60', `${base}..${target}`, '--', ...changed], root, 30000).catch(() => '')).split('\n').filter(Boolean);
  for (const c of commits) if (await gitOk(['diff', '--quiet', c, branch, '--', ...changed], root)) return { exists: true, merged: true, how: 'content', at: c.slice(0, 12) };
  return { exists: true, merged: false };
}
/** Pull request page for GitHub origins (https or ssh); null for anything else, such as a local folder. */
function prUrl(origin, base, branch) {
  const m = String(origin).match(/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}/compare/${base ? `${base}...` : ''}${branch}?expand=1` : null;
}

/* After a successful feature step of a linked operation the bridge commits the worktree, so agents need neither git nor a shell. On map
 * features (mapRef: reconnaissance, map update) it first writes docs/squad/.reconhecimento with the base commit the worktree started
 * from and the date. The repository's own hooks run (no --no-verify): a refused commit is reported and the changes stay for the next step. */
async function commitStep(run) {
  const c = run.stepCommit;
  try {
    if (c.mapRef && fs.existsSync(path.join(c.dir, 'docs', 'squad'))) {
      let base = ''; try { base = fs.readFileSync(startMark(c.root, c.slug), 'utf8').trim(); } catch {}
      if (!/^[0-9a-f]{40}$/.test(base)) base = await gitRun(['merge-base', 'HEAD', baseRef(c.repo)], c.dir).catch(() => '');
      // Rewritten only when the reference changes, so a step with nothing new leaves no commit.
      const file = path.join(c.dir, MAP_FILE), cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (/^[0-9a-f]{40}$/.test(base) && !cur.startsWith(`commit=${base}\n`)) fs.writeFileSync(file, `commit=${base}\nbranch_base=${c.repo.baseBranch || 'HEAD'}\ndata=${new Date().toISOString()}\n`);
    }
    await gitRun(['add', '-A'], c.dir, 60000);
    if (await gitOk(['diff', '--cached', '--quiet'], c.dir)) return pushEvent(run, { type: 'bridge', subtype: 'commit', commit: null });
    const files = (await gitRun(['diff', '--cached', '--name-only'], c.dir)).split('\n').filter(Boolean);
    const who = await gitRun(['config', 'user.email'], c.dir).catch(() => '');
    await gitRun([...(who ? [] : ['-c', 'user.name=SQUAD/CODE', '-c', 'user.email=squad-code@localhost']), 'commit', '-q', '-m', `SQUAD/CODE: ${c.label || c.slug}`], c.dir, 120000);
    pushEvent(run, { type: 'bridge', subtype: 'commit', commit: await gitRun(['rev-parse', '--short', 'HEAD'], c.dir), files: files.slice(0, 60), total: files.length });
  } catch (e) { pushEvent(run, { type: 'bridge', subtype: 'commit', commit: null, error: e.message }); }
}

/* The operation's code standard (conventions option, feature steps of a linked operation), always the person's choice:
 * 'repo' = the repository's approved conventions prevail over the agent's guide; 'squad' = the agent's guide (the squad's DIRETRIZES) is
 * the target, and the approved conventions only describe where the code is today. Approved = docs/squad/convencoes.md on the base branch
 * (merged after review), never a draft from a worktree. */
async function conventionsNote(root, repo, mode) {
  const text = await gitRun(['show', `${baseRef(repo)}:docs/squad/convencoes.md`], root).catch(() => '');
  const body = text.length > 15000 ? text.slice(0, 15000) + '\n[...]' : text;
  if (mode === 'repo') return text
    ? `\n\n## Padrão de código desta operação: o do repositório\nA pessoa escolheu seguir o padrão que o código já tem. As convenções abaixo foram aprovadas pelo time (docs/squad/convencoes.md na branch base) e prevalecem sobre o guia de convenções das suas instruções: do guia, siga só o que não conflitar com elas e registre na entrega o que deixou de seguir por conflito.\n\n${body}`
    : '\n\n## Padrão de código desta operação: o do repositório\nA pessoa escolheu seguir o padrão que o código já tem, mas ainda não há convenções aprovadas (docs/squad/convencoes.md não está na branch base). Siga o padrão dos arquivos que tocar; o guia das suas instruções vale onde o código não mostrar um padrão.';
  return `\n\n## Padrão de código desta operação: as diretrizes da squad\nA pessoa escolheu levar o código, aos poucos, para o guia de convenções das suas instruções. Nesta operação o guia prevalece sobre o padrão existente, inclusive sobre a regra do guia de seguir o padrão do repositório. Aplique-o no que a tarefa tocar e não reescreva o que ela não pede.${text ? `\nComo o código está hoje, segundo as convenções aprovadas pelo time (só como contexto, para saber o que está migrando):\n\n${body}` : ''}`;
}

/** Folder of a project under PROJECTS_DIR; the name is a plain slug, so it cannot leave the root. */
function projectDir(name) {
  const folder = String(name || '').trim();
  if (!FOLDER_RE.test(folder) || RESERVED_RE.test(folder)) throw new Error(`Pasta de projeto inválida: ${folder.slice(0, 80)}`);
  return path.join(longPath(PROJECTS_DIR), folder);
}

const cmdQuote = s => /^[A-Za-z0-9_\-.:\\/=@,+]+$/.test(s) ? s : `"${String(s).replace(/"/g, '""')}"`;

/** Spawn an executable; .cmd/.bat on Windows must go through cmd.exe. Args are simple tokens only. */
function spawnBin(resolved, args, opts) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(resolved)) {
    const line = [resolved, ...args].map(cmdQuote).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  }
  if (/\.(mjs|cjs|js)$/i.test(resolved)) return spawn(process.execPath, [resolved, ...args], opts);
  return spawn(resolved, args, opts);
}

async function claudeVersion(bin) {
  const resolved = await resolveBin(bin);
  if (!resolved) return { resolved: null, version: null, error: `Executável "${bin}" não encontrado no PATH.` };
  if (versionCache.has(resolved)) return versionCache.get(resolved);
  const info = await new Promise(resolve => {
    const child = spawnBin(resolved, ['--version'], { windowsHide: true });
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ resolved, version: null, error: e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ resolved, version: out.trim().split(/\r?\n/)[0] || 'desconhecida', error: null });
      else resolve({ resolved, version: null, error: (err || out).trim().slice(0, 500) || `exit ${code}` });
    });
  });
  if (info.version) versionCache.set(resolved, info);
  return info;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (IS_WIN) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); } }
}

/* ---------- runs ---------- */
function activeCount() { return [...runs.values()].filter(r => r.status === 'running').length; }

function pushEvent(run, event) {
  run.events.push(event);
  if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of run.clients) res.write(line);
  persistEvent(run, event);
}

/* Run history (db.js): events go to the database in small batches. Partial text deltas are not kept (the console never shows
   them) and long tool outputs are cut; the exit event is always kept, past MAX_EVENTS too. */
function persistEvent(run, event) {
  if (!run.persist || event.type === 'stream_event') return;
  if (run.saved >= MAX_EVENTS && event.type !== 'exit') return;
  run.saved++;
  run.pending.push({ seq: run.saved, type: String(event.type || ''), data: JSON.stringify(storedEvent(event)) });
  if (event.type === 'exit') flushRun(run);
  else if (!run.flushTimer) run.flushTimer = setTimeout(() => flushRun(run), 200);
}
function flushRun(run) {
  clearTimeout(run.flushTimer); run.flushTimer = null;
  const batch = run.pending ? run.pending.splice(0) : [];
  if (!batch.length || !run.persist || !store) return;
  try { store.appendRunEvents(run.id, batch); }
  catch (e) { run.persist = false; console.warn(`Histórico da execução ${run.id} não gravado: ${e.message}`); }
}
function storedEvent(event) {
  if (event.type !== 'user' || !Array.isArray(event.message?.content)) return event;
  const cut = v => typeof v === 'string' && v.length > 4000 ? v.slice(0, 4000) + '…' : v;
  const block = b => b?.type !== 'tool_result' ? b : { ...b, content: Array.isArray(b.content) ? b.content.map(x => x?.type === 'text' ? { ...x, text: cut(x.text) } : x) : cut(b.content) };
  return { ...event, message: { ...event.message, content: event.message.content.map(block) } };
}

function validateRunOptions(o = {}) {
  const out = {};
  out.claudePath = typeof o.claudePath === 'string' && o.claudePath.trim() ? o.claudePath.trim() : DEFAULT_BIN;
  if (typeof o.project === 'string' && o.project.trim()) {
    const dir = projectDir(o.project);
    fs.mkdirSync(dir, { recursive: true });
    out.cwd = longPath(dir); out.projectRun = true;
  } else if (typeof o.cwd === 'string' && o.cwd.trim()) {
    // Explicit folder (tests, direct API use). Never an implicit one: process.cwd() is usually this app's own folder.
    const cwd = path.resolve(o.cwd.trim());
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Diretório de trabalho inexistente: ${cwd}`);
    out.cwd = longPath(cwd);
  } else throw new Error('Execução sem pasta de projeto: informe a pasta da operação (opção "project", em projects/).');
  if (o.model) { if (!MODEL_RE.test(o.model)) throw new Error('Modelo inválido.'); out.model = o.model; }
  if (o.permissionMode) { if (!PERMISSION_MODES.includes(o.permissionMode)) throw new Error('Modo de permissão inválido.'); out.permissionMode = o.permissionMode; }
  if (o.effort) { if (!EFFORTS.includes(o.effort)) throw new Error('Nível de esforço inválido.'); out.effort = o.effort; }
  if (o.maxBudgetUsd !== undefined && o.maxBudgetUsd !== '' && o.maxBudgetUsd !== null) {
    const n = Number(o.maxBudgetUsd); if (!Number.isFinite(n) || n <= 0 || n > 1000) throw new Error('Orçamento máximo inválido.'); out.maxBudgetUsd = String(n);
  }
  const tools = list => (Array.isArray(list) ? list : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 60);
  out.allowedTools = tools(o.allowedTools); out.disallowedTools = tools(o.disallowedTools);
  for (const t of [...out.allowedTools, ...out.disallowedTools]) if (!TOOL_RE.test(t)) throw new Error(`Ferramenta inválida: ${t}`);
  // Optional hard restriction of the built-in tool set (maps to --tools). null = Claude Code defaults.
  out.tools = Array.isArray(o.tools) ? tools(o.tools) : null;
  if (out.tools) for (const t of out.tools) if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(t)) throw new Error(`Ferramenta inválida: ${t}`);
  // Linked operation: its folder is a clone of a registered repository. Pushes stay with the person (review, PR).
  if (typeof o.repo === 'string' && o.repo.trim()) {
    if (!out.projectRun) throw new Error('O repositório vinculado vale só para a pasta de uma operação (opção "project").');
    const repo = loadRepos().repos.find(r => r.id === o.repo.trim());
    if (!repo) throw new Error(`Repositório não cadastrado: ${o.repo.trim().slice(0, 80)}. Cadastre-o em ${REPOS_FILE}.`);
    out.repo = repo;
    out.disallowedTools = [...new Set([...out.disallowedTools, 'Bash(git push:*)'])];
    // A feature step works in that feature's worktree (ensureWorktree); plans and chats stay in the clone.
    out.withMap = o.withMap === true;
    // Feature steps: map features get .reconhecimento from the bridge; the others, the operation's code standard.
    out.mapRef = o.mapRef === true;
    out.conventions = ['repo', 'squad'].includes(o.conventions) ? o.conventions : '';
    for (const k of ['feature', 'featureBase']) {
      if (o[k] === undefined || o[k] === null || o[k] === '') continue;
      if (typeof o[k] !== 'string' || !FOLDER_RE.test(o[k])) throw new Error(`Identificador de feature inválido: ${String(o[k]).slice(0, 80)}`);
      out[k] = o[k];
    }
  } else if (o.feature) throw new Error('O worktree por feature vale só para operações com repositório vinculado.');
  out.addDirs = (Array.isArray(o.addDirs) ? o.addDirs : []).map(String).map(s => s.trim()).filter(Boolean).slice(0, 10).map(d => path.resolve(d));
  out.addDirs = out.addDirs.map(d => fs.existsSync(d) ? longPath(d) : d);
  for (const d of out.addDirs) if (!fs.existsSync(d)) throw new Error(`Diretório adicional inexistente: ${d}`);
  // Streams text deltas as `stream_event` lines (chat bubbles grow while the model writes).
  out.partial = o.partial === true;
  // Squad colleagues the agent may call with the Agent tool (--agents file) and their text in the stream (--forward-subagent-text).
  out.agents = validateAgents(o.agents);
  out.forwardSubagents = o.forwardSubagents === true;
  const timeout = Number(o.timeoutSec); out.timeoutSec = Number.isFinite(timeout) && timeout >= 10 && timeout <= 7200 ? timeout : 900;
  return out;
}

/** CLI-defined subagents: whitelisted fields only, bounded sizes. null = none. */
function validateAgents(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Agentes inválidos.');
  const entries = Object.entries(value);
  if (entries.length > 20) throw new Error('Até 20 agentes por execução.');
  const out = {};
  for (const [key, def] of entries) {
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(key)) throw new Error(`Identificador de agente inválido: ${key.slice(0, 60)}`);
    if (!def || typeof def !== 'object' || Array.isArray(def)) throw new Error(`Definição inválida do agente ${key}.`);
    const description = typeof def.description === 'string' ? def.description.trim() : '';
    if (!description || description.length > 1000) throw new Error(`Descrição inválida do agente ${key}.`);
    const agent = { description, prompt: typeof def.prompt === 'string' ? def.prompt.slice(0, 60000) : '' };
    if (def.tools !== undefined) {
      if (!Array.isArray(def.tools) || def.tools.length > 30 || !def.tools.every(t => typeof t === 'string' && /^[A-Za-z][A-Za-z0-9_]*$/.test(t))) throw new Error(`Ferramentas inválidas do agente ${key}.`);
      agent.tools = def.tools;
    }
    if (def.model) { if (!MODEL_RE.test(def.model)) throw new Error(`Modelo inválido do agente ${key}.`); agent.model = def.model; }
    if (def.effort) { if (!EFFORTS.includes(def.effort)) throw new Error(`Esforço inválido do agente ${key}.`); agent.effort = def.effort; }
    out[key] = agent;
  }
  if (JSON.stringify(out).length > 400000) throw new Error('Definição dos agentes muito grande.');
  return entries.length ? out : null;
}

async function startRun(body) {
  const prompt = typeof body.prompt === 'string' ? body.prompt : '';
  if (!prompt.trim()) throw new Error('Prompt vazio.');
  if (prompt.length > 400000) throw new Error('Prompt muito grande.');
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.slice(0, 100000) : '';
  const opts = validateRunOptions(body.options);
  if (activeCount() >= maxConcurrent) throw Object.assign(new Error(`Limite de ${maxConcurrent} execuções simultâneas atingido.`), { status: 429 });
  const resolved = await resolveBin(opts.claudePath);
  if (!resolved) throw new Error(`Claude Code não encontrado ("${opts.claudePath}"). Ajuste o caminho nas configurações.`);
  // Linked operation: whether its folder can be used is checked now (a refusal answers the request); the clone, the feature's
  // worktree and its prepare command run after the answer, as the run's preparing phase (prepareRun).
  let prep = null;
  if (opts.repo) {
    prep = { root: opts.cwd, clone: await checkProjectClone(opts.cwd, opts.repo), feature: opts.feature || null, base: opts.featureBase && opts.featureBase !== opts.feature ? opts.featureBase : null };
    if (prep.feature) opts.cwd = path.join(prep.root, WT_DIR, prep.feature);
  } else if (opts.projectRun) await ensureProjectRepo(opts.cwd);

  const id = crypto.randomUUID();
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-prompts', 'none'];
  let sysFile = null, settingsFile = null, agentsFile = null;
  // OS temp cleanup can remove the (usually empty) folder while the bridge keeps running.
  if (systemPrompt.trim() || opts.projectRun || opts.agents) await fsp.mkdir(TMP_DIR, { recursive: true });
  if (systemPrompt.trim()) {
    sysFile = path.join(TMP_DIR, `${id}.system.md`);
    await fsp.writeFile(sysFile, systemPrompt, 'utf8');
    args.push('--append-system-prompt-file', sysFile);
  }
  if (opts.projectRun) {
    settingsFile = path.join(TMP_DIR, `${id}.settings.json`);
    // The file tools also refuse reads outside the project folder (and --add-dir), so agents never take this app or the
    // person's other folders for the project.
    // In a worktree, the clone above it would add its own (base branch) CLAUDE.md files to the worktree's.
    const excludes = prep?.feature ? [...APP_MEMORY_EXCLUDES, ...MEMORY_FILES.map(f => `${prep.root.replace(/\\/g, '/')}/${f}`)] : APP_MEMORY_EXCLUDES;
    await fsp.writeFile(settingsFile, JSON.stringify({ claudeMdExcludes: excludes, permissions: { blockReadsOutsideWorkingDirectories: true } }), 'utf8');
    args.push('--settings', settingsFile);
  }
  if (opts.agents) {
    agentsFile = path.join(TMP_DIR, `${id}.agents.json`);
    await fsp.writeFile(agentsFile, JSON.stringify(opts.agents), 'utf8');
    args.push('--agents', agentsFile);
  }
  if (opts.forwardSubagents) args.push('--forward-subagent-text');
  if (opts.model) args.push('--model', opts.model);
  if (opts.permissionMode) args.push('--permission-mode', opts.permissionMode);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.maxBudgetUsd) args.push('--max-budget-usd', opts.maxBudgetUsd);
  if (opts.tools) args.push('--tools', opts.tools.length ? opts.tools.join(',') : '');
  if (opts.allowedTools.length) args.push('--allowedTools', opts.allowedTools.join(','));
  if (opts.disallowedTools.length) args.push('--disallowedTools', opts.disallowedTools.join(','));
  for (const d of opts.addDirs) args.push('--add-dir', d);
  if (opts.partial) args.push('--include-partial-messages');

  // A preparing run already counts as running (concurrency, cancel); its child is the current git or prepare process (prepChild).
  const run = {
    id, status: 'running', phase: prep ? 'preparing' : 'running', startedAt: new Date().toISOString(), endedAt: null, label: String(body.label || '').slice(0, 200),
    cwd: opts.cwd, args: args.map(a => a === sysFile ? '<system-prompt-file>' : a === settingsFile ? '<settings-file>' : a === agentsFile ? '<agents-file>' : a), child: null, prepChild: null, events: [], clients: new Set(),
    result: null, sysFile, settingsFile, agentsFile, timer: null, cancelled: false,
    // History: who ran it and where (body.meta, whitelisted in db.js), saved events count and the batch waiting to be written.
    // Without a database yet (direct API use before the setup), the run still works but stays out of the history.
    meta: dbModule.runMeta(body.meta), project: typeof body.options?.project === 'string' ? body.options.project.slice(0, 80) : '', persist: !!store, saved: 0, pending: [], flushTimer: null,
  };
  runs.set(id, run);
  if (run.persist) try { store.insertRun(run); } catch (e) { run.persist = false; console.warn(`Histórico da execução ${id} não gravado: ${e.message}`); }
  if (!prep) launchRun(run, resolved, args, opts, prompt);
  else prepareRun(run, opts, prep).then(ok => { if (ok && !run.cancelled) launchRun(run, resolved, args, opts, prompt); else endRun(run); });
  return run;
}

/* The preparing phase of a linked operation's run: clone, worktree and prepare, each reported as a bridge/prepare event and the
 * prepare output as bridge/prepare-log, so the page shows them live and can cancel them. A failed step ends the run as an error:
 * the agent never starts in a folder that is not ready. */
async function prepareRun(run, opts, prep) {
  const say = (step, text) => pushEvent(run, { type: 'bridge', subtype: 'prepare', step, text });
  const track = child => { run.prepChild = child; };
  try {
    if (prep.clone !== 'ready') { say('clone', `Clonando o repositório ${opts.repo.name}.`); await cloneProject(prep.root, opts.repo, prep.clone, track); }
    await guardClone(prep.root);
    // The commander plans with the map (and what changed since it), so it can point each colleague to real paths.
    if (opts.withMap && !run.cancelled) run.promptExtra = await mapForPlan(prep.root, opts.repo).catch(() => '');
    if (run.cancelled || !prep.feature) return !run.cancelled;
    const wt = await ensureWorktree(prep.root, opts.repo, prep.feature, prep.base, track, say);
    if (run.cancelled) return false;
    let prepared = null;
    if (opts.repo.prepare && !fs.existsSync(preparedMark(prep.root, prep.feature))) {
      say('prepare', `Preparando o worktree: ${opts.repo.prepare}`);
      const r = await prepareWorktree(prep.root, wt.dir, opts.repo, prep.feature, track, text => pushEvent(run, { type: 'bridge', subtype: 'prepare-log', text }));
      if (run.cancelled) return false;
      if (!r.ok) throw new Error(r.text);
      prepared = r.text;
    }
    pushEvent(run, { type: 'bridge', subtype: 'worktree', feature: prep.feature, branch: wt.branch, created: wt.created, notes: wt.notes, prepare: prepared });
    // What changed since the map, from git: on the base branch, or in the worktree while the map is not merged yet. The step's
    // prompt gets the list, so the agent reads those files instead of scanning the repository.
    try {
      let m = await mapStatus(prep.root, baseRef(opts.repo));
      if (m.status === 'missing') m = await mapStatus(wt.dir, 'HEAD');
      pushEvent(run, { type: 'bridge', subtype: 'map', ...m });
      run.promptExtra = mapPromptNote(m);
    } catch (e) { pushEvent(run, { type: 'bridge', subtype: 'map', status: 'error', error: e.message }); }
    if (opts.conventions && !opts.mapRef) run.promptExtra = (run.promptExtra || '') + await conventionsNote(prep.root, opts.repo, opts.conventions);
    run.stepCommit = { dir: wt.dir, root: prep.root, slug: prep.feature, repo: opts.repo, mapRef: opts.mapRef, label: run.label };
    return true;
  } catch (e) {
    if (!run.cancelled) endRun(run, { isError: true, error: e.message });
    return false;
  } finally { run.prepChild = null; }
}

function launchRun(run, resolved, args, opts, prompt) {
  run.phase = 'running';
  const child = spawnBin(resolved, args, {
    cwd: opts.cwd, windowsHide: true, detached: !IS_WIN,
    // With squad colleagues, calls run in the foreground: the Agent tool result is the colleague's answer, not a launch notice.
    // Project runs: git stops at PROJECTS_DIR (see ensureProjectRepo), even when the folder's own .git is missing.
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT || 'squad-code-bridge', ...(opts.agents ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } : {}), ...(opts.projectRun ? { GIT_CEILING_DIRECTORIES: gitCeiling() } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  run.child = child;
  pushEvent(run, { type: 'bridge', subtype: 'spawned', pid: child.pid, cwd: opts.cwd, args: run.args, at: new Date().toISOString() });

  run.timer = setTimeout(() => { run.timedOut = true; pushEvent(run, { type: 'bridge', subtype: 'timeout', timeoutSec: opts.timeoutSec }); killTree(child); }, opts.timeoutSec * 1000);

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let evt; try { evt = JSON.parse(line); } catch { evt = { type: 'raw', text: line.slice(0, 4000) }; }
      if (evt.type === 'result') run.result = evt;
      pushEvent(run, evt);
    }
  });
  let stderrTail = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-4000); pushEvent(run, { type: 'stderr', text: chunk.slice(0, 4000) }); });
  child.on('error', err => { stderrTail += err.message; });
  child.on('close', code => {
    clearTimeout(run.timer);
    if (buffer.trim()) { try { const evt = JSON.parse(buffer); if (evt.type === 'result') run.result = evt; pushEvent(run, evt); } catch { pushEvent(run, { type: 'raw', text: buffer.slice(0, 4000) }); } }
    const r = run.result || {}, end = () => endRun(run, { code, isError: code !== 0 || !!r.is_error, error: (r.is_error && r.result) || stderrTail.trim().slice(-1500) || `claude saiu com código ${code}` });
    // A successful step of a linked operation's feature is committed by the bridge before the run ends.
    if (run.stepCommit && code === 0 && !r.is_error && !run.cancelled && !run.timedOut) commitStep(run).finally(end); else end();
  });

  child.stdin.on('error', () => {});
  child.stdin.end(prompt + (run.promptExtra || ''), 'utf8');
}

/** Ends a run once: exit event, history, subscribers and temp files. Also for runs that end while preparing (error or cancel). */
function endRun(run, { code = null, isError = false, error = '' } = {}) {
  if (run.status !== 'running') return;
  clearTimeout(run.timer);
  const r = run.result || {};
  isError = run.cancelled || run.timedOut || isError;
  run.status = run.cancelled ? 'cancelled' : run.timedOut ? 'timeout' : isError ? 'error' : 'done';
  run.endedAt = new Date().toISOString();
  const exit = {
    type: 'exit', status: run.status, code, isError,
    result: typeof r.result === 'string' ? r.result : '',
    costUsd: r.total_cost_usd ?? r.cost_usd ?? null, durationMs: r.duration_ms ?? null,
    numTurns: r.num_turns ?? null, sessionId: r.session_id ?? null,
    error: isError ? (run.cancelled ? 'Execução cancelada pelo operador.' : run.timedOut ? 'Tempo limite excedido.' : error || `claude saiu com código ${code}`) : null,
  };
  pushEvent(run, exit);
  if (run.persist) try { store.finishRun(run, exit); } catch (e) { console.warn(`Histórico da execução ${run.id} não finalizado: ${e.message}`); }
  for (const res of run.clients) res.end();
  run.clients.clear();
  for (const file of [run.sysFile, run.settingsFile, run.agentsFile]) if (file) fsp.rm(file, { force: true }).catch(() => {});
  run.child = null;
  // Keep finished runs for 30 minutes so late subscribers can replay.
  setTimeout(() => runs.delete(run.id), 30 * 60 * 1000).unref();
}

function runSummary(r) {
  return { id: r.id, status: r.status, phase: r.phase, label: r.label, ...r.meta, project: r.project, startedAt: r.startedAt, endedAt: r.endedAt, cwd: r.cwd, events: r.events.length };
}

/* ---------- settings.json ---------- */
// A project folder (`project`) may not exist yet: it is created by its first run or by the first save here.
function settingsPath(scope, cwd, project) {
  if (scope === 'user') return path.join(HOME, '.claude', 'settings.json');
  if (scope === 'project' || scope === 'local') {
    let base;
    if (project && project.trim()) base = projectDir(project);
    else {
      base = cwd && cwd.trim() ? path.resolve(cwd.trim()) : process.cwd();
      if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) throw new Error(`Diretório do projeto inexistente: ${base}`);
    }
    return path.join(base, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');
  }
  throw new Error('Escopo inválido. Use user, project ou local.');
}

async function readSettings(scope, cwd, project) {
  const file = settingsPath(scope, cwd, project);
  try { const text = await fsp.readFile(file, 'utf8'); return { ok: true, scope, path: file, exists: true, text }; }
  catch (e) { if (e.code === 'ENOENT') return { ok: true, scope, path: file, exists: false, text: '{\n}\n' }; throw e; }
}

async function writeSettings(scope, cwd, project, text) {
  if (typeof text !== 'string') throw new Error('Conteúdo ausente.');
  let parsed; try { parsed = JSON.parse(text); } catch (e) { throw new Error('JSON inválido: ' + e.message); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('settings.json deve ser um objeto JSON.');
  const file = settingsPath(scope, cwd, project);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) { backup = file + '.bak'; await fsp.copyFile(file, backup); }
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
  return { ok: true, scope, path: file, backup };
}

/* ---------- page data tags ---------- */
// The page boots from these (no request, no flash of the browser copy): JSON with every `<` escaped.
const jsonTag = (id, data) => `<script type="application/json" id="${id}">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
// `setup`: no database or no workspace in it yet, so the page asks how to start (POST /api/setup) before anything else.
function workspaceTag() {
  let info;
  try { info = store ? store.readWorkspace() : { rev: '', savedAt: '', workspace: null }; } catch (e) { info = { rev: '', savedAt: '', workspace: null, error: e.message }; }
  return jsonTag('squad-disk', { rev: info.rev, savedAt: info.savedAt, path: store?.file || DB_FILE, workspace: info.workspace, error: info.error || '', setup: !info.error && !info.workspace && setupNeeded() });
}
// Operation rooms (the last 200 messages of each project) and chats; orphans are swept first.
function memoryTag() {
  if (!store) return jsonTag('squad-memory', { rooms: {}, chats: {} });
  try { store.sweep(); return jsonTag('squad-memory', { rooms: store.loadRooms(200), chats: store.loadChats() }); }
  catch (e) { console.warn(`Sala e conversas não carregadas: ${e.message}`); return jsonTag('squad-memory', { rooms: {}, chats: {} }); }
}

/* ---------- http ---------- */
async function serveIndex(res) {
  const file = path.join(ROOT, 'index.html');
  let html;
  try { html = await fsp.readFile(file, 'utf8'); }
  catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // index.html is built from src/; a clone without it gets the way to build it instead of a bare error.
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end('<!doctype html><meta charset="utf-8"><title>SQUAD/CODE</title><body style="font:15px/1.7 system-ui,sans-serif;background:#05080a;color:#d8e1e5;padding:48px;max-width:640px">'
      + '<h1 style="font-weight:500">index.html não encontrado</h1><p>A interface é gerada a partir de <code>src/</code>. Na pasta do SQUAD/CODE, rode <code>npm run dev</code> (gera e inicia o bridge) ou <code>python build.py</code> e recarregue esta página.</p></body>');
  }
  const tags = workspaceTag() + '\n' + memoryTag(); // a function replacement: the data may contain `$&` and similar patterns
  html = html.replace('<head>', () => `<head>\n<meta name="squad-bridge-token" content="${TOKEN}">\n${tags}`);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(html);
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (!allowedHost(req.headers.host)) return fail(res, 421, 'Host não permitido.');
  if (!allowedOrigin(req.headers.origin)) return fail(res, 403, 'Origem não permitida.');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveIndex(res);
  if (!url.pathname.startsWith('/api/')) return fail(res, 404, 'Não encontrado.');
  if (!tokenOk(req, url)) return fail(res, 401, 'Token do bridge inválido. Recarregue a página servida pelo bridge.');

  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const bin = url.searchParams.get('claudePath') || DEFAULT_BIN;
      const info = await claudeVersion(bin);
      return json(res, 200, { ok: true, bridge: 'squad-code', claudeVersion: info.version, claudePath: info.resolved, claudeError: info.error, defaultCwd: process.cwd(), projectsDir: longPath(PROJECTS_DIR), home: HOME, platform: process.platform, activeRuns: activeCount(), maxConcurrent, dbReady: !setupNeeded(), dbPath: store?.file || DB_FILE, repos: publicRepos() });
    }
    // First start: the page creates the database with the workspace the person chose (from scratch, the example, a backup or the
    // browser's copy). Validated before anything is written; refused once a workspace exists.
    if (req.method === 'POST' && url.pathname === '/api/setup') {
      const body = await readBody(req, MAX_WORKSPACE);
      if (!setupNeeded()) return json(res, 409, { ok: false, conflict: true, path: store.file, error: 'Já existe um banco de dados com um workspace. Recarregue a página.' });
      dbModule.checkWorkspace(body);
      if (!store) openDb();
      const saved = store.syncWorkspace(body, '', false);
      console.log(`Banco de dados criado: ${store.file}`);
      return json(res, 201, saved);
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const n = Number(body.concurrency);
      if (Number.isInteger(n) && n >= 1 && n <= 8) maxConcurrent = n;
      return json(res, 200, { ok: true, maxConcurrent });
    }
    // Map freshness of a linked operation: GET /api/map/<project folder>?repo=<id>[&fetch=1] ('no-clone' before its first run).
    if (parts[1] === 'map' && req.method === 'GET' && parts.length === 3) {
      const repo = loadRepos().repos.find(r => r.id === url.searchParams.get('repo'));
      if (!repo) return fail(res, 400, 'Repositório não cadastrado.');
      const root = projectDir(parts[2]);
      if (!fs.existsSync(path.join(root, '.git'))) return json(res, 200, { ok: true, status: 'no-clone' });
      const dir = longPath(root);
      const fetched = url.searchParams.get('fetch') === '1' ? await gitRun(['fetch', '-q', 'origin'], dir, 300000).then(() => true, e => e.message) : null;
      // branches=squad/a,squad/b: whether each approved feature branch reached the base branch.
      const branches = (url.searchParams.get('branches') || '').split(',').filter(Boolean).slice(0, 60);
      if (branches.some(b => !BRANCH_NAME_RE.test(b))) return fail(res, 400, 'Branch inválida.');
      const merges = {};
      for (const b of branches) merges[b] = await mergeState(dir, b, baseRef(repo));
      return json(res, 200, { ok: true, fetched, ...await mapStatus(dir, baseRef(repo)), merges });
    }
    // Paths the commander suggested in a plan, checked on the base branch before the person approves it:
    // POST /api/paths/<folder> {repo, paths}. checked:false before the first clone.
    if (parts[1] === 'paths' && req.method === 'POST' && parts.length === 3) {
      const body = await readBody(req), repo = loadRepos().repos.find(r => r.id === body.repo);
      if (!repo) return fail(res, 400, 'Repositório não cadastrado.');
      const paths = (Array.isArray(body.paths) ? body.paths : []).slice(0, 200).map(x => String(x || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').slice(0, 300));
      const root = projectDir(parts[2]);
      if (!fs.existsSync(path.join(root, '.git'))) return json(res, 200, { ok: true, checked: false, exists: {} });
      const dir = longPath(root);
      let target = baseRef(repo);
      if (!await gitOk(['rev-parse', '--verify', '-q', `${target}^{commit}`], dir)) target = 'HEAD';
      const exists = {};
      for (const p of paths) exists[p] = !!p && !p.startsWith('/') && !p.includes(':') && !/(^|\/)\.\.(\/|$)/.test(p) && await gitOk(['cat-file', '-e', `${target}:${p}`], dir);
      return json(res, 200, { ok: true, checked: true, target, exists });
    }
    // Export of a linked operation into a new branch of its clone, for the team to review as a pull request:
    // POST /api/export/<folder> {repo, operation, files:[{name, data}]}. Only the squad's own places are written (docs/squad,
    // .claude/agents/squad-*, .claude/commands/squad-*), the map files stay with the agents, and CLAUDE.md is written only when the
    // repository has none. A branch with nothing new is dropped.
    if (parts[1] === 'export' && req.method === 'POST' && parts.length === 3) {
      const body = await readBody(req, 16 * 1024 * 1024), repo = loadRepos().repos.find(r => r.id === body.repo);
      if (!repo) return fail(res, 400, 'Repositório não cadastrado.');
      const root = projectDir(parts[2]);
      if (!fs.existsSync(path.join(root, '.git'))) return fail(res, 404, 'A operação ainda não tem clone: rode a F00 antes de exportar para o repositório.');
      const dir = longPath(root), slug = `exportacao-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
      await guardClone(dir);
      const wt = await ensureWorktree(dir, repo, slug, null, undefined, () => {});
      const OWN = /^(docs\/squad\/|\.claude\/agents\/squad-[^/]+$|\.claude\/commands\/squad-[^/]+$)/, MAP = /^docs\/squad\/(mapa\.md|arquitetura\.md|convencoes\.md|comandos\.md|\.reconhecimento)$/;
      const written = [], unchanged = [], skipped = [];
      let claudeMd = null;
      try {
        for (const f of (Array.isArray(body.files) ? body.files : []).slice(0, 3000)) {
          const name = String(f?.name || ''), data = typeof f?.data === 'string' ? f.data : '';
          const safe = name && !name.startsWith('/') && !/[\\:]/.test(name) && !/(^|\/)\.\.?(\/|$)/.test(name);
          const file = safe && path.join(wt.dir, name);
          if (name === 'CLAUDE.md') { if (fs.existsSync(file)) { claudeMd = 'exists'; continue; } claudeMd = 'created'; }
          else if (!safe || !OWN.test(name) || MAP.test(name)) { skipped.push(name.slice(0, 200)); continue; }
          // Line endings do not count (a Windows checkout may have CRLF where the export has LF).
          if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === data.replace(/\r\n/g, '\n')) { unchanged.push(name); continue; }
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, data, 'utf8');
          written.push(name);
        }
        let commit = null;
        if (written.length) {
          const spec = ['docs/squad', '.claude/agents', '.claude/commands', 'CLAUDE.md'].filter(x => fs.existsSync(path.join(wt.dir, x)));
          await gitRun(['add', '-A', '--', ...spec], wt.dir, 60000);
          // Nothing staged after all (git normalized the files back): nothing new, no branch.
          if (await gitOk(['diff', '--cached', '--quiet'], wt.dir)) unchanged.push(...written.splice(0));
          else {
            const who = await gitRun(['config', 'user.email'], wt.dir).catch(() => '');
            await gitRun([...(who ? [] : ['-c', 'user.name=SQUAD/CODE', '-c', 'user.email=squad-code@localhost']), 'commit', '-q', '-m', `SQUAD/CODE: exportação da operação ${String(body.operation || '').slice(0, 80)}`.trim()], wt.dir, 60000);
            commit = await gitRun(['rev-parse', '--short', 'HEAD'], wt.dir);
          }
        }
        await removeWorktree(dir, slug).catch(() => {});
        if (!commit) await gitRun(['branch', '-D', wt.branch], dir).catch(() => {});
        return json(res, 200, { ok: true, branch: commit ? wt.branch : null, commit, written, unchanged, skipped, claudeMd });
      } catch (e) {
        await removeWorktree(dir, slug).catch(() => {});
        throw e;
      }
    }
    // The person sends an approved feature's branch to the clone's origin (agents never push): POST /api/branches/<folder>/push
    // {repo, branch}. GitHub origins get the pull request link.
    if (parts[1] === 'branches' && parts[3] === 'push' && req.method === 'POST' && parts.length === 4) {
      const body = await readBody(req), repo = loadRepos().repos.find(r => r.id === body.repo);
      if (!repo) return fail(res, 400, 'Repositório não cadastrado.');
      if (!BRANCH_NAME_RE.test(String(body.branch || ''))) return fail(res, 400, 'Branch inválida.');
      const root = projectDir(parts[2]);
      if (!fs.existsSync(path.join(root, '.git'))) return fail(res, 404, 'A operação ainda não tem clone.');
      const dir = longPath(root);
      if (!await gitOk(['rev-parse', '--verify', '-q', `refs/heads/${body.branch}`], dir)) return fail(res, 404, `A branch ${body.branch} não existe no clone.`);
      // The origin's push URL is disabled for the agents (guardClone): the bridge pushes to the fetch URL, with its mark.
      const origin = await gitRun(['config', '--get', 'remote.origin.url'], dir).catch(() => '');
      if (!origin) return fail(res, 409, 'O clone não tem origem.');
      try { await gitRun(['push', '-q', origin, `refs/heads/${body.branch}:refs/heads/${body.branch}`], dir, 180000, null, { SQUAD_BRIDGE_PUSH: '1' }); }
      catch (e) { return fail(res, 502, `git push falhou: ${e.message}`); }
      return json(res, 200, { ok: true, branch: body.branch, pr: prUrl(origin, repo.baseBranch, body.branch), local: !REPO_URL_RE.test(origin) });
    }
    // Approved feature of a linked operation: DELETE /api/worktrees/<project folder>/<feature>.
    if (parts[1] === 'worktrees' && req.method === 'DELETE' && parts.length === 4) {
      if (!FOLDER_RE.test(parts[3])) return fail(res, 400, 'Identificador de feature inválido.');
      const root = projectDir(parts[2]);
      if (!fs.existsSync(path.join(root, '.git'))) return json(res, 200, { ok: true, removed: false });
      return json(res, 200, { ok: true, ...await removeWorktree(longPath(root), parts[3]) });
    }
    if (url.pathname === '/api/runs' && req.method === 'GET') {
      // The history comes from the database; runs still in memory report their current status.
      if (!store) return json(res, 200, { ok: true, runs: [] });
      const list = store.listRuns({ projectId: url.searchParams.get('projectId') || '', limit: url.searchParams.get('limit') });
      return json(res, 200, { ok: true, runs: list.map(r => runs.has(r.id) ? { ...r, status: runs.get(r.id).status } : r) });
    }
    if (url.pathname === '/api/runs' && req.method === 'POST') {
      const run = await startRun(await readBody(req));
      return json(res, 201, { ok: true, runId: run.id, args: run.args, cwd: run.cwd });
    }
    if (parts[1] === 'runs' && parts[2]) {
      const run = runs.get(parts[2]);
      if (!run) {
        // Older runs (and those from before a restart) are replayed from the history.
        const saved = store?.getRun(parts[2]);
        if (!saved) return fail(res, 404, 'Execução não encontrada.');
        if (req.method === 'GET' && parts[3] === 'events') {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
          res.write(': connected\n\n');
          for (const evt of store.runEvents(parts[2])) res.write(`data: ${JSON.stringify(evt)}\n\n`);
          return res.end();
        }
        if (req.method === 'POST' && parts[3] === 'cancel') return json(res, 200, { ok: true, status: saved.run.status });
        if (req.method === 'GET' && !parts[3]) return json(res, 200, { ok: true, ...saved });
        return fail(res, 404, 'Rota não encontrada.');
      }
      if (req.method === 'GET' && parts[3] === 'events') {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        for (const evt of run.events) res.write(`data: ${JSON.stringify(evt)}\n\n`);
        if (run.status !== 'running') return res.end();
        run.clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => { clearInterval(ping); run.clients.delete(res); });
        return;
      }
      if (req.method === 'POST' && parts[3] === 'cancel') {
        if (run.status === 'running') { run.cancelled = true; pushEvent(run, { type: 'bridge', subtype: 'cancel' }); killTree(run.child || run.prepChild); }
        return json(res, 200, { ok: true, status: run.status });
      }
      if (req.method === 'GET' && !parts[3]) return json(res, 200, { ok: true, run: runSummary(run), result: run.result });
    }
    if (url.pathname === '/api/workspace') {
      // ?meta=1: a tab checking whether the saved workspace moved on, without the workspace itself.
      if (req.method === 'GET') {
        const withWorkspace = url.searchParams.get('meta') !== '1';
        if (!store) return json(res, 200, { ok: true, exists: false, rev: '', savedAt: '', path: DB_FILE, ...(withWorkspace ? { workspace: null } : {}) });
        return json(res, 200, { ok: true, ...store.readWorkspace(withWorkspace) });
      }
      if (req.method === 'PUT') {
        // The first workspace only comes through /api/setup, chosen by the person.
        if (setupNeeded()) return fail(res, 503, 'Nenhum banco de dados ainda. Crie um na tela inicial do SQUAD/CODE.');
        const saved = store.syncWorkspace(await readBody(req, MAX_WORKSPACE), url.searchParams.get('base') || '', url.searchParams.get('force') === '1');
        return json(res, saved.conflict ? 409 : 200, saved);
      }
    }
    // A browser copy that lost to the saved version (or a stale page's last state) becomes a version, never discarded.
    if (url.pathname === '/api/workspace/backups' && req.method === 'POST') return json(res, 201, { ok: true, id: needStore().backupWorkspace(await readBody(req, MAX_WORKSPACE)) });
    if (url.pathname === '/api/workspace/snapshots' && req.method === 'GET') return json(res, 200, { ok: true, snapshots: needStore().listSnapshots() });
    if (parts[1] === 'workspace' && parts[2] === 'snapshots' && parts[3] && !parts[4] && req.method === 'GET') {
      const workspace = needStore().getSnapshot(parts[3]);
      return workspace ? json(res, 200, { ok: true, workspace }) : fail(res, 404, 'Versão não encontrada.');
    }
    // Operation room: incremental {seq, upserts, removes}; also sent with sendBeacon (?token=) when the page closes.
    if (parts[1] === 'rooms' && parts[2] && !parts[3] && req.method === 'POST') return json(res, 200, needStore().saveRoom(decodeURIComponent(parts[2]), await readBody(req, MAX_WORKSPACE)));
    if (parts[1] === 'chats' && parts[2] && parts[3] && !parts[4]) {
      const key = decodeURIComponent(parts[3]);
      if (req.method === 'PUT' || req.method === 'POST') return json(res, 200, needStore().saveChat(parts[2], key, await readBody(req, MAX_WORKSPACE)));
      if (req.method === 'DELETE') return json(res, 200, needStore().deleteChat(parts[2], key));
    }
    if (url.pathname === '/api/claude/settings') {
      const scope = url.searchParams.get('scope') || 'user';
      const cwd = url.searchParams.get('cwd') || '', project = url.searchParams.get('project') || '';
      if (req.method === 'GET') return json(res, 200, await readSettings(scope, cwd, project));
      if (req.method === 'PUT') { const body = await readBody(req); return json(res, 200, await writeSettings(scope, cwd, project, body.text)); }
    }
    return fail(res, 404, 'Rota não encontrada.');
  } catch (err) {
    return fail(res, err.status || 400, err.message || 'Erro no bridge.');
  }
}

const server = http.createServer((req, res) => { handle(req, res).catch(err => { try { fail(res, 500, err.message); } catch {} }); });

function shutdown() {
  for (const run of runs.values()) { const child = run.child || run.prepChild; if (child) { run.cancelled = true; killTree(child); } flushRun(run); }
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  server.close();
  // Runs still open are marked interrupted at the next start.
  setTimeout(() => { try { store?.close(); } catch {} process.exit(0); }, 300).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// A port in use (usually another SQUAD/CODE already open) ends here, before the database is touched.
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`SQUAD/CODE: a porta ${PORT} já está em uso (outro SQUAD/CODE aberto?). Feche-o ou use outra porta: npm start -- --port ${PORT + 1}`);
  else console.error(`SQUAD/CODE: não foi possível abrir o servidor em ${HOST}:${PORT}. ${err.message}`);
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // The database opens only once the port is ours: a second instance never marks the first one's live runs as interrupted.
  if (fs.existsSync(DB_FILE) || fs.existsSync(LEGACY_FILE)) {
    try { openDb(); }
    catch (e) { console.error(`SQUAD/CODE: não foi possível abrir o banco em ${DATA_DIR}.\n${e.message}`); try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch {} process.exit(1); }
  }
  const url = `http://${HOST}:${PORT}`;
  console.log(`SQUAD/CODE bridge ativo em ${url}`);
  console.log(`Pasta dos projetos: ${PROJECTS_DIR}`);
  if (store) console.log(`Banco de dados: ${store.file}`);
  else console.log(`Banco de dados: nenhum em ${DATA_DIR}. Abra ${url} para criar um.`);
  if (store?.interrupted) console.log(`${store.interrupted} execução(ões) interrompida(s) na última sessão marcada(s) no histórico.`);
  if (process.env.SQUAD_PRINT_TOKEN) console.log(`TOKEN=${TOKEN}`);
  claudeVersion(DEFAULT_BIN).then(info => {
    if (info.version) console.log(`Claude Code ${info.version} (${info.resolved})`);
    else console.warn(`Claude Code não encontrado (${DEFAULT_BIN}): ${info.error}\n  Instale o Claude Code, rode "claude" uma vez para fazer login e reinicie, ou aponte SQUAD_CLAUDE_BIN para o executável.\n  Sem ele o app abre, mas as execuções ficam só na simulação.`);
  }, () => {});
});

module.exports = { server };
