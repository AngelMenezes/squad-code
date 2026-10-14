// Bridge integration tests: `node --test tests/`. Uses tests/fake-claude.mjs, so no API calls are made.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4400 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = prefix => mkdtempSync(path.join(tmpdir(), prefix));
const home = tmp('squad-home-');
const workdir = tmp('squad-work-');
// The server's own temp folder (squad-code-*) goes inside this one, so tests can reach it and nothing leaks into %TEMP%.
const tempRoot = tmp('squad-tmp-');
// Per-project folders go here instead of ./projects in the repo.
const projectsRoot = tmp('squad-projects-');
// The SQLite database (squad.db) goes here instead of ./data in the repo.
const dataRoot = tmp('squad-data-');
const extraDirs = [], bridges = [];
let server, token, nextPort = PORT + 1;

/** Starts a bridge on its own port with `dataDir` as the database folder; several starts on one folder test restarts. */
async function startBridge(dataDir, port = nextPort++) {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--port', String(port)], {
    cwd: workdir,
    env: { ...process.env, TEMP: tempRoot, TMP: tempRoot, TMPDIR: tempRoot, SQUAD_HOME: home, SQUAD_PROJECTS_DIR: projectsRoot, SQUAD_DATA_DIR: dataDir, SQUAD_CLAUDE_BIN: path.join(ROOT, 'tests', 'fake-claude.mjs'), SQUAD_PRINT_TOKEN: '1' },
  });
  let out = '';
  const tok = await new Promise((resolve, reject) => {
    proc.stdout.on('data', d => { out += d; const m = out.match(/TOKEN=(\w+)/); if (m) resolve(m[1]); });
    proc.stderr.on('data', d => { out += d; });
    proc.on('exit', code => reject(new Error(`server exited ${code}\n${out}`)));
    setTimeout(() => reject(new Error(`server start timeout\n${out}`)), 10000);
  });
  const base = `http://127.0.0.1:${port}`;
  const b = {
    proc, token: tok, base, out: () => out,
    api: (p, init = {}) => fetch(base + p, { ...init, headers: { 'content-type': 'application/json', 'x-squad-token': tok, ...(init.headers || {}) } }),
    // Windows: a hard kill (no shutdown), like closing the terminal.
    stop: async () => { if (proc.exitCode === null) { const exited = new Promise(r => proc.once('exit', r)); proc.kill(); await exited; } },
  };
  bridges.push(b);
  return b;
}

before(async () => {
  const b = await startBridge(dataRoot, PORT);
  server = b.proc; token = b.token;
});
after(async () => {
  for (const b of bridges) await b.stop();
  // Windows may keep the dirs busy for a moment after the process exits.
  for (const dir of [home, workdir, tempRoot, projectsRoot, dataRoot, ...extraDirs]) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
});

const api = (p, init = {}) => fetch(BASE + p, { ...init, headers: { 'content-type': 'application/json', 'x-squad-token': token, ...(init.headers || {}) } });

async function collect(runId, base = BASE, tok = token) {
  const res = await fetch(`${base}/api/runs/${runId}/events?token=${tok}`);
  const text = await res.text();
  return text.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
}
const pageTag = (html, id) => JSON.parse(html.match(new RegExp(`<script type="application/json" id="${id}">(.*?)</script>`, 's'))[1]);
const page = async (base = BASE) => (await fetch(base + '/')).text();

test('serves index with injected token', async () => {
  const html = await (await fetch(BASE + '/')).text();
  assert.match(html, new RegExp(`name="squad-bridge-token" content="${token}"`));
});

test('rejects missing token and foreign origin', async () => {
  assert.equal((await fetch(BASE + '/api/health')).status, 401);
  assert.equal((await api('/api/health', { headers: { origin: 'http://evil.example' } })).status, 403);
});

test('health reports fake claude version', async () => {
  const body = await (await api('/api/health')).json();
  assert.equal(body.ok, true);
  assert.match(body.claudeVersion, /9\.9\.9/);
  assert.equal(body.projectsDir, realpathSync.native(projectsRoot));
});

test('project runs get their own folder under the projects root, without the app CLAUDE.md or an enclosing git repo', async () => {
  const folder = 'op-001-atlas-commerce', dir = path.join(projectsRoot, folder);
  assert.equal(existsSync(dir), false);
  // The projects root inside a git repository, like projects/ inside a clone of this app.
  let git = true;
  try { execFileSync('git', ['init', '-q', projectsRoot], { stdio: 'ignore' }); } catch { git = false; }
  const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'build it GITCHECK', options: { project: folder, cwd: workdir } }) });
  assert.equal(res.status, 201, await res.clone().text());
  const { runId, args, cwd } = await res.json();
  assert.ok(existsSync(dir));
  assert.equal(cwd, realpathSync.native(dir));
  assert.equal(args[args.indexOf('--settings') + 1], '<settings-file>');
  const events = await collect(runId);
  const init = events.find(e => e.type === 'system' && e.subtype === 'init');
  assert.equal(init.cwd, realpathSync.native(dir));
  assert.ok(init.settings.claudeMdExcludes.includes(realpathSync.native(path.join(ROOT, 'CLAUDE.md')).replace(/\\/g, '/')));
  assert.equal(init.settings.permissions.blockReadsOutsideWorkingDirectories, true);
  // The folder is its own repository and git stops at the projects root: the agents' git commands never reach the enclosing one.
  assert.ok(init.gitCeiling.split(path.delimiter).includes(realpathSync.native(projectsRoot)));
  if (git) {
    assert.ok(existsSync(path.join(dir, '.git')));
    assert.equal(path.resolve(init.gitTop).toLowerCase(), realpathSync.native(dir).toLowerCase());
  }
  rmSync(path.join(projectsRoot, '.git'), { recursive: true, force: true });
  assert.equal(events.at(-1).status, 'done');
  // Runs without a project keep the plain cwd, no extra settings and no git ceiling.
  const plain = await (await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'x', options: { cwd: workdir } }) })).json();
  assert.ok(!plain.args.includes('--settings'));
  const plainInit = (await collect(plain.runId)).find(e => e.type === 'system' && e.subtype === 'init');
  assert.equal(plainInit.gitCeiling, process.env.GIT_CEILING_DIRECTORIES || null);
  // Neither a project nor a folder: refused, never run in the bridge's own folder.
  const none = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'x', options: {} }) });
  assert.equal(none.status, 400);
  assert.match((await none.json()).error, /pasta de projeto/);
});

