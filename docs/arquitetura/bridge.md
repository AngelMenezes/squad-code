# Bridge (`server.js`)

Reference detail for Claude Code sessions, read on demand from the index in CLAUDE.md. When a change alters what a paragraph here describes, update it in the same commit.

**`server.js` (bridge) + `db.js` (SQLite).** Serves `index.html` (injecting a per-start random token), binds to
127.0.0.1 only, and every `/api` call needs the token plus local Host/Origin. `/api/runs` spawns
`claude -p --output-format stream-json --verbose --permission-prompts none --strict-mcp-config --disable-slash-commands` (the person's
MCP servers, claude.ai connectors and skills stay out; project runs also get `enabledPlugins: {<id>: false}` in their `--settings`
file from `userPlugins`, `claude plugin list --json` cached `PLUGIN_TTL`, warmed at start), writes the agent's system
prompt to a temp file passed as `--append-system-prompt-file`, sends the step prompt via **stdin**
(never shell-interpolated), and streams events back. Options (permission mode, effort, tools, model,
dirs, budget, `partial` → `--include-partial-messages`) are whitelisted. Limits: body 2 MB, prompt 400k chars, system prompt 100k (silently
sliced). Every event of a run gets its number `n` (`pushEvent`); `GET /api/runs/<id>/events?after=n` replays only the later ones, so
`streamRun` (app) reconnects after a dropped stream without repeating events. The default `timeoutSec` is 2400. It also reads/writes Claude `settings.json` files (user/project/local) with a `.bak` copy.
Every project runs in its own folder: the `project` option (a plain slug, `FOLDER_RE`, no Windows reserved names) becomes the
cwd `<PROJECTS_DIR>/<folder>` (`./projects` next to `server.js`, created at start; `SQUAD_PROJECTS_DIR` for tests), created on the
first run. Because Claude Code loads CLAUDE.md from every folder above the cwd, those runs also get `--settings <temp file>` with
`claudeMdExcludes` (`APP_MEMORY_EXCLUDES`) so agents never see this app's own CLAUDE.md/AGENTS.md/rules. Each project folder is its
own git repository (`ensureProjectRepo`: `git init` before a run when `.git` is missing, always on branch `main` via `symbolic-ref`; skipped without git) and project runs get
`GIT_CEILING_DIRECTORIES` = PROJECTS_DIR (`gitCeiling`), so Claude Code (git status, `.claude/settings.json` from the repo root outside
Windows) and the agents' git commands never reach the enclosing repository (this app's clone). The same settings file sets
`permissions.blockReadsOutsideWorkingDirectories`, so the file tools refuse reads outside the folder (and `--add-dir`). It also makes Claude Code ask for approval of any Bash
command whose paths it cannot check (loops, command substitution), which a step denies unrun: project runs with Bash (or every tool)
get `SHELL_NOTE` at the end of the prompt (simple commands only, one call per repetition), and `denialNotes` explains it. Linked operations: the `repo` option (an id of `REPOS_FILE` = `SQUAD_REPOS` or `data/repos.json`, `loadRepos`/`repoEntry`, read on every
use; entries `{id, name, path | url, subdir, baseBranch, prepare}`; written only by `PUT|DELETE /api/repos/:id` (`saveRepoEntry`,
`.bak` copy, unknown fields kept, a broken file is a 409 and never overwritten), `GET /api/repos` (`reposListing`: paths, URLs masked by
`maskUrl`); URLs with userinfo are refused from the page (`CRED_URL_RE`)). **Monorepo:** `subdir`, or a `path` inside a repository
(`repoRootOf` walks up to the `.git`; saved as the root plus the subfolder), scopes the operation to that folder of the clone: plans and
chats run in `<clone>/<subdir>`, steps in `<worktree>/<subdir>` (a missing one ends the preparing phase with an error), `prepare` runs
there, and every repository path the bridge reads goes through `repoPath(repo, p)` (map, `.reconhecimento`, conventions, plan paths,
export); `mapStatus(cwd, target, sub)` diffs with `--relative=<sub>`, and `commitStep` adds only `-- <subdir>`. It replaces the `git init`: `checkProjectClone` (before the
answer, so refusals are a 400) accepts an empty folder or one holding only the empty repository of an earlier `git init` (to be cloned)
and a clone of the same origin (reused), and refuses anything else. The clone, the feature's worktree and its prepare command run
after the answer as the run's preparing phase (`prepareRun`, `run.phase` 'preparing' → 'running', `launchRun` spawns claude after it,
`endRun` ends a run once from either phase): `bridge`/`prepare` events per step (clone, fetch, worktree, prepare) and `prepare-log`
with the command output; the run counts as active from the start, cancel kills the current git/prepare process (`run.prepChild`,
`gitRun`'s `track`), and a failed step ends the run as an error without starting claude; such runs get `Bash(git push:*)` in `disallowedTools`. With `feature` (a slug; `featureBase` = the F00's)
the step runs in that feature's worktree `<clone>/.wt/<feature>` on branch `squad/<feature>` (`ensureWorktree`: reused when present,
else the existing branch or a new one from the fetched `origin/<baseBranch>`, or from `squad/<featureBase>` while
`docs/squad/mapa.md` is not on the base; `.wt/` goes to the clone's `info/exclude`), whose new worktrees run the entry's `prepare`
command once (`prepareWorktree`, marker in `.git/squad-prepared-<feature>`, 15 min); the clone's own CLAUDE.md files join
`claudeMdExcludes`, and a `bridge`/`worktree` event reports branch, notes and prepare. `DELETE /api/worktrees/:folder/:feature`
(`removeWorktree`, 409 with uncommitted work) removes it and keeps the branch. Map freshness (`mapStatus`, git only): the commit in
`docs/squad/.reconhecimento` (or, if it left the history, the last base commit before the date there) against `origin/<baseBranch>`,
outside `docs/squad`: 'fresh', 'changed', 'stale' (`STRUCTURAL_RE` paths, top-level folders added/removed, or > `MAP_SMALL`
files), 'unknown', 'missing'. Feature steps get a `bridge`/`map` event and, unless fresh/missing, the changed files appended to
their prompt (`mapPromptNote` → `run.promptExtra`); `GET /api/map/:folder?repo=<id>[&fetch=1]` answers the same for the page. **Team map:** `GET /api/repos/:id/map[?refresh=1]`
(`teamMapInfo`, no operation clone needed, cached `TEAM_TTL`, one lookup per repository at a time) reads the base branch of a
registered repository (a local one in place, at the ref its clones start from; a URL through a shallow blobless bare clone in
`PROJECTS_DIR/.cache/<id>.git`): `map` (`.reconhecimento` or `mapa.md` there), `commit`, `date`, `docs` (`docs/squad/projeto.json`
through `cleanTeamDocs`: vision, scopeIn, scopeOut, glossary, architecture, complete ADRs) and, without a map, `pending` (`squad/f00-*`
branches on the origin, from `ls-remote`). `POST /api/team-docs/:folder {repo, feature, docs}` (`writeTeamDocs`) writes `projeto.json`
into that feature's worktree and commits it only when it changed (409 without the worktree or `docs/squad`). **Base branch on the
origin:** `GET /api/repos/:id/base[?refresh=1]` (`baseCheck`, `ls-remote --symref`, cached `BASE_TTL`) answers 'default' (empty
`baseBranch`, never a warning), 'ok', 'missing' (the configured branch is gone from the origin, e.g. a release branch after the
release) or 'unknown' (origin unreachable, never 'missing'), with `default` and `branches` (no `squad/*`, `baseOrder`: default, same
prefix as the old branch newest first by natural order, the rest); no naming rule. `ensureWorktree` checks the clone's origin after a
successful fetch and refuses a new feature whose base is gone (fetch does not prune, so the old copy would be used); existing
worktrees keep running. `PUT|DELETE /api/repos/:id` drop the id's `teamMaps`/`baseChecks` cache.
With `&branches=squad/a,...` it also answers `merges` (`mergeState`: merged by history, or by content after a squash/rebase when
some base commit since the fork point (newest 60 touching those files) had every file the branch changed exactly as the branch has
it, so later changes to them do not hide the merge; `empty` when the branch has no commits since `startMark`, written at worktree
creation and kept). Agents never push: `guardClone` (before every linked run) sets `remote.origin.pushurl` to `NO_PUSH_URL` and
writes the `PRE_PUSH` hook, which only lets a push through with `SQUAD_BRIDGE_PUSH=1`; `POST /api/branches/:folder/push {repo,
branch}` (`BRANCH_NAME_RE`, person-initiated) pushes to the origin's fetch URL with that mark and returns `pr` (`prUrl`, GitHub
origins) and `local`. `POST /api/paths/:folder {repo, paths}` checks paths on the base branch (`git cat-file -e`; unsafe ones are
false; `checked:false` before the clone). A successful feature step of a linked operation is committed by the bridge before the run
ends (`commitStep` from the close handler, `run.stepCommit` set by `prepareRun`; `git add -A`, message `SQUAD/CODE: <label>`, the
person's git identity or SQUAD/CODE, the repository's hooks run; `bridge`/`commit` event with the files, `commit:null` when nothing
changed, `error` when refused). With `mapRef` (map features) it first writes `docs/squad/.reconhecimento` (`commit=<startMark>`,
`branch_base`, `data`) when `docs/squad` exists, only if the reference changed. With `conventions: 'repo'|'squad'` (other feature
steps) `conventionsNote` appends the operation's code standard, built from `docs/squad/convencoes.md` on the base branch only (the
approved one, never the worktree's draft). `withMap: true` (plan runs) appends
`docs/squad/mapa.md` from the base, or the clone, plus the change list (`mapForPlan`). `/api/health` sends `repos` (`publicRepos`: ids,
names, branches, subfolders, errors; never the path or URL). **New projects** (no `repo`): a feature step sent with `commit: true` gets
the same `commitStep` in the operation folder (`run.stepCommit` with `repo: null`); every project run disallows `Bash(git push:*)`.
`POST /api/publish/:folder {remote}` (person-initiated; `remote` = https/ssh/git@ URL without userinfo, or an existing absolute path)
sets `origin` (marked `squad.publish`, refused with 409 on a linked clone, whose origin is the registered repository, and before the
first commit), applies `guardClone`, pushes the current branch to the URL with `SQUAD_BRIDGE_PUSH=1` and answers `{branch, commit,
dirty, web}` (`webUrl`); later runs of a folder with an origin get `guardClone` too. The push is never forced: when the remote
branch (`ls-remote`) is not an ancestor of HEAD it is fetched and classified with a 409 `code`: `remote-ahead` (shared history,
with `commits`: pull in the folder), `remote-has-work` (unrelated history beyond a starter commit: register it in Repositórios),
`remote-starter` (one commit with only `STARTER_RE` files, the README/LICENSE/.gitignore a host creates; `files`). With `integrate:
true` a starter is joined (`merge -s ours --allow-unrelated-histories`, files only the remote has are checked out unless the folder
has one on disk, `merge --abort` on failure) and then pushed; `publishProject` asks first ("Integrar e enviar", `bridgeFetch` errors
carry `code` and `body`). **Toolchains:** `GET /api/toolchains[?refresh=1]`
runs each `TOOLCHAINS` entry's version command (`resolveBin` + `spawnBin`, `detectTool`; git, node, python, dotnet SDKs, javac, go,
flutter, cargo, docker; a launcher whose output has no version, like the .NET runtime without an SDK, counts as missing), cached for
`TOOL_TTL` (`toolchains`); never installs anything. `withEnv: true` (plans and feature steps) appends `envNote` (found tools and
versions, missing ones, "do not pretend") after `promptExtra` (`run.envNote`). An explicit `cwd` stays as a fallback
(tests, direct API use); a run with neither `project` nor `cwd` is refused (never `process.cwd()`, the app folder). The step prompt
(`buildStepPrompt`) and `CALLED_AGENT_SYSTEM` tell agents to keep every file inside the folder. The settings.json project/local scopes
take `project=` as well.

Squad colleagues: the `agents` option (whitelisted CLI subagent fields: `description`, `prompt`, `tools`, `model`, `effort`) is written
to a temp file passed as `--agents <file>`, and `forwardSubagents:true` adds `--forward-subagent-text`. Runs with agents get
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so an `Agent` tool call runs in the foreground and its tool_result is the colleague's
report (framed as "[Subagent hand-back] ... The report follows:" with indented lines; `subagentReport` unwraps it).
