# Database and persistence (`db.js`)

Reference detail for Claude Code sessions, read on demand from the index in CLAUDE.md. When a change alters what a paragraph here describes, update it in the same commit.

Data: `db.js` (`openStore(DATA_DIR)`, `SQUAD_DATA_DIR`, default `./data`, git-ignored) opens `squad.db` (WAL, foreign keys, migrations
by `user_version`); without better-sqlite3 the bridge exits at start telling to run `npm install` (`driverError`). **The database is
created only by the person:** at start (inside the `listen` callback, so a second bridge on a busy port exits with a clear message
before touching it) `openDb()` runs only if `squad.db` or a legacy `workspace.json` exists. Otherwise `store` stays null and nothing is
written: `setupNeeded()` (no store, or no workspace row) sets `setup:true` in `#squad-disk` and `dbReady:false` in `/api/health`;
`PUT /api/workspace` answers 503 and versions/rooms/chats go through `needStore()` (503); runs still work, out of the history.
`POST /api/setup` (`checkWorkspace` before any disk write, 409 once a workspace exists) opens the store and writes the first workspace.
The startup log also checks Node ≥ 22 and the `claude` executable (`claudeVersion`). **Workspace:** one table per entity under a
root row (`TREE`: agents, convention_templates/subsets, squads, projects → adrs, sprints, features → feature_outputs, logs, handoffs).
Each row keeps the entity's own JSON (`data`) with child arrays left as `[]` in place, so assembly is byte-identical to what the page
sent (no field list besides `normalizeWorkspace`), plus `json_extract` generated columns for SQL. **A new child array of the workspace
needs an entry in `TREE`**; plain fields need nothing. `syncWorkspace` (one `.immediate()` transaction) diffs rows by `(parent, key)`
and hash (`key` = id, `#n` for missing/duplicate ids, outputs `at|agentId`; positions are append-aware), never `INSERT OR REPLACE`.
Contract kept from the file version: `serveIndex` injects `<script type="application/json" id="squad-disk">` (`{rev, savedAt, path,
workspace, error, setup}`, every `<` escaped, function replacement because the text may hold `$&`); `GET /api/workspace` (`?meta=1` without
the workspace), `PUT /api/workspace?base=<rev>` (64 MB; a stale `base` gets 409 unless `force=1`; returns `changes`/`unchanged`; `rev`
is 16 random hex per changing write), `POST /api/workspace/backups`. **Versions** (`snapshots`, deflated JSON, newest 30): the previous
workspace on the first changing write of each bridge start and on `force`, browser copies (`navegador`), the migration; `GET
/api/workspace/snapshots[/:id]`. On first start a `data/workspace.json` (+ `backups/*.json`) is imported (rev = sha1-16 of the file
text, so browsers still match) and the files move to `data/legacy-json/`. A second tag `#squad-memory` carries `{rooms, chats}` (last
200 room messages per project; `sweep` first drops chats/rooms of features, agents or projects that no longer exist). `POST
/api/rooms/:projectId` `{seq, upserts, removes}` (ids `rm<n>`, texts cut to the room's limits, 800 kept); `PUT|DELETE
/api/chats/:kind/:key` (feature, agent, doc; 300 messages kept). Runs: `insertRun` at spawn (`body.meta` whitelisted by `runMeta`:
projectId, agentId, featureId, kind), events batched every 200 ms (`persistEvent`; no `stream_event`, tool results cut at 4000, exit
always kept); `pushEvent` first runs `leanEvent`: base64 images/PDFs an agent reads (tool_result blocks and `tool_use_result`) become a
short note, so neither memory, SSE nor the history ever hold them, `finishRun` on close; at start runs left `running` become `interrupted` with a synthetic exit event; newest 300 kept.
`GET /api/runs` (`?projectId`, `limit`) lists the history, and `/api/runs/:id[/events]` fall back to it for runs not in memory; the
console's **Histórico** (`openConsoleHistory` → `replayRun`, client `runMeta` on the four `POST /api/runs`) replays them.
**Feature attachments** (a collection, a contract the team sent, a screenshot, a spec in PDF): table `attachments` (migration
`user_version` 2, outside the workspace sync; text up to `ATTACH_MAX` 512 KB; migration 3 adds `mime`, `data` (BLOB) and `note`:
images PNG/JPEG/GIF/WebP up to 1,5 MB and PDF up to 5 MB (`ATTACH_MEDIA`, checked by their first bytes, the extension follows the
type so the agent's Read tool opens them); 20 per feature, `attachName` strips paths and reserved names, same name in a feature
replaces). `POST /api/attachments {projectId, featureId, name, text | data (base64) + mime, note}` (body up to `ATTACH_BODY` 8 MB),
`GET ?ids=` (which ones this database has), `GET /:id` (binary as base64; `?raw=1` the file itself with `Content-Security-Policy:
sandbox`, for thumbnails, `?token=` works), `PATCH /:id {note}` (`noteAttachment`), `DELETE /:id`; `sweep` drops those of features
that no longer exist. A step sent with `attachments: [ids]` gets them written by `placeAttachments`
(after the preparing phase, before claude) to `<cwd>/.squad-code/anexos/`, replacing what an earlier step left (`[]` clears it), with
`.squad-code/` in the repository's `info/exclude` (`git rev-parse --git-common-dir`, so every worktree and a monorepo subfolder are
covered): git status, `commitStep` and `removeWorktree` never see them. A `bridge`/`attachments` event lists them (`missing` count) and
`attachNote` appends their paths to the prompt (with the kind, the person's description, and for images/PDFs how to open them with Read).