test('squad colleagues go to claude as an --agents file, with forwarded subagent text on request', async () => {
  const agents = { argus: { description: 'ARGUS, arquiteto. Chame para decisões de arquitetura.', prompt: 'Você é o ARGUS.', tools: ['Read', 'Grep'], model: 'haiku', effort: 'low', color: 'ignored' }, echo: { description: 'ECHO, QA.' } };
  const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'implement', options: { cwd: workdir, agents, forwardSubagents: true, tools: ['Read', 'Agent'] } }) });
  assert.equal(res.status, 201, await res.clone().text());
  const { runId, args } = await res.json();
  assert.equal(args[args.indexOf('--agents') + 1], '<agents-file>');
  assert.ok(args.includes('--forward-subagent-text'));
  const events = await collect(runId);
  const init = events.find(e => e.type === 'system' && e.subtype === 'init');
  assert.equal(init.foregroundAgents, true, 'colleague calls must run in the foreground');
  assert.deepEqual(init.agents, { argus: { description: agents.argus.description, prompt: 'Você é o ARGUS.', tools: ['Read', 'Grep'], model: 'haiku', effort: 'low' }, echo: { description: 'ECHO, QA.', prompt: '' } });
  const call = events.find(e => e.type === 'assistant' && e.message.content.some(b => b.type === 'tool_use' && b.name === 'Agent'));
  assert.equal(call.message.content.find(b => b.name === 'Agent').input.subagent_type, 'argus');
  assert.ok(events.some(e => e.type === 'assistant' && e.parent_tool_use_id === 'call-1'));
  assert.ok(events.some(e => e.type === 'user' && e.message.content.some(b => b.type === 'tool_result' && b.tool_use_id === 'call-1')));
  assert.equal(events.at(-1).status, 'done');
  // The temp file is removed when the run ends (asynchronously, right after the stream closes).
  const tmp = path.join(tempRoot, readdirSync(tempRoot).find(d => d.startsWith('squad-code-')));
  const left = () => readdirSync(tmp).filter(f => f.endsWith('.agents.json'));
  for (let i = 0; i < 20 && left().length; i++) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(left(), []);
  // forwardSubagents only with true.
  const plain = await (await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'x', options: { cwd: workdir, agents: { argus: agents.argus }, forwardSubagents: 'yes' } }) })).json();
  assert.ok(plain.args.includes('--agents') && !plain.args.includes('--forward-subagent-text'));
  const plainEvents = await collect(plain.runId);
  assert.ok(!plainEvents.some(e => e.parent_tool_use_id));
});

test('rejects invalid squad agent definitions', async () => {
  const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`a${i}`, { description: 'x' }]));
  for (const agents of [[], 'argus', { 'Bad Key': { description: 'x' } }, { argus: 'x' }, { argus: {} }, { argus: { description: 'x', tools: ['Bash; rm'] } }, { argus: { description: 'x', model: 'a b' } }, { argus: { description: 'x', effort: 'turbo' } }, many]) {
    const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'x', options: { cwd: workdir, agents } }) });
    assert.equal(res.status, 400, JSON.stringify(agents).slice(0, 80));
  }
});

test('rejects project folder names that are not plain slugs', async () => {
  for (const project of ['../escape', 'a/b', 'a\\b', 'CON', 'con', 'Op-001', '-x', 'a.b', 'x'.repeat(81)]) {
    const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'x', options: { project } }) });
    assert.equal(res.status, 400, project);
  }
  assert.ok(!existsSync(path.join(path.dirname(projectsRoot), 'escape')));
  assert.deepEqual(readdirSync(projectsRoot).filter(d => d !== 'op-001-atlas-commerce'), []);
});

test('run streams events and final result with system prompt and flags', async () => {
  const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'hello agent', systemPrompt: 'be brief', options: { cwd: workdir, model: 'haiku', permissionMode: 'acceptEdits', allowedTools: ['Read', 'Bash(git *)'] } }) });
  assert.equal(res.status, 201);
  const { runId, args } = await res.json();
  assert.ok(args.includes('--permission-mode') && args.includes('acceptEdits'));
  const events = await collect(runId);
  const init = events.find(e => e.type === 'system' && e.subtype === 'init');
  assert.equal(init.model, 'haiku');
  assert.equal(init.foregroundAgents, false);
  assert.ok(events.some(e => e.type === 'assistant'));
  const exit = events.at(-1);
  assert.equal(exit.type, 'exit');
  assert.equal(exit.status, 'done');
  assert.equal(exit.result, 'ECHO:hello agent|SYS:be brief');
  assert.equal(exit.costUsd, 0.001);
});

test('partial streams text deltas only when asked (chat runs)', async () => {
  const run = async options => { const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'chat', options: { cwd: workdir, ...options } }) }); assert.equal(res.status, 201); const { runId, args } = await res.json(); return { args, events: await collect(runId) }; };
  const live = await run({ partial: true, tools: [], permissionMode: 'dontAsk' });
  assert.ok(live.args.includes('--include-partial-messages'));
  const deltas = live.events.filter(e => e.type === 'stream_event' && e.event?.delta?.type === 'text_delta').map(e => e.event.delta.text);
  assert.equal(deltas.join(''), 'working');
  assert.equal(live.events.at(-1).status, 'done');
  const plain = await run({ partial: 'yes' });
  assert.ok(!plain.args.includes('--include-partial-messages'));
  assert.ok(!plain.events.some(e => e.type === 'stream_event'));
});

test('recreates its temp folder when it disappears', async () => {
  // OS temp cleanup can remove the (usually empty) folder while the bridge keeps running.
  const dirs = readdirSync(tempRoot).filter(d => d.startsWith('squad-code-'));
  assert.equal(dirs.length, 1);
  rmSync(path.join(tempRoot, dirs[0]), { recursive: true, force: true });
  const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'still there?', systemPrompt: 'soul of the agent', options: { cwd: workdir } }) });
  assert.equal(res.status, 201, await res.clone().text());
  const exit = (await collect((await res.json()).runId)).at(-1);
  assert.equal(exit.status, 'done');
  assert.equal(exit.result, 'ECHO:still there?|SYS:soul of the agent');
});

