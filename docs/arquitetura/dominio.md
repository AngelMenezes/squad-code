# Domain model

Reference detail for Claude Code sessions, read on demand from the index in CLAUDE.md. When a change alters what a paragraph here describes, update it in the same commit.

**Domain model.**
- Positions (`a.hex`, `a.desk`) are unique per squad, not per workspace: `takenHexes`/`takenDesks` only look at `squad()`
  (the active squad), the map gets no other agents, loading only fixes invalid positions, and `render()` runs
  `resolveSlots(team)` so an agent that joins a squad on a used spot moves to the nearest free one.
- Squad = `{name, commanderId, adrId, prdId, operatorIds}`: exactly one commander (role `commander`),
  one ADR (`architect`) and one PRD (`po`) reconhecedor, ≥1 operator (`squadMissing`/`slotFits`).
  A double click on a free hex/desk (`onCreateAt`) opens the studio with `squadId` (`ui.draft.squadId`); `saveAgent`
  puts that new agent into the squad (`squadJoinSlot`/`squadJoin`: operator, the ADR/PRD seat if it is free, a second
  commander is refused) and into an open Squad Studio draft of it. "Novo agente" (key `A`) still creates it outside squads.
- **Nova operação** (`project-new` → `openProjectEditor()` → `openOpNew`) is a three-step wizard in a modal (kind `op-new`, `ui.opNew`
  `{name, repoId, reconMode, remote}`): the name (`#opNewForm` → `opNewNext`), where the code comes from (`opNewCodeStep`,
  `#opNewCodeForm` → `opNewCode`: a new project with an optional remote, checked by `remoteProblem`, or a registered repository with
  reconnaissance or direct work; the sub-fields follow the radios through CSS `:has`; with the bridge "Repositório existente" is always
  enabled and registers a repository in place (`opNewRepoAddHTML`, shown with none registered or after `op-new-repo-add`; fields
  `repoSource`/`repoName`/`repoKey`/..., name and identifier suggested by `repoNameOf`/`repoIdFor`; `opNewRegister`, also reached by
  Enter through `opNewCode`, PUTs with `registerRepo`, errors in `#opNewRepoErr`, then `checkBridge` and the step comes back with it
  selected; `opNewKeep` saves remote/kind/repository into `ui.opNew` before any redraw; `opNewCodeStep(focus)` sets `autofocus`,
  since `showModal` focuses in a rAF)), then an existing squad (`op-new-existing` →
  `#opNewSquadForm` with `squadPickerHTML` → `opNewCreate`) or a new one (`op-new-squad` → `opNewNewSquad`: `ui.opPending={...ui.opNew}` +
  `newSquad()`; the Studio tags the draft and `saveSquad` creates the operation with the new squad; cancelling, picking another squad or
  leaving the Studio drops `ui.opPending`). `op-new-back`/`op-new-back-code` keep the choices.
  `createOperation(name, sq, msg, code)` creates and persists it at once (`blankProject`, the code choice, folder, "Sprint 01", empty briefing); the briefing is not
  required by `saveProject`, `projectGaps`/`runGate` block runs until it is filled. The older inline draft (`ui.opsNew`, the
  `creating` branches of the projects page) no longer has an entry point.
- A project/operation references exactly one `squadId` (required in `saveProject`; `deleteSquad` refuses a
  squad in use); `project.agentIds`/`commanderId` are **derived mirrors** kept by `applySquad`/`syncSquad` —
  change membership through the squad, not the project. Projects also carry documentation fields (`vision`,
  `scopeIn`, `scopeOut`, `glossary`, `architecture`, `adrs[]`) and features carry `tasks`.
- Operation codes (`OP-001`...) are never reused: `blankProject` takes `nextOpCode()` (highest of `settings.opSeq` and the codes in
  use, plus one) and `addProject` (the only `state.projects.push`) records it in `settings.opSeq` (persisted; `normalizeWorkspace`
  keeps the larger of the stored value and the codes in the backup). Existing codes are never renumbered: folders carry them.
