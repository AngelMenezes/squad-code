# App state, rendering and views (`src/app.js`)

Reference detail for Claude Code sessions, read on demand from the index in CLAUDE.md. When a change alters what a paragraph here describes, update it in the same commit.

**`src/app.js` (state, UI, orchestration).**
- One persisted `state` object (localStorage key `squad-code.network.v2`, export/import as JSON). Served by the bridge, the database
  copy is the truth (`diskSync`): the boot block takes `#squad-disk` unless the browser copy has pending saves on that same rev
  (`STORE_DISK` = `{rev, pending}` per origin); both changed or a never-synced browser copy that differs: the newer `wsActivity` wins and
  the other becomes a saved version. `save()` writes localStorage and queues `diskFlush` (250 ms, one PUT at a time, skipped when equal
  to `diskSync.last`; a version loaded from the database counts as saved, so opening a tab never writes). 409 → `diskConflict`: during
  a run this page forces its data, otherwise it backs up its JSON and `adoptDisk`s; `diskRefresh` (focus/visible, idle only) adopts what
  other tabs saved. Bridge down or old token: changes stay in the browser (`#storageState` says so) and reach the database on the next
  load. Configurações > Workspace lists the saved versions (`loadVersions`, **Restaurar** → `restoreVersion`); import and restore share
  `restoreWorkspace`, which first saves the current workspace as a version. Log and handoff ids survive normalization (`keepId`) and
  `log()`/output pushes use the normalized key order, so the row diff does not churn after a reload.
  First start (`#squad-disk.setup`): `diskSync.setup` keeps `diskSync.on` false and makes `save()` a no-op (the browser copy stays in
  `diskSync.localCopy`, untouched); the boot shows the example behind `openDbSetup`, a modal (kind `db-setup`, no close button,
  `closeModal` refuses it, so Esc does nothing) with the database path, the Claude status (`dbSetupStatusHTML`, refreshed by
  `checkBridge`) and four starts: **Começar do zero** (`#dbSetupForm` → `dbSetupFresh` → `freshWorkspace(name)`: the seed's agents and
  squad with one blank OP-001 built like `createOperation`, then the operation page), **Carregar exemplo** (`seedWorkspace`), **Importar
  backup** (`#dbSetupImport`) and **Recuperar a cópia deste navegador**. All go through `dbSetupCreate` (normalize + `migrateCatalogAgents`,
  `POST /api/setup`, then `diskSync.on`; an unpicked browser copy becomes a version; 409 reloads the page).
  `normalizeWorkspace` rebuilds it field by field from a whitelist: **a new persisted field must be
  added there (and to `seedWorkspace`), or it is dropped on reload/import.** Transient UI state lives
  in `ui`.
- `render()` is the central re-render. Full pages (`home`, `projects`, `squads`) render through
  `opsBlock(id, signature, html)`: a block's innerHTML is replaced only when its JSON signature changes,
  so background renders (runner ticks, logs) don't wipe inputs the user is typing in. Keep signatures
  free of values the user is editing.
- Interaction is delegated: one document `click` dispatcher switches on `data-action` (the element's
  `data-id` arrives as `agentId`), and a `submit` map routes by form id (`#agentForm → saveAgent`,
  `#projectForm → saveProject`, `#squadForm`, …).
- Modals: `showModal`/`closeModal` (`ui.modal`, `ui.draft`). The agent studio is a modal with tabs
  (`editorTab`). `confirmAction` itself opens a modal and replaces the current one — don't call it
  from inside the agent studio.
- Views (`ui.view`): `home` (Painel), `projects` (operations: briefing + features, all in-page),
  `network` (Squad map), `handoffs`, `squads` (Squad Studio, reached from Painel/HUD/key `G`). Agent Teams (the kickoff meetup,
  below) is a full-screen modal opened from the operation's briefing or from a Painel card.
  The SQUAD tab (nav button, Painel "Abrir rede do squad", Q/E) goes through `openSquadView`: with more than one operation and no
  run it asks whose squad to show (modal kind `op-pick`, `squad-view-op` → `squadViewOp` = `homeSwitch` + `goView('network')`);
  entry points that already name the operation ("Abrir no squad", agent links) go straight to the map.
  Painel project cards (`homeProjectCard`) show the operation's next step (`opNextStep(p)` → `{tone, label, detail, action, icon,
  text}`, first rule wins: run of this operation → `room`; base branch gone (`baseCheckOf`, `renderHome` calls `loadBaseCheck` once
  per repository) and pending merges → `home-open-features`; reviews → `home-open-review`; `runGaps` → `home-open-teams` live or
  `home-open-briefing`; a runnable current sprint (`depsReady`) or a done/empty one (→ `nextSprintOffer`) → `home-run`; blocked →
  `home-open-features`) as a `.home-next[data-tone]` strip and the primary button (`opNextButton`, also used by `homeRunHTML` when
  idle). The `home-*` actions go through `homeSwitch`, which refuses during a run. Below the cards: **EM EXECUÇÃO** (`homeRunHTML`:
  the run with its operation's code and name, or one idle line) and **AGUARDANDO SUA AÇÃO** (`homeActions`, every operation: the plan
  awaiting approval → `room`, reviews, pending merges one per operation and base branches gone one per repository → `home-open-features`;
  missing documentation stays on the cards), whose count is the header's "n itens aguardam sua ação". ATIVIDADE RECENTE lists every
  operation; with two or more, chips filter it by one (`home-activity`, `ui.homeActivity` transient, `homeActivityFilter` falls back to
  all for a deleted operation; the filter runs before the 14-line cut; the picked chip gets the focus back after the render).
  **REPOSITÓRIOS** (`homeReposHTML`, between operations and squads, only with the bridge and `ui.bridge.repos`): one card per
  registered repository (`homeRepoCard`: team map from `loadTeamMap` (5 min) / `teamMapOf`, or the base branch gone (`baseCheckOf`,
  then the primary button is "Trocar branch base" → Configurações > Repositórios), the operations on it as chips with their pending
  merges, **Nova operação aqui** → `homeRepoOp`: `openOpNew` with `repoId` and `existing` set, so step 2 opens on that repository)
  and a **Cadastrar repositório** card (`home-repo-add` → `openSettings('repos')` + `repoEdit('')`). The card also has **Abrir projeto**
  (`home-open-project`) and the Agent Teams icon (`home-open-teams` → `homeOpenTeams`: switches project, opens the operation page and
  `openAgentTeams`; without `liveMode()` it only shows the warning).
  Entering the Squad Studio or showing another squad (`ui.sqShown`, reset when the view changes) plays `sqBuild` once: the
  command tree draws itself (trunk with a spark, band lines, labels, buses, stubs, nodes), timed from the real layout through
  CSS custom properties under `.sq-build`, which is dropped at the end so the ambient pulses resume. Re-renders never replay it.