test('failed run reports error', async () => {
  const { runId } = await (await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'FAIL please', options: { cwd: workdir } }) })).json();
  const exit = (await collect(runId)).at(-1);
  assert.equal(exit.status, 'error');
  assert.equal(exit.isError, true);
});

test('cancel kills a running process', async () => {
  const { runId } = await (await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'SLEEP', options: { cwd: workdir } }) })).json();
  const pending = collect(runId);
  await new Promise(r => setTimeout(r, 400));
  await api(`/api/runs/${runId}/cancel`, { method: 'POST' });
  const exit = (await pending).at(-1);
  assert.equal(exit.status, 'cancelled');
});

test('rejects invalid options', async () => {
  const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'x', options: { cwd: workdir, permissionMode: 'yolo' } }) });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /permissão/);
  const res2 = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'x', options: { cwd: workdir, allowedTools: ['Bash; rm -rf /'] } }) });
  assert.equal(res2.status, 400);
  assert.match((await res2.json()).error, /Ferramenta/);
});

test('settings.json read/write with backup (user and project scope)', async () => {
  const empty = await (await api('/api/claude/settings?scope=user')).json();
  assert.equal(empty.exists, false);
  let res = await api('/api/claude/settings?scope=user', { method: 'PUT', body: JSON.stringify({ text: '{"model":"sonnet"}' }) });
  assert.equal((await res.json()).backup, null);
  res = await api('/api/claude/settings?scope=user', { method: 'PUT', body: JSON.stringify({ text: '{"model":"opus"}' }) });
  const saved = await res.json();
  assert.ok(saved.backup && existsSync(saved.backup));
  assert.deepEqual(JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')), { model: 'opus' });
  assert.deepEqual(JSON.parse(readFileSync(saved.backup, 'utf8')), { model: 'sonnet' });

  res = await api(`/api/claude/settings?scope=project&cwd=${encodeURIComponent(workdir)}`, { method: 'PUT', body: JSON.stringify({ text: '{"permissions":{"allow":["Read"]}}' }) });
  assert.equal(res.status, 200);
  assert.ok(existsSync(path.join(workdir, '.claude', 'settings.json')));

  // A project folder that has no run yet: reading does not create it, saving does.
  const fresh = await (await api('/api/claude/settings?scope=local&project=op-002-loja')).json();
  assert.equal(fresh.exists, false);
  assert.equal(existsSync(path.join(projectsRoot, 'op-002-loja')), false);
  res = await api('/api/claude/settings?scope=project&project=op-002-loja', { method: 'PUT', body: JSON.stringify({ text: '{"model":"haiku"}' }) });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(path.join(projectsRoot, 'op-002-loja', '.claude', 'settings.json'), 'utf8')), { model: 'haiku' });
  assert.equal((await api('/api/claude/settings?scope=project&project=..%2Fx')).status, 400);

  res = await api('/api/claude/settings?scope=user', { method: 'PUT', body: JSON.stringify({ text: '[1,2]' }) });
  assert.equal(res.status, 400);
  res = await api('/api/claude/settings?scope=user', { method: 'PUT', body: JSON.stringify({ text: '{bad' }) });
  assert.equal(res.status, 400);
});

test('workspace is saved in SQLite, injected into the page and guarded against stale writes', async () => {
  // No database yet: the page is told to ask how to start, and nothing reaches the disk before that.
  let tag = pageTag(await page(), 'squad-disk');
  assert.equal(tag.workspace, null);
  assert.equal(tag.rev, '');
  assert.equal(tag.setup, true);
  assert.equal(path.basename(tag.path), 'squad.db');
  assert.equal((await (await api('/api/workspace')).json()).exists, false);
  assert.equal((await (await api('/api/health')).json()).dbReady, false);
  const ws = { version: 2, agents: [], projects: [{ id: 'p1', name: 'Atlas </script><b>x</b> $& $1' }], squads: [] };
  assert.equal((await api('/api/workspace?base=', { method: 'PUT', body: JSON.stringify(ws) })).status, 503);
  assert.equal((await api('/api/workspace/snapshots')).status, 503);
  assert.equal((await api('/api/setup', { method: 'POST', body: JSON.stringify({ version: 2, agents: [], projects: [] }) })).status, 400);
  assert.equal(existsSync(path.join(dataRoot, 'squad.db')), false);

  // The page creates it with the workspace the person chose; a second setup is refused.
  let res = await api('/api/setup', { method: 'POST', body: JSON.stringify(ws) });
  assert.equal(res.status, 201, await res.clone().text());
  const first = await res.json();
  assert.match(first.rev, /^[0-9a-f]{16}$/);
  assert.equal(path.basename(first.path), 'squad.db');
  assert.ok(existsSync(path.join(dataRoot, 'squad.db')));
  assert.deepEqual((await (await api('/api/workspace')).json()).workspace, ws);
  assert.equal((await api('/api/setup', { method: 'POST', body: JSON.stringify(ws) })).status, 409);
  assert.equal((await (await api('/api/health')).json()).dbReady, true);

  // The page boots from the saved copy; `<` is escaped and replacement patterns are kept verbatim.
  const html = await page();
  assert.ok(!html.includes('</script><b>'));
  tag = pageTag(html, 'squad-disk');
  assert.deepEqual(tag.workspace, ws);
  assert.equal(tag.rev, first.rev);
  assert.equal(tag.setup, false);
  const meta = await (await api('/api/workspace?meta=1')).json();
  assert.equal(meta.rev, first.rev);
  assert.equal('workspace' in meta, false);

  // A write built on an older rev (a stale tab) is refused; the current rev is accepted and only the new row is written.
  const next = { ...ws, projects: [...ws.projects, { id: 'p2', name: 'Nova operação' }] };
  res = await api('/api/workspace?base=0000000000000000', { method: 'PUT', body: JSON.stringify(next) });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).rev, first.rev);
  assert.deepEqual((await (await api('/api/workspace')).json()).workspace, ws);
  res = await api(`/api/workspace?base=${first.rev}`, { method: 'PUT', body: JSON.stringify(next) });
  assert.equal(res.status, 200);
  const second = await res.json();
  assert.notEqual(second.rev, first.rev);
  assert.equal(second.changes, 1);
  assert.deepEqual((await (await api('/api/workspace')).json()).workspace, next);
  // The first overwrite of this bridge start keeps the previous workspace as a version.
  const versions = async () => (await (await api('/api/workspace/snapshots')).json()).snapshots;
  let list = await versions();
  assert.equal(list.length, 1);
  assert.equal(list[0].origin, 'disco');
  assert.deepEqual((await (await api(`/api/workspace/snapshots/${list[0].id}`)).json()).workspace, ws);

  // Same content again: nothing is rewritten and the rev stays.
  res = await (await api(`/api/workspace?base=${second.rev}`, { method: 'PUT', body: JSON.stringify(next) })).json();
  assert.equal(res.unchanged, true);
  assert.equal(res.rev, second.rev);

  // force skips the rev check and keeps the overwritten version.
  res = await api('/api/workspace?force=1', { method: 'PUT', body: JSON.stringify(ws) });
  assert.equal(res.status, 200);
  list = await versions();
  assert.equal(list.length, 2);
  assert.deepEqual((await (await api(`/api/workspace/snapshots/${list[0].id}`)).json()).workspace, next);

  // A browser copy becomes a version without touching the workspace.
  res = await api('/api/workspace/backups', { method: 'POST', body: JSON.stringify(next) });
  assert.equal(res.status, 201);
  const kept = (await res.json()).id;
  list = await versions();
  assert.equal(list.find(s => s.id === kept).origin, 'navegador');
  assert.deepEqual((await (await api(`/api/workspace/snapshots/${kept}`)).json()).workspace, next);
  assert.deepEqual((await (await api('/api/workspace')).json()).workspace, ws);
  assert.equal((await api('/api/workspace/snapshots/99999')).status, 404);

  // Anything that is not a v2 workspace is refused.
  for (const bad of [{}, { version: 1, agents: [], projects: [{}] }, { version: 2, agents: [], projects: [] }, [1]]) {
    res = await api('/api/workspace?force=1', { method: 'PUT', body: JSON.stringify(bad) });
    assert.equal(res.status, 400);
  }
  assert.equal((await fetch(BASE + '/api/workspace')).status, 401);
});