- Project folder: `project.folder` (persisted, `projectFolderName` = `<code>-<name>` slug, unique; `normalizeWorkspace` derives it
  for older backups) is set once by `createOperation` at creation and never follows a rename; deleting the project keeps the folder on
  disk. `runOptionsFor(a,r,p)` sends it as `project`, so live steps and chats run in `projects/<folder>` (`projectDirLabel` shows
  it). There is no global working directory: the runtime has no `cwd` field.
- Sprints: `project.sprints` (ordered `{id,name,goal}`, ≥1, max 50) and `feature.sprintId`: every feature is in exactly one
  sprint (`sprintOf`, `sprintFeatures`); `normalizeWorkspace` creates "Sprint 01" for backups without sprints and sends orphans
  to the first. The list view renders sprints as accordions, collapsed by default (`ui.sprintOpen`), with a cube SVG
  (`sprintCubeSVG`) rooting a tree of `.sprint-node` rows (trunk and branches are the node's pseudo-elements, the dot takes the
  status color); `setSprintOpen` opens one and plays `.drawing` once (`ui.sprintDraw`: cube, trunk with a spark, branches,
  rows), which re-renders never replay. Dragging a row onto
  another sprint (`moveFeatureToSprint`) keeps route and status, the editor's SPRINT select goes through `saveFeature` (resets
  the route). `currentSprint` = first sprint with a feature not done.
- Project setup: every operation's first feature is **F00 Setup do projeto** (`feature.setup === true`, scope `setup` → architect,
  backend, frontend, qa; `SETUP_FEATURE`, `SETUP_BRIEF`). `ensureSetup(p)` keeps it first in `p.features`, in the first sprint, with
  no dependencies, and puts it in every other feature's `dependencies` (ready ones become blocked until it is done), so nothing else
  runs before it is approved. It runs in `createOperation`, `saveProject`, `saveFeature` and `normalizeWorkspace` (older workspaces
  get it in backlog; the boot then writes the database at once, `diskSync.migrated`). It cannot be deleted, dragged or moved to another
  sprint; the editor locks its sprint and shows it as a fixed dependency of new features (`featureDraftFor`). The seed's F00 is done.
- Toolchains: `ui.toolchains` (transient, `loadToolchains` once after `checkBridge` and on `env-refresh`) feeds Configurações >
  Ambiente (tab `env`, `renderEnvPane`) and `envNoticeHTML` in the features head: the tools whose `STACK_HINTS` match the project's
  architecture (once written; before that, briefing and scope; never the ADRs, which compare discarded options) and are not
  installed; a mention negated in its own clause ("Java não é uma opção", `STACK_NEG` in `stackNamed`) does not count. `executeLiveStep` and the commander's plan send `withEnv: true`. The setup
  F00 asks for the README's prerequisites with exact versions (`SETUP_PREV` keeps the earlier criteria/tasks for `ensureSetup`).
