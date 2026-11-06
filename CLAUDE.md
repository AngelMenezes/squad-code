# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SQUAD/CODE is a single-page web app for organizing a squad of software-development
agents (commander, ADR/PRD "reconhecedores", operators) that execute features through headless Claude
Code (`claude -p`). The bridge keeps the app's data in a local SQLite database (`better-sqlite3`, the only npm dependency). UI text is Portuguese (pt-BR); code identifiers are English. Git repo; `origin` is github.com/AngelMenezes/squad-code: every commit and push goes there.

## Commands

```sh
npm install                 # better-sqlite3 (prebuilt binary; Node >= 22)
npm run dev                 # build index.html from src/, start the bridge, rebuild on src/ changes, restart on server.js / db.js changes
npm start                   # node server.js → http://127.0.0.1:4317 (--port N or SQUAD_PORT; SQUAD_CLAUDE_BIN for another claude; SQUAD_PROJECTS_DIR for another projects root; SQUAD_DATA_DIR for another database folder)
python build.py [--copy]    # full build: regenerates src/avatars.js (needs Pillow), writes index.html (--copy: also ../squad-code-network.html)
npm test                    # bridge tests: node --test tests/bridge.test.mjs (uses tests/fake-claude.mjs, no API cost)
node --test --test-name-pattern "<test name>" tests/bridge.test.mjs   # single bridge test
node --check src/app.js     # quick syntax check after edits
python tests/ui_test.py     # optional UI tests, demo mode (needs Playwright + Chromium; CHROMIUM_EXECUTABLE, SQUAD_PREVIEW_DIR)
python tests/ui_bridge_test.py   # optional UI tests over a temporary bridge (node + git): first start, repositories, Painel
node scripts/vendor-three.mjs [version]   # regenerate src/vendor/three.min.js (only classes in scripts/three-entry.js)
```

UI tests read the built `index.html` (rebuild first), run with reduced motion and the low map quality (software WebGL in headless
Chromium), and write `ui-results.json`/`ui-bridge-results.json` with the screenshots to `previews/` (git-ignored). With more than
one operation the SQUAD tab asks whose squad to show (`view()` in the tests answers it).

`index.html` is a build artifact — never edit it; edit `src/` and rebuild. Opening `index.html` via
`file://` runs in demo mode (deterministic local simulation, no bridge). `npm run dev` does not
regenerate `src/avatars.js`; `python build.py` does (and the `../squad-code-network.html` copy only with `--copy`, so a
clone never writes outside its folder). `.claude/settings.json` denies Read/Grep on the generated and binary files (`index.html`,
`src/avatars.js`, `src/portraits.js`, `src/vendor/`, `assets/`): megabytes of data URLs and minified code that only waste context.

## Build model and its pitfalls

`build.py` / `scripts/dev.mjs` inline `src/styles.css` into `src/shell.html` and concatenate, **in this
order**, into one classic `<script>`: `portraits.js`, `avatars.js`, `conventions.js`,
`souls.js`, `vendor/three.min.js`, `city.js`, `app.js`. Consequences:
- Everything shares one global scope; `state`, `ui`, `MapNetwork`, `ICONS`, `ROLES`… are reachable
  from the page (handy for headless-browser checks; `window.SquadCode.getSnapshot()` returns a clone of
  the workspace).
- `app.js` initializes state at load time (`seedWorkspace` / `normalizeWorkspace`), so any helper used
  during initialization must be a **function declaration** (hoisted). A `const` arrow defined later in
  the file throws a TDZ `ReferenceError` and the whole app fails to boot.
- `src/app.js` is written in dense, minified-style long lines. Make edits by exact unique string
  replacement and re-run `node --check`; do not reformat the file.
- Asset pipeline: `scripts/build-avatars.py` turns `assets/*.png` into 320px JPEG data URLs in
  `src/avatars.js` (`avatar-<file-name>` keys merged into `PORTRAITS`). `src/portraits.js` holds the
  embedded role portraits. Template agents get their photo from `TEMPLATE_AVATARS` (codename → `PORTRAITS`
  key), not from a stored copy: `image` stays `''` ("Automático") and `portrait(a)` resolves it, falling back
  to the specialty's default agent (`rolePortrait`). A new asset or template needs an entry there.

## Architecture