test('workspace rows round-trip byte for byte and diffs touch only what changed', async () => {
  const at = i => new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  const ws = {
    version: 2, extraTop: { kept: true },
    agents: [{ id: 'a1', name: 'VANGUARD', role: 'commander', tools: ['Read'], hex: { q: 0, r: 0 }, futureField: [1, { x: 2 }] }, { id: 'a1', name: 'DUP', role: 'qa' }, { name: 'SEM ID', role: 'po' }],
    conventionLibrary: { templates: [{ id: 't1', name: 'Base', content: 'x' }], subsets: [] },
    squads: [{ id: 's1', name: 'ALFA', commanderId: 'a1', operatorIds: ['a1'], agentIds: ['a1'] }],
    projects: [
      { id: 'p1', code: 'OP-001', name: 'Um', adrs: [{ title: 'Sem id', content: '## Contexto' }], sprints: [{ id: 'sp1', name: 'Sprint 01' }],
        features: [{ id: 'f1', key: 'F01', title: 'Login', status: 'done', route: ['a1'], outputs: [{ agentId: 'a1', at: at(1), text: 'ok' }, { agentId: 'a1', at: at(1), text: 'mesmo instante' }] }],
        logs: Array.from({ length: 500 }, (_, i) => ({ id: 'event-' + i, at: at(i), agentId: null, type: 'system', message: 'log ' + i, simulated: true })),
        handoffs: [{ id: 'h1', at: at(2), from: 'a1', to: 'a1', featureId: 'f1', context: 'ctx' }], settingsLike: null },
      { id: 'p2', name: 'Sem filhos' },
    ],
    projectId: 'p1', settings: { motion: true, runtime: { mode: 'claude' } },
  };
  const put = async (body, q = 'force=1') => (await api(`/api/workspace?${q}`, { method: 'PUT', body: JSON.stringify(body) })).json();
  const get = async () => (await (await api('/api/workspace')).json()).workspace;
  let res = await put(ws);
  assert.equal(res.ok, true);
  assert.equal(JSON.stringify(await get()), JSON.stringify(ws));

  // A capped log: one entry in, the first one out. Two row changes, not 500.
  const capped = structuredClone(ws);
  capped.projects[0].logs.push({ id: 'event-500', at: at(500), agentId: null, type: 'system', message: 'log 500', simulated: true });
  capped.projects[0].logs.shift();
  res = await put(capped, `base=${res.rev}`);
  assert.equal(res.changes, 2);
  assert.equal(JSON.stringify(await get()), JSON.stringify(capped));

  // Reordering features and editing one field.
  const moved = structuredClone(capped);
  moved.projects.reverse();
  moved.agents[0].name = 'VANGUARD II';
  res = await put(moved, `base=${res.rev}`);
  assert.ok(res.changes >= 3 && res.changes <= 4, `changes=${res.changes}`);
  assert.equal(JSON.stringify(await get()), JSON.stringify(moved));

  // Generated columns make the entities queryable with plain SQL.
  const db = new Database(path.join(dataRoot, 'squad.db'), { readonly: true });
  try {
    assert.deepEqual(db.prepare('SELECT name, role FROM agents ORDER BY pos').all().map(r => `${r.name}/${r.role}`), ['VANGUARD II/commander', 'DUP/qa', 'SEM ID/po']);
    assert.equal(db.prepare("SELECT title FROM features WHERE status = 'done'").pluck().get(), 'Login');
    assert.equal(db.prepare('SELECT count(*) FROM logs').pluck().get(), 500);
    assert.equal(db.prepare('SELECT count(*) FROM feature_outputs').pluck().get(), 2);
  } finally { db.close(); }
});