- New project (no `repoId`): `executeLiveStep` sends `commit: true`, so the bridge commits each step in the operation folder.
  `project.remote` (persisted; wizard or the briefing's REPOSITÓRIO REMOTO, `.if-new`) is where **Enviar para o remoto**
  (`publishNoticeHTML` in the features head, shown once a live output exists; `publishProject` → `/api/publish`) sends it;
  `project.published` `{at, branch, commit}` (persisted) keeps the last send, `ui.publishWeb` its web link.
- Existing repository: `project.repoId` (persisted; chosen in the wizard or the briefing's REPOSITÓRIO EXISTENTE, `repoFieldHTML`, from
  `ui.bridge.repos`; fixed once a feature has an output, `repoLocked`) goes to the bridge as `repo` in `runOptionsFor`. Repositories are
  registered in Configurações > Repositórios (tab `repos`: `loadRepoList`, `renderRepoPane`, `#repoForm` → `saveRepo` → `registerRepo`, `repoDelete` with
  a second click to confirm; the identifier field is named `key`, since a control named `id` would shadow `form.id` in the submit router).
  `project.reconMode` (persisted, 'map' | 'direct' | 'team', RECONHECIMENTO in the briefing, `.if-linked`, locked like the repository):
  `teamMode(p)` = linked + 'team' (the team's map, docs/squad from another developer's merged reconnaissance, is on the base branch):
  no F00 and no tokens spent mapping again; `skipRecon` (direct or team) drives `ensureSetup`, `runGaps` and `runGate`, and team steps
  get the regular "read docs/squad" section of `buildStepPrompt`. `ui.teamMaps[repoId]` (transient, `loadTeamMap`: renders ask once,
  the wizard after a minute, "Verificar" refreshes the bridge) feeds the wizard (`opNewReconHTML` in `#opNewRecon`: with a map,
  "Usar o mapa da equipe" is preselected and "Refazer o reconhecimento completo" is a quiet `.op-recon-redo` line; without one, a
  warning lists the pending reconnaissance branches; `ui.opNew.reconMode` holds only an explicit pick, a change of repository resets
  it), the briefing select (`reconOptionsHTML`/`reconHint`, patched in place by `projectReconRefresh`) and `mapNoticeHTML` ("Usar o
  mapa da equipe" → `useTeamMap` for an untouched recon F00 or direct work). Choosing it imports `projeto.json` into the empty fields
  (`applyTeamDocs`, ADRs only when there are none); approving a map feature (recon F00 or `mapUpdate`) first sends the reviewed
  documentation (`sendTeamDocs` → `/api/team-docs`, `teamDocsOf`) and then removes the worktree, so it reaches the base with the map.
  `directMode(p)` = linked + 'direct' (e.g. a fix): `ensureSetup` drops an untouched F00 (and unblocks what only waited for it) and
  creates none, runs need only `reconGaps` (`runGaps`, used by `runGate`, the features head and the commander chat), the steps get the
  "sem reconhecimento" section of `buildStepPrompt`, and `mapNoticeHTML` offers **Fazer reconhecimento** (`startRecon`: back to 'map',
  `ensureSetup` creates the F00 and the features not started wait for it). With 'map' its F00 is
  **Reconhecimento do projeto** (`RECON_FEATURE`, `setupDef`; `ensureSetup` swaps an untouched F00 both ways; `isRecon`,
  `RECON_BRIEF`; squad-agnostic: commands come from the project files and are marked verified only by an agent with Bash, unverified
  never blocks approval, `RECON_CMD` keeps the earlier criteria/tasks line so `ensureSetup` updates an untouched F00): the agents map the code into `docs/squad/` (with `.reconhecimento`, the base commit), and a ```json `{"docs":{...}}` block at the end of a step fills the project fields still empty
  (`applyReconDocs`, ADRs only when there are none). `runGate(p, f)`: while that F00 is pending and the documentation is incomplete
  (`reconOnly`), runs take F00 alone and need only name, briefing and squad (`reconGaps`); `startRun`, `openSpawn`/`spawnAgent` and the
  commander chat follow it. Later steps of a linked operation are told to read `docs/squad` before exploring (`buildStepPrompt`).
  Every step of a linked operation (`executeLiveStep`, spawn included) goes through `linkedStepOptions`: `feature: featureSlug(f)` (key
  + id tail, stable across renames) and `featureBase` (the F00's), so it runs in that feature's worktree; map features (recon F00,
  `mapUpdate`) add `mapRef`, `permissionMode: 'dontAsk'`, Write/Edit in `tools` and only `Write(docs/squad/**)`/`Edit(docs/squad/**)` in
  `allowedTools` (plain write tools removed), so even an agent without Write writes there and nowhere else; the other features send
  `conventions` = `project.codeStandard` ('repo' default | 'squad'; persisted, PADRÃO DE CÓDIGO in `repoFieldHTML`). The prompts say
  the bridge commits and writes `.reconhecimento` (no git asked of agents), and `commanderPlanPrompt` lists each colleague's tools (and marks map features, where everyone writes `docs/squad`);
  the console shows the `commit` event and the room only a refused commit; the room and the console show the `worktree` event
  and the preparing phase (`prepare` steps as the typing line, `PREP_TYPING`, and a note for the prepare command; `prepare-log` in the console),
  and `approveFeature` asks the bridge to remove the worktree (the branch stays for the PR). `ui.baseChecks[repoId]` (transient,
`loadBaseCheck`: once per render, refreshed by `mapCheck` with fetch, and for every repository in Configurações > Repositórios, which
marks the row and fills the BRANCH BASE `datalist`) feeds `baseNoticeHTML` in the features head (only when 'missing'): a select of
the bridge's suggestions and **Trocar branch base** (`baseSwitch`: confirmAction listing the pending merges of every operation on
that repository, then `PUT /api/repos/:id` with the new `baseBranch`, so it applies to all of them). The operation page keeps the map state
  in `ui.mapStatus` (transient; `mapCheck` from the features head render and "Verificar", and every step's `map` event against the
  base) and shows `mapNoticeHTML`; **Atualizar mapa** (`createMapUpdate`) adds one feature with `mapUpdate: true` (persisted, scope
  `architect`, `MAP_UPDATE_FEATURE`/`MAP_UPDATE_BRIEF`, its own section in `buildStepPrompt`) that rewrites only the affected parts
  of `docs/squad` from the list the bridge appends.
  Merges: approving a feature of a linked operation sets `f.merge = {branch, state:'pending', at}` (persisted, normalized); it lands
  only when merged (`featureLanded`, used by `depsReady`/`pendingDeps`/`blockedWhy`), so dependents wait ("Aguarda merge" on the
  kanban). `mapCheck` sends the pending branches and `applyMerges` lands the merged ones; `mergeNoticeHTML` (shown during runs too)
  offers **Enviar branch** (`pushBranch`, confirmAction, PR link in `ui.mergePr`), **Marcar como mergeada** (`markMerged`) and
  **Verificar merges**; `mergeRefresh` (window focus/visible) checks with fetch, quietly, at most every 2 minutes while merges are
  pending. The commander's plan of a linked operation runs with `withMap` and asks for `files` per codename; `checkPlanPaths` has the
  bridge check them on the base before the plan card (missing ones are listed in the room), and `validatePlan(data, suggest, keep)`
  drops unsafe and missing paths and closes each brief with "Comece lendo: ...".
- **Exportar** (operation header) → `exportProject`/`projectExportFiles`: a store-only `.zip` (`zipFiles`) with
  `CLAUDE.md`, `docs/{project,architecture,standards,features/<NNN-slug>}` and `.claude/{agents,commands,settings.json}`.
  `docs/standards` is compiled from the squad's DIRETRIZES (`STANDARD_FILES`); simulated-only progress exports as
  `backlog`. The DIRETRIZES catalog paths (ADR/PRD/C4) follow the same `docs/` layout.
  A linked operation (`repoId`) never exports over the team's files: `openLinkedExport` offers a `.zip` (`exportLinkedZip`) or a
  branch (`exportLinkedBranch` → `POST /api/export/:folder`), both from `linkedExportFiles`, which moves every file to the squad's
  places (`docs/squad/CLAUDE.squad.md`, `docs/squad/{project,...}`, `.claude/agents/squad-*`, `.claude/commands/squad-*`,
  `docs/squad/settings.squad.json`, plus `docs/squad/LEIA-ME.md`) and rewrites the references in the texts to match (root-relative
  links in the squad file). The bridge writes them in a new `squad/exportacao-<timestamp>` worktree (only those places; the map
  files are never written; `CLAUDE.md` = `SQUAD_IMPORT` only when the repository has none), commits, removes the worktree and drops
  the branch when nothing changed (line endings ignored). `showExportResult` reports it and **Enviar branch** goes through
  `pushSquadBranch` (shared with the merge notice).
- Feature attachments: ANEXOS in the feature editor (`feAttachHTML` in `#feAttach`, `#feAttachInput`, bridge only). `f.attachments`
  (persisted, normalized) holds `{id, name, size, sha, at, summary, masked, mime, note}`; the file lives in the bridge's table. Images and
  PDFs (`attachFileKind`; also pasted with Ctrl+V anywhere in the editor, or dropped on `#feAttach`) go through `attachMediaPrep` (images
  reduced to `ATTACH_IMG_SIDE` 1568 px on a canvas, PNG then JPEG until ≤ 1,5 MB; PDF pages counted) and wait in place
  (`ui.attachPending.kind === 'media'`: preview, `#feAttachNote` description, LGPD warning, no masking possible); thumbnails load from
  `attachRaw` (`?raw=1&token=`); a description edited in the list (`.fe-attach-note`) is saved by `feAttachNote` (PATCH, no redraw); Enter
  in those fields never submits the feature form. The plan and the chat see only an image/PDF's summary and description. Uploads and removals
  apply at once to the draft and the saved feature (`feAttachSet`), not with "Salvar feature". `attachSecrets` finds secrets (sensitive
  headers and JSON keys, Postman `{key,value}`, escaped `body.raw`, Bearer/Basic, JWT, `curl -u`; `{{placeholders}}` stay) and asks in
  place (`ui.attachPending`, never `confirmAction`) with "Mascarar" checked (`***MASCARADO***`). `attachSummary` (Postman, Insomnia,
  OpenAPI, HAR, curl blocks, else the beginning) goes to the commander's plan and the co-writing chat (`attachPromptBlock`), which have
  no tools; `executeLiveStep` sends the ids as `attachments`. `feAttachCheck` marks the ones this database lacks (another computer, a
  restored version) as unavailable. No backup, export or demo support on purpose.
- Review desk: a feature running, in review or done opens in a wide modal (`openOpsFeature` → `openReviewDesk`, kind `review`, size `review-desk`): criteria and deliveries
  scroll apart (`.rv-scroll`; tabs under 900px), newest delivery first and the last step open, the decision fixed in the footer. `reviewSync` (from `render()`) patches it when
  `reviewSig` changes, keeping scroll and open items. **Solicitar ajustes** requires the reason (`#reviewReworkForm` → `approveFeature(id,false,text)`; closing keeps a draft in the transient
  `ui.reviewNotes`): `f.reworks` `[{at,text}]` (persisted, normalized, newest 10) goes to `buildStepPrompt` and the commander's plan.
  The **Arquivos** tab (`reviewFilesOn`: bridge and a non-simulated output; `reviewFilesLoad` at open and on `reviewSig` changes, state in `ui.reviewDesk`, nothing persisted) lists what the feature changed on disk and shows each file's diff (`reviewFileOpen`, `reviewDiffLines`), with `vscode://file/` links (`vscodeHref`). Bridge: `GET /api/changes/:folder` (read only; `changeSources`, `changeList`, `changeDiff`; a diff is served only for a listed file, cut at `DIFF_MAX`): `?repo&feature` = the branch against `startMark` plus the live worktree's uncommitted work; `?ranges=<from>..<to>,...` (new project) = each step's range of HEAD, so a commit with the agent's own message counts (`stepStart`/`stepEnd`, `range` in the exit event, kept as `output.range` `{from,to}`, persisted, normalized; `from` empty = no commit yet; one diff part per step; a range rewritten away counts in `missing`); `?key&since&until` = outputs from before the ranges, commits whose message ends in ` / <key>` within the time of those steps (a deleted feature's key can return); both plus the folder's uncommitted work (`pending`, "SEM COMMIT").
- Writing tools: a called colleague never gets a tool its caller's session lacks. `agentCanWrite` (Write, Edit or Bash, or `restrictTools` off) drives the plan card's warning (`roomPlanHTML`, not on map features)
  and a section of `buildStepPrompt` sent only to an agent that cannot write; the commander's prompt states the rule. A call refused with "No such tool available" does not fail the step: `toolGapsAdd`/`toolGapNote` report it in the
  console and the room, and `output.missingTools` (persisted, normalized) marks the delivery in the review desk.
- Features carry `route` (ordered agent ids) built by `routeFor`, which maps scopes to roles with
  `ROLE_FAMILY` (e.g. node/java/dotnet cover the backend step). A finished route sends the feature to
  human review; only approval marks it done and unblocks dependents.
- Agents: `ROLES` defines specialties; Squad Studio presets come from `AGENT_PRESETS` and
  `OP_CATEGORIES` (operators picked by category → sub-specialty, generalist first) and are
  materialized by `createPresetAgent`. Each agent has `model` (catalog `CLAUDE_MODELS`: aliases, pinned IDs, `inherit`;
  any id valid for the bridge survives import) and `effort` (`EFFORTS`, `''` = model default; none for Haiku,
  `modelEffortSupport`). The global runtime model/effort override the agent's (`runOptionsFor` → `agentEffort`); both go
  to the exported `.claude/agents/*.md` frontmatter (`agentMarkdown`) and to the CLAUDE.md command-chain table.
- SOUL: `src/souls.js` (`AGENT_SOULS` per catalog codename + `GENERIC_SOUL`) gives each agent `soul`/`hellos` (greeting variations, one picked at random per chat)
  (`defaultSoul`); it shapes the chat tone and greeting (`soulBlock`, `feGreeting`) and is exported (`soulMarkdown`).
  Tone rules for every agent chat: human, no catchphrases, no dashes (`soulBlock`, `AGENT_CHAT_SYSTEM`, `COWRITE_SYSTEM`), and
  `chatClean` strips dashes from reply bubbles. Changing a catalog soul/greeting list: keep the earlier version's `soulHash` /
  `helloPrint` fingerprint in `SOUL_PREV` / `SOUL_HELLOS_PREV` so unedited agents migrate (`normalizeSoul`, `normalizeHellos`).
- Diretrizes (conventions): catalog in `src/conventions.js` (`CONVENTION_FAMILIES` with ≥4 base
  templates per agent type, `CONVENTION_SUBSETS` grouped by `CONVENTION_GROUPS`); each agent stores
  `conventions = {family, template, base, subsets[]}`; `conventionFamilyOf(agent)` ties the guide to
  the agent's role/specialty.
- Coding style lives in the DIRETRIZES, never in a system prompt: group `style` ("Estilo de código") holds one `style-<lang>`
  subset per language (ts, js, python, go, java, csharp, php, kotlin, swift, dart, sql, css, shell, yaml, hcl).
  `CONV_STYLE_SUGGEST` (conventions.js) maps family → style subsets (shown first in the picker); `codeStyleKeys(a)` refines it
  by specialty, and `defaultConventions` gives them to every catalog/new agent (plus the preset's own `conv.subsets`).
  `docs/standards/coding-style.md` exports the `style` group.
- Catalog prompts (`ROLES[*].prompt`, preset `style`, the `presetPrompt` specialty suffix) are Portuguese and describe the role
  only. `migrateCatalogAgents` (a top-level call after the catalog, since `normalizeWorkspace` runs before `AGENT_PRESETS` exists;
  also on import) moves prompts still equal to an earlier catalog version (`PROMPT_PREV`: `soulHash` → `role:`/`preset:`) to the
  current text, and once per workspace (`settings.catalogVersion` < 2, persisted) adds the stack's style subsets to unedited
  DIRETRIZES (catalog base guide + only the preset's own subsets). Changing a catalog prompt: add its previous fingerprints to
  `PROMPT_PREV`; a new one-time migration bumps `catalogVersion`.