- **`server.js` (bridge) + `db.js` (SQLite).** Serves `index.html` (per-start token injected), binds to 127.0.0.1, and every `/api`
  call needs the token plus a local Host/Origin. `/api/runs` spawns `claude -p` (stream-json) with the agent's system prompt in a
  temp file, the step prompt via stdin (never shell-interpolated) and whitelisted options (`validateRunOptions`); the person's MCP
  servers, skills and plugins stay out of the runs. Each operation runs in its own folder `projects/<folder>` (its own git repository,
  `GIT_CEILING_DIRECTORIES`, `claudeMdExcludes` so agents never see this app's CLAUDE.md) or, linked to a registered repository, in a
  clone with one worktree per feature (branch `squad/<feature>`). Agents never push. Data lives in `data/squad.db`, created only by
  the person (`POST /api/setup`).
- **`src/app.js`.** One persisted `state` (localStorage plus the database through `diskSync`), transient `ui`, the central
  `render()`, one delegated `click` dispatcher on `data-action` and a `submit` map by form id, modals, the chats and Agent Teams, the
  domain rules and the run orchestration (commander's plan → approval → route of agents → human review).
- **`src/city.js` (`MapNetwork`).** Three.js hexagonal city (flat or planet) and isometric office sharing the same agents, with HTML
  markers projected over the canvas and a 2D fallback without WebGL.

### Rules that break things when ignored

- A new persisted field goes into `normalizeWorkspace` (a whitelist) and `seedWorkspace`, or it is dropped on reload/import. A new
  child array of the workspace also needs an entry in `TREE` (`db.js`); plain fields need nothing.
- Full pages render through `opsBlock(id, signature, html)`: keep signatures free of values the user is editing.
- `confirmAction` opens a modal and replaces the current one: never call it from the agent studio, Agent Teams (`#atConfirm`) or
  anything else that must stay open.
- Wherever an agent's instructions leave the app (live runs, command preview, `.md` export) use `agentSystemPrompt(a)`, not `a.prompt`.
- Change membership through the squad: `project.agentIds`/`commanderId` are derived mirrors (`applySquad`/`syncSquad`). A squad has
  exactly one commander, one ADR, one PRD and ≥1 operator; positions (`hex`, `desk`) are unique per squad.
- Operation codes are never reused (`nextOpCode`, `settings.opSeq`) and `project.folder` is set once at creation, never renamed.
- The F00 (setup, or reconnaissance in a linked operation) stays first and blocks the other features until approved (`ensureSetup`),
  except in the direct and team modes.
- Changing a catalog prompt, soul or greeting list: keep the previous fingerprint in `PROMPT_PREV` / `SOUL_PREV` / `SOUL_HELLOS_PREV`
  so unedited agents migrate. Coding style lives in the DIRETRIZES (`style-<lang>` subsets), never in a system prompt.
- Agent Teams: a host's system prompt must be identical on every turn of the meeting (built from `c.hosts` only); what changes goes in
  `docCoWritePrompt`, or the prompt cache is written again on each turn.
- A run with neither `project` nor `cwd` is refused (never `process.cwd()`, the app folder); every agent run disallows
  `Bash(git push:*)`, and pushes only happen from a person's action.
- UI text is pt-BR; agent chat replies never use dashes (`soulBlock`, `chatClean`).

### Where the details are

Read the file for the area before changing it (`docs/arquitetura/`, moved verbatim from this file):

| When you touch | Read |
|---|---|
| Runs and their options, isolation, project folders, linked repositories, worktrees, map freshness, team map, base branch, merges, push and publish, toolchains, squad colleagues (`--agents`) | [bridge.md](docs/arquitetura/bridge.md) |
| The database, first start, workspace sync, versions, room/chat memory, run history, attachments table | [dados.md](docs/arquitetura/dados.md) |
| `state`/`diskSync`/first-start modal, `render()`/`opsBlock`, actions, modals, views, Painel, Squad Studio animation | [app.md](docs/arquitetura/app.md) |
| Co-writing and agent chats, Agent Teams | [chats.md](docs/arquitetura/chats.md) |
| Squads, positions, the Nova operação wizard, codes and folders, sprints, F00/reconnaissance, new vs linked repository, merges in the UI, export, attachments UI, review desk, writing tools, routes, agents, models, SOUL, DIRETRIZES, catalog migrations | [dominio.md](docs/arquitetura/dominio.md) |
| Execution path, `runGate`, commander's plan, sprint proposals, operation room and chat, calls between agents | [execucao.md](docs/arquitetura/execucao.md) |
| `city.js`: city, office, morph, planet mode, rendering and quality, office life, the run in the office and city | [mapa-3d.md](docs/arquitetura/mapa-3d.md) |

The person-facing guide is [docs/GUIA.md](docs/GUIA.md) (pt-BR) and setup is in the [README](README.md).