test('JSON files from the previous version are migrated once and kept in legacy-json', async () => {
  const dir = tmp('squad-legacy-'); extraDirs.push(dir);
  const legacy = { version: 2, agents: [{ id: 'a1', name: 'VANGUARD', role: 'commander' }], projects: [{ id: 'p1', name: 'Legado', logs: [{ id: 'l1', at: '2026-01-01T00:00:00.000Z', message: 'x' }] }], squads: [] };
  const text = JSON.stringify(legacy, null, 2) + '\n';
  writeFileSync(path.join(dir, 'workspace.json'), text);
  writeFileSync(path.join(dir, 'workspace.json.bak'), text);
  mkdirSync(path.join(dir, 'backups'));
  writeFileSync(path.join(dir, 'backups', 'workspace-2026-10-01T10-00-00-000Z-disco.json'), JSON.stringify({ ...legacy, projects: [{ id: 'p0', name: 'Antigo' }] }));
  let b = await startBridge(dir);
  let info = await (await b.api('/api/workspace')).json();
  assert.deepEqual(info.workspace, legacy);
  // Same rev the file-based bridge gave it, so the browsers' copies still match.
  assert.equal(info.rev, createHash('sha1').update(text).digest('hex').slice(0, 16));
  assert.ok(existsSync(path.join(dir, 'legacy-json', 'workspace.json')));
  assert.ok(existsSync(path.join(dir, 'legacy-json', 'backups')));
  assert.equal(existsSync(path.join(dir, 'workspace.json')), false);
  const snaps = (await (await b.api('/api/workspace/snapshots')).json()).snapshots;
  assert.deepEqual(snaps.map(s => s.origin).sort(), ['disco', 'migração']);
  assert.equal(snaps.find(s => s.origin === 'disco').createdAt, '2026-10-01T10:00:00.000Z');
  assert.match(b.out(), /migrado/);
  await b.stop();
  // A workspace.json dropped there later is not imported again.
  writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ ...legacy, projects: [{ id: 'p9', name: 'Outro' }] }));
  b = await startBridge(dir);
  info = await (await b.api('/api/workspace')).json();
  assert.deepEqual(info.workspace, legacy);
  await b.stop();
});

test('a second bridge on a port in use explains it and leaves the database alone', async () => {
  const dir = tmp('squad-busy-'); extraDirs.push(dir);
  // A data/workspace.json would be imported (and moved) as soon as the database opened.
  writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ version: 2, agents: [], projects: [{ id: 'p1', name: 'Ocupada' }], squads: [] }));
  await assert.rejects(startBridge(dir, PORT), err => /server exited 1/.test(err.message) && /porta \d+ já está em uso/.test(err.message));
  assert.ok(existsSync(path.join(dir, 'workspace.json')));
  assert.equal(existsSync(path.join(dir, 'squad.db')), false);
  assert.equal((await api('/api/health')).status, 200);
});

test('run history survives a restart; a run cut by a dead bridge comes back interrupted', async () => {
  const dir = tmp('squad-runs-'); extraDirs.push(dir);
  let b = await startBridge(dir);
  let res = await b.api('/api/setup', { method: 'POST', body: JSON.stringify({ version: 2, agents: [], projects: [{ id: 'p1', name: 'Histórico' }], squads: [] }) });
  assert.equal(res.status, 201);
  res = await b.api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'hello', label: 'passo', options: { cwd: workdir, partial: true }, meta: { projectId: 'p1', agentId: 'agent-x', featureId: 'f1', kind: 'step', other: 'x' } }) });
  assert.equal(res.status, 201);
  const done = (await res.json()).runId;
  const live = await collect(done, b.base, b.token);
  assert.equal(live.at(-1).type, 'exit');
  res = await b.api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'SLEEP', options: { cwd: workdir }, meta: { projectId: 'p1', kind: 'chat' } }) });
  const cut = (await res.json()).runId;
  await new Promise(r => setTimeout(r, 700)); // the first events reach the database
  await b.stop();

  b = await startBridge(dir);
  const list = (await (await b.api('/api/runs?projectId=p1')).json()).runs;
  assert.deepEqual(list.map(r => r.id).sort(), [done, cut].sort());
  const first = list.find(r => r.id === done);
  assert.equal(first.status, 'done');
  assert.equal(first.agentId, 'agent-x');
  assert.equal(first.kind, 'step');
  assert.equal(first.costUsd, 0.001);
  assert.equal(list.find(r => r.id === cut).status, 'interrupted');
  // Replay from the database: the same events, without the partial text deltas.
  const replay = await collect(done, b.base, b.token);
  assert.deepEqual(replay.map(e => e.type), live.filter(e => e.type !== 'stream_event').map(e => e.type));
  assert.ok(live.some(e => e.type === 'stream_event'));
  const cutEvents = await collect(cut, b.base, b.token);
  assert.equal(cutEvents.at(-1).type, 'exit');
  assert.equal(cutEvents.at(-1).status, 'interrupted');
  try { process.kill(cutEvents.find(e => e.subtype === 'spawned').pid); } catch {}
  const detail = await (await b.api(`/api/runs/${done}`)).json();
  assert.equal(detail.run.status, 'done');
  assert.equal(detail.result.costUsd, 0.001);
  assert.equal((await b.api('/api/runs/nope')).status, 404);
  await b.stop();
});

test('operation room messages are saved incrementally, trimmed and handed to the page', async () => {
  const ws = { version: 2, agents: [{ id: 'a1', name: 'VANGUARD', role: 'commander' }], projects: [{ id: 'p1', name: 'Um', features: [{ id: 'f1', title: 'Login' }] }], squads: [] };
  assert.equal((await api('/api/workspace?force=1', { method: 'PUT', body: JSON.stringify(ws) })).status, 200);
  const msgs = Array.from({ length: 820 }, (_, i) => ({ id: 'rm' + (i + 1), at: new Date().toISOString(), kind: 'say', agentId: 'a1', text: 'm' + (i + 1) }));
  const room = body => api('/api/rooms/p1', { method: 'POST', body: JSON.stringify(body) });
  assert.equal((await room({ seq: 410, upserts: msgs.slice(0, 410) })).status, 200);
  assert.equal((await room({ seq: 820, upserts: msgs.slice(410) })).status, 200);
  // Invalid ids and kinds are ignored; one update, one removal and a long baton (cut to what the room shows).
  assert.equal((await (await room({ upserts: [{ id: 'x1', kind: 'say' }, { id: 'rm9999', kind: 'evil' }] })).json()).saved, 0);
  await room({ seq: 821, upserts: [{ ...msgs[819], text: 'editado' }, { id: 'rm821', at: new Date().toISOString(), kind: 'baton', from: 'a1', to: null, text: 'x'.repeat(20000) }], removes: ['rm819'] });
  assert.equal((await api('/api/rooms/..%2Fx', { method: 'POST', body: '{}' })).status, 400);

  const db = new Database(path.join(dataRoot, 'squad.db'), { readonly: true });
  try { assert.equal(db.prepare("SELECT count(*) FROM room_messages WHERE project_id = 'p1'").pluck().get(), 800); } finally { db.close(); }
  const r = pageTag(await page(), 'squad-memory').rooms.p1;
  assert.equal(r.seq, 821);
  assert.equal(r.messages.length, 200);
  assert.equal(r.messages.at(-1).id, 'rm821');
  assert.equal(r.messages.at(-1).text.length, 8001);
  assert.equal(r.messages.find(m => m.id === 'rm820').text, 'editado');
  assert.equal(r.messages.some(m => m.id === 'rm819'), false);
});

test('chats are saved per kind, capped and swept when their feature is gone', async () => {
  const msgs = n => Array.from({ length: n }, (_, i) => ({ id: 'm' + (i + 1), at: Date.now(), role: i % 2 ? 'agent' : 'user', text: 'msg ' + (i + 1) }));
  const put = (kind, key, data, projectId = 'p1') => api(`/api/chats/${kind}/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ projectId, data }) });
  assert.equal((await put('agent', 'a1', { seq: 310, greeting: 'oi', focus: null, messages: msgs(310) })).status, 200);
  assert.equal((await put('feature', 'f1', { seq: 2, greeting: 'olá', messages: msgs(2) })).status, 200);
  assert.equal((await put('doc', 'p1:kickoff:a1+a2', { seq: 1, greeting: 'bom dia', greetings: { a1: 'oi' }, since: 0, messages: msgs(1) })).status, 200);
  assert.equal((await put('feature', 'gone', { seq: 1, messages: msgs(1) })).status, 200);
  assert.equal((await put('evil', 'a1', { messages: [] })).status, 400);
  assert.equal((await put('agent', '../a1', { messages: [] })).status, 400);
  assert.equal((await put('agent', 'a1', { greeting: 'sem mensagens' })).status, 400);

  let chats = pageTag(await page(), 'squad-memory').chats;
  assert.equal(chats.agent.a1.messages.length, 300);
  assert.equal(chats.agent.a1.messages[0].id, 'm11');
  assert.equal(chats.agent.a1.greeting, 'oi');
  assert.equal(chats.feature.f1.messages.length, 2);
  assert.deepEqual(chats.doc['p1:kickoff:a1+a2'].greetings, { a1: 'oi' });
  assert.equal(chats.feature.gone, undefined); // no feature 'gone' in the workspace
  assert.equal((await api('/api/chats/agent/a1', { method: 'DELETE' })).status, 200);
  chats = pageTag(await page(), 'squad-memory').chats;
  assert.equal(chats.agent.a1, undefined);
});

test('a linked operation clones a registered repository into its folder once, keeps it, and never pushes', async t => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('git não instalado'); }
  const src = tmp('squad-src-'); extraDirs.push(src);
  const git = (...a) => execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  git('init', '-q'); git('checkout', '-q', '-b', 'main');
  writeFileSync(path.join(src, 'README.md'), '# Faturamento\n');
  git('add', '.'); git('commit', '-q', '-m', 'init');
  const reposFile = path.join(dataRoot, 'repos.json');
  writeFileSync(reposFile, JSON.stringify({ repos: [{ id: 'billing', name: 'Faturamento', path: src, baseBranch: 'main' }, { id: 'broken', path: path.join(src, 'nope') }, { id: 'Bad Id', path: src }, { id: 'evil', url: '--upload-pack=x' }] }));
  const run = (project, repo, prompt = 'mapear') => api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt, options: { project, repo } }) });
  try {
    // The page gets ids, names and problems, never the path or URL.
    const health = await (await api('/api/health')).json();
    assert.deepEqual(health.repos.repos.map(r => [r.id, !!r.error]), [['billing', false], ['broken', true], ['evil', true]]);
    assert.ok(!JSON.stringify(health.repos.repos).includes(path.basename(src)));
    const unknown = await run('op-010-x', 'nope');
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /não cadastrado/);
    for (const id of ['broken', 'evil']) assert.equal((await run('op-013-' + id, id)).status, 400, id);
    // First run: the folder becomes a clone of the repository, with pushes blocked.
    const res = await run('op-010-billing', 'billing', 'mapear GITCHECK');
    assert.equal(res.status, 201, await res.clone().text());
    const { runId, args } = await res.json();
    const dir = path.join(projectsRoot, 'op-010-billing');
    assert.ok(args[args.indexOf('--disallowedTools') + 1].split(',').includes('Bash(git push:*)'));
    const first = await collect(runId);
    assert.ok(first.some(e => e.type === 'bridge' && e.subtype === 'prepare' && e.step === 'clone'));
    assert.ok(existsSync(path.join(dir, 'README.md')));
    const init = first.find(e => e.type === 'system' && e.subtype === 'init');
    assert.equal(path.resolve(init.gitTop).toLowerCase(), realpathSync.native(dir).toLowerCase());
    // Later runs reuse the clone: the agents' work stays.
    writeFileSync(path.join(dir, 'notes.md'), 'x');
    const second = await run('op-010-billing', 'billing');
    assert.equal(second.status, 201);
    assert.ok(!(await collect((await second.json()).runId)).some(e => e.subtype === 'prepare'));
    assert.ok(existsSync(path.join(dir, 'notes.md')));
    // A folder that already holds work is not taken over; the empty repository of an earlier git init gives way.
    const used = path.join(projectsRoot, 'op-011-used');
    mkdirSync(used); writeFileSync(path.join(used, 'a.txt'), 'x');
    const busy = await run('op-011-used', 'billing');
    assert.equal(busy.status, 400);
    assert.match((await busy.json()).error, /já tem arquivos/);
    const early = path.join(projectsRoot, 'op-012-early');
    execFileSync('git', ['init', '-q', early], { stdio: 'ignore' });
    const reinit = await run('op-012-early', 'billing');
    assert.equal(reinit.status, 201);
    await collect((await reinit.json()).runId);
    assert.ok(existsSync(path.join(early, 'README.md')));
    // Without a project folder the link is refused.
    const loose = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'x', options: { cwd: workdir, repo: 'billing' } }) });
    assert.equal(loose.status, 400);
  } finally { rmSync(reposFile, { force: true }); }
});

test('each feature of a linked operation works in its own worktree, prepared once, and approval removes it but keeps the branch', async t => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('git não instalado'); }
  const src = tmp('squad-src-'); extraDirs.push(src);
  const gitIn = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  gitIn(src, 'init', '-q'); gitIn(src, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(src, 'README.md'), '# Portal\n'); writeFileSync(path.join(src, 'CLAUDE.md'), 'base\n');
  writeFileSync(path.join(src, '.gitignore'), 'prepared.txt\n');
  gitIn(src, 'add', '.'); gitIn(src, 'commit', '-q', '-m', 'init');
  const reposFile = path.join(dataRoot, 'repos.json');
  writeFileSync(reposFile, JSON.stringify({ repos: [{ id: 'portal', path: src, baseBranch: 'main', prepare: `node -e "require('fs').writeFileSync('prepared.txt','ok')"` }] }));
  const folder = 'op-020-portal', root = path.join(projectsRoot, folder);
  const run = (options, prompt = 'trabalhar') => api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt, options: { project: folder, repo: 'portal', ...options } }) });
  try {
    // First step of F01: a worktree on squad/f01-aaaaaa from the base branch, prepared, outside the clone's status.
    const res = await run({ feature: 'f01-aaaaaa' }, 'trabalhar GITCHECK');
    assert.equal(res.status, 201, await res.clone().text());
    const { runId, cwd } = await res.json();
    const wt = path.join(root, '.wt', 'f01-aaaaaa');
    const events = await collect(runId);
    assert.equal(cwd.toLowerCase(), realpathSync.native(wt).toLowerCase());
    const init = events.find(e => e.type === 'system' && e.subtype === 'init');
    assert.equal(path.resolve(init.gitTop).toLowerCase(), realpathSync.native(wt).toLowerCase());
    // The clone's own CLAUDE.md (base branch) is not loaded on top of the worktree's.
    assert.ok(init.settings.claudeMdExcludes.includes(`${realpathSync.native(root).replace(/\\/g, '/')}/CLAUDE.md`));
    const info = events.find(e => e.type === 'bridge' && e.subtype === 'worktree');
    assert.equal(info.branch, 'squad/f01-aaaaaa');
    assert.equal(info.created, true);
    assert.match(info.prepare, /Preparo concluído/);
    assert.equal(gitIn(wt, 'branch', '--show-current'), 'squad/f01-aaaaaa');
    assert.ok(existsSync(path.join(wt, 'prepared.txt')));
    assert.equal(gitIn(root, 'status', '--porcelain'), '');
    // Next step of the same feature: same worktree, no second prepare.
    rmSync(path.join(wt, 'prepared.txt'));
    const again = await run({ feature: 'f01-aaaaaa' });
    const againInfo = (await collect((await again.json()).runId)).find(e => e.subtype === 'worktree');
    assert.equal(againInfo.created, false);
    assert.equal(againInfo.prepare, null);
    assert.ok(!existsSync(path.join(wt, 'prepared.txt')));
    // Plans and chats (no feature) stay in the clone.
    assert.equal((await (await run({})).json()).cwd.toLowerCase(), realpathSync.native(root).toLowerCase());
    // While docs/squad is only on the reconnaissance branch, a new feature starts from it.
    const recon = await run({ feature: 'f00-bbbbbb' });
    await collect((await recon.json()).runId);
    const reconWt = path.join(root, '.wt', 'f00-bbbbbb');
    mkdirSync(path.join(reconWt, 'docs', 'squad'), { recursive: true });
    writeFileSync(path.join(reconWt, 'docs', 'squad', 'mapa.md'), '# Mapa\n');
    gitIn(reconWt, 'add', '.'); gitIn(reconWt, 'commit', '-q', '-m', 'mapa');
    const f02 = await run({ feature: 'f02-cccccc', featureBase: 'f00-bbbbbb' });
    const f02Info = (await collect((await f02.json()).runId)).find(e => e.subtype === 'worktree');
    assert.match(f02Info.notes.join(' '), /squad\/f00-bbbbbb/);
    assert.ok(existsSync(path.join(root, '.wt', 'f02-cccccc', 'docs', 'squad', 'mapa.md')));
    // Approval: uncommitted work keeps the worktree; once committed it goes and the branch stays.
    writeFileSync(path.join(wt, 'wip.md'), 'x');
    const dirty = await api(`/api/worktrees/${folder}/f01-aaaaaa`, { method: 'DELETE' });
    assert.equal(dirty.status, 409);
    gitIn(wt, 'add', 'wip.md'); gitIn(wt, 'commit', '-q', '-m', 'wip');
    const removed = await (await api(`/api/worktrees/${folder}/f01-aaaaaa`, { method: 'DELETE' })).json();
    assert.equal(removed.removed, true);
    assert.ok(!existsSync(wt));
    assert.equal(gitIn(root, 'rev-parse', '--verify', '-q', 'refs/heads/squad/f01-aaaaaa').length, 40);
    assert.equal((await (await api(`/api/worktrees/${folder}/f01-aaaaaa`, { method: 'DELETE' })).json()).removed, false);
    // Refusals: a feature without a linked repository, and ids that are not plain slugs.
    assert.equal((await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'x', options: { project: 'op-021-plain', feature: 'f01-aaaaaa' } }) })).status, 400);
    for (const feature of ['../x', 'F01', 'a/b']) assert.equal((await run({ feature })).status, 400, feature);
    assert.equal((await api(`/api/worktrees/${folder}/F01.x`, { method: 'DELETE' })).status, 400);
    assert.equal((await api(`/api/worktrees/Op..x/f01-aaaaaa`, { method: 'DELETE' })).status, 400);
  } finally { rmSync(reposFile, { force: true }); }
});

test('a linked run answers at once and prepares as its own phase: live output, cancel mid-way, and a failed prepare stops the agent', async t => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('git não instalado'); }
  const src = tmp('squad-src-'); extraDirs.push(src);
  const git = (...a) => execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'ignore' });
  git('init', '-q'); git('checkout', '-q', '-b', 'main');
  writeFileSync(path.join(src, 'README.md'), '# App\n'); git('add', '.'); git('commit', '-q', '-m', 'init');
  const reposFile = path.join(dataRoot, 'repos.json');
  const node = code => `node -e "${code}"`;
  writeFileSync(reposFile, JSON.stringify({ repos: [
    { id: 'slow', path: src, prepare: node("console.log('instalando');setTimeout(()=>{},30000)") },
    { id: 'fail', path: src, prepare: node("console.error('sem rede');process.exit(3)") },
  ] }));
  const run = (project, repo) => api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'x', options: { project, repo, feature: 'f01-aaaaaa' } }) });
  // Reads the live event stream until an event matches, then lets go of it.
  const waitFor = async (runId, pred) => {
    const ctl = new AbortController(), res = await fetch(`${BASE}/api/runs/${runId}/events?token=${token}`, { signal: ctl.signal });
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('evento não chegou');
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const l of lines) if (l.startsWith('data: ') && pred(JSON.parse(l.slice(6)))) { ctl.abort(); return; }
    }
  };
  try {
    // The answer comes before the clone and the 30 s prepare; the output arrives live; cancel kills it and the agent never starts.
    const t0 = Date.now();
    const res = await run('op-030-slow', 'slow');
    assert.equal(res.status, 201, await res.clone().text());
    assert.ok(Date.now() - t0 < 5000);
    const { runId } = await res.json();
    await waitFor(runId, e => e.subtype === 'prepare-log' && /instalando/.test(e.text));
    assert.equal((await (await api(`/api/runs/${runId}`)).json()).run.phase, 'preparing');
    assert.equal((await (await api(`/api/runs/${runId}/cancel`, { method: 'POST' })).json()).ok, true);
    const events = await collect(runId);
    assert.deepEqual(events.filter(e => e.subtype === 'prepare').map(e => e.step), ['clone', 'fetch', 'worktree', 'prepare']);
    assert.equal(events.at(-1).status, 'cancelled');
    assert.ok(!events.some(e => e.subtype === 'spawned'));
    assert.ok(Date.now() - t0 < 20000);
    assert.ok(!existsSync(path.join(projectsRoot, 'op-030-slow', '.git', 'squad-prepared-f01-aaaaaa')));
    // A failed prepare ends the run as an error with its output, without starting claude; the next run tries it again.
    const failed = await collect((await (await run('op-031-fail', 'fail')).json()).runId);
    assert.equal(failed.at(-1).status, 'error');
    assert.match(failed.at(-1).error, /código 3[\s\S]*sem rede/);
    assert.ok(!failed.some(e => e.subtype === 'spawned'));
    const retry = await collect((await (await run('op-031-fail', 'fail')).json()).runId);
    assert.ok(retry.some(e => e.subtype === 'prepare' && e.step === 'prepare'));
  } finally { rmSync(reposFile, { force: true }); }
});

test('map freshness comes from git: fresh, changed (list in the prompt), stale on structure, date fallback, missing', async t => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { return t.skip('git não instalado'); }
  const src = tmp('squad-src-'); extraDirs.push(src);
  let env = process.env;
  const git = (...a) => execFileSync('git', ['-C', src, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env }).trim();
  const commit = (file, text, msg) => { mkdirSync(path.dirname(path.join(src, file)), { recursive: true }); writeFileSync(path.join(src, file), text); git('add', '.'); git('commit', '-q', '-m', msg); };
  git('init', '-q'); git('checkout', '-q', '-b', 'main');
  // The base commit is older than the rest, as when the map is written later (the date fallback has one-second precision).
  env = { ...process.env, GIT_AUTHOR_DATE: '2026-01-05T10:00:00Z', GIT_COMMITTER_DATE: '2026-01-05T10:00:00Z' };
  commit('src/a.js', 'a\n', 'init');
  env = process.env;
  // The map, merged on the base branch, describes the commit before it.
  const base = git('rev-parse', 'HEAD'), at = git('log', '-1', '--format=%cI');
  commit('docs/squad/mapa.md', '# Mapa\n', 'mapa');
  commit('docs/squad/.reconhecimento', `${base}\n${at}\n`, 'referência');
  const reposFile = path.join(dataRoot, 'repos.json');
  writeFileSync(reposFile, JSON.stringify({ repos: [{ id: 'maps', path: src, baseBranch: 'main' }, { id: 'nomap', path: src, baseBranch: 'nomap' }] }));
  const folder = 'op-040-maps';
  const step = async feature => {
    const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'tarefa', options: { project: folder, repo: 'maps', feature } }) });
    assert.equal(res.status, 201, await res.clone().text());
    const events = await collect((await res.json()).runId);
    return { map: events.find(e => e.subtype === 'map'), prompt: events.at(-1).result };
  };
  const check = async (fetch = true, repo = 'maps', dir = folder) => (await api(`/api/map/${dir}?repo=${repo}${fetch ? '&fetch=1' : ''}`)).json();
  try {
    assert.equal((await check(false, 'maps', 'op-041-none')).status, 'no-clone');
    assert.equal((await api(`/api/map/${folder}?repo=nope`)).status, 400);
    // Only docs/squad changed since the map: fresh, and the step prompt gets nothing extra.
    const fresh = await step('f01-aaaaaa');
    assert.equal(fresh.map.status, 'fresh');
    assert.ok(!fresh.prompt.includes('Mudanças no repositório'));
    // A small change on the base branch: the next feature's prompt lists it.
    commit('src/a.js', 'b\n', 'muda a');
    const changed = await step('f02-bbbbbb');
    assert.equal(changed.map.status, 'changed');
    assert.deepEqual(changed.map.files, ['M src/a.js']);
    assert.match(changed.prompt, /## Mudanças no repositório desde o mapa[\s\S]*M src\/a\.js/);
    // A manifest and a new top-level folder are structural: stale.
    commit('package.json', '{}\n', 'manifesto'); commit('infra/main.tf', '\n', 'infra');
    const stale = await check();
    assert.equal(stale.fetched, true);
    assert.equal(stale.status, 'stale');
    assert.ok(stale.structural.includes('package.json') && stale.structural.includes('+ infra'), JSON.stringify(stale.structural));
    // The recorded commit left the history: the map's date finds the base commit it described.
    commit('docs/squad/.reconhecimento', `0123456789abcdef0123456789abcdef01234567\n${at}\n`, 'referência perdida');
    const byDate = await check();
    assert.equal(byDate.fallback, true);
    assert.equal(byDate.ref, base.slice(0, 12));
    // A base branch without the map.
    git('checkout', '-q', '--orphan', 'nomap'); git('rm', '-rq', '--cached', '.'); git('clean', '-fdq'); commit('x.txt', 'x\n', 'sem mapa');
    const other = 'op-042-nomap';
    await collect((await (await api('/api/runs', { method: 'POST', body: JSON.stringify({ prompt: 'x', options: { project: other, repo: 'nomap' } }) })).json()).runId);
    assert.equal((await check(false, 'nomap', other)).status, 'missing');
  } finally { rmSync(reposFile, { force: true }); }
});
