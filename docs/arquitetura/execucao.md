# Execution, commander and operation room

Reference detail for Claude Code sessions, read on demand from the index in CLAUDE.md. When a change alters what a paragraph here describes, update it in the same commit.

**Execution path.** `startRun` → `launchNext` → `simulationStep` (demo) or `liveStep` →
`executeLiveStep`, which POSTs `{prompt: buildStepPrompt(...), systemPrompt: agentSystemPrompt(a),
options: runOptionsFor(a)}` to the bridge. `agentSystemPrompt` = agent instructions + its conventions
guide; use it (not `a.prompt`) anywhere the agent's instructions leave the app (live runs, command
preview, `.md` export). Each step's output becomes handoff context for the next agent.
Runs are scoped: `startRun({sprintId})` runs a sprint, `startRun()` the `currentSprint` (action `run`, space key, HUD, Painel,
commander chat), `startRun({featureId})` one feature with its full route (`startFeatureRun`, `runner.single`, `kind:'feature'`).
Nothing runs on an incomplete project: `runGate` (`projectGaps`: every saved field of the project form and documentation, a squad,
≥1 ADR and each ADR with title and content) is checked by `startRun` (after the pause/resume toggle), `openSpawn`, `spawnAgent`
and the commander chat `run`. It lists what is missing in a toast and in the `.ops-run-gate` notice, then opens the briefing. The seed
project is complete so the demo still runs.
**Commander, operation room and calls.** Every run is planned by the squad's commander before anything executes. `runner.phase`
goes `planning` → `awaiting` → `running` (`runControl()` gives the run buttons their label: Planejando / Aprovar plano / Pausar /
Retomar; `launchNext`/`scheduleStep` only move in `running`):
- `beginPlan` opens the room and runs `planWithCommander` over the scope's pending features (backlog/ready/blocked). Live: one
  `claude -p` of the commander (`CHAT_RUN`, `COMMANDER_PLAN_SYSTEM`, `commanderPlanPrompt` with `routeFor` suggestions) streams its
  message and ends with ```json `{"plan":[{feature,route:[CODENAMES],briefs:{CODENAME:text}}]}` (a bare object is accepted too);
  `validatePlan` keeps squad members only (never the commander) and falls back to `routeFor` per feature, or wholly with a note.
  Demo: `routeFor` + `defaultBrief`.
- The plan card waits for the person: **Executar plano** (`roomApprove`, also the run button/space key while `awaiting`) writes
  `f.route` + `f.briefs` (persisted, aligned with the route, reset wherever the route changes) and starts; **Cancelar** is `stopRun`,
  which leaves every feature untouched (and cancels `runner.planRunId`).
- That plan only routes features that already exist; new ones come from **Planejar próxima sprint** (commander chat option
  `sprint`, bridge only). `c.focus.sprint` makes every turn carry `sprintPlanTask` (target sprint, next keys, the current proposal),
  and a ```json `{"proposal":{goal, features:[{key,title,scope,priority,description,criteria,dependsOn}]}}` (`sprintProposal`, at
  most `SPRINT_PROPOSAL_MAX`) is shown as a list (`sprintProposalMD`) with **Criar no painel** / **Pedir ajustes**; the latest one
  lives in `c.focus.proposal`. Nothing is registered before **Criar no painel** (`applySprintProposal`, refused during a run): the
  target (`sprintPlanTarget`) is the last sprint while none of its features started, else a new sprint; keys are reassigned from
  `nextFeatureNumber` and a proposal key in `dependsOn` only resolves to an earlier item of it. `startRun` with nothing pending
  (current sprint done or empty, no explicit `sprintId`) goes to `nextSprintOffer`: the commander chat opened on `sprint`
  (`openAgentChat(id, opt)` → `agentChatStart`), or in demo a toast and the sprint editor. The kickoff prompt (`docCoWriteSystem`)
  keeps sprints, schedule and execution status out of the documents: the briefing never registers anything.
- The room (`ui.rooms[projectId]`, max 800 messages) is a group chat shown in the **operation chat** (`openOpsChat`, no modal): any run
  start (`beginPlan`, `spawnAgent`), the `room` action and the War Room take the person to the Squad map in the isometric office
  (`settings.squadView='office'`, `goView('network')`), where `#opsChat` (shell) takes the left HUD's place (`#workspace.ops-chat-on`
  hides the roster with Novo agente/Briefing/Squad Studio and the bottom strip's agent/briefing buttons). `ui.opsChat`
  `{open, min, unread, pid}` is transient; `renderOpsChat` (in `render()`) shows it only on `network` and `opsChatBuild` fills it once per
  project with the room's ids (`#roomStatus`, `#roomCrew`, `#roomFeed`, `#roomControls`), so `roomFeedEl`/`roomChrome` write there.
  WhatsApp skin (`.ops-chat` restyles `.room-*`), minimizable to `#opsChatMini` (last message, unread count from `roomPush`),
  closable (`opsChatClose`) only with no run, so after a run it stays with the summary until closed. It takes the whole left side,
  over the top bar too (z-index above it, its header as tall as `--topbar-h`; `.ops-chat-dock` puts the top bar's tabs and status in
  the space to its right and leaves the brand under it): width `state.settings.opsChat` (px, 0 = 380, in `normalizeWorkspace`) as `--oc-w` on `#workspace`
  (`.ops-chat-dock` moves the bottom strip aside), resized by `#ocSplit` (`opsChatSplitDrag`/`opsChatSplitKey`, double click resets,
  `opsChatSideSet`; `opsChatLimits`: 300 px up to half the window or 720, leaving the top bar room for its tabs and status); `renderOpsChat` runs before `MapNetwork.setMode` in `render()` and calls `MapNetwork.setInset(opsChatDockW())`, so
  the map (and a morph to the office) frames the free area. Minimized or ≤900px (bottom sheet) there is no dock. With the bridge it is saved:
  `roomOf` hydrates a project's room once from `#squad-memory` (`roomHydrate`: pending plan and open calls end cancelled, `seq` = max id,
  before the first render so the office does not replay errands), and `roomPush`/`roomUpdate`/`roomRemove` queue changes (`roomQueue`,
  owner per message in `roomOwner`, `roomFlush` 600 ms, beacon on `pagehide`). It shows
  `roomPush`/`roomUpdate` (rAF batched)/`roomRemove`, `roomTyping` (never saved), crew column (`roomCrewHTML`: com o bastão, chamado, na fila,
  entregou) and `roomChrome()` (called at the end of `render()`). Message kinds: `system`, `say` (`activity[]` chips, `thread`,
  `human`, `error`), `plan`, `call`, `baton`, `review`. `roomStepStart` (agent says its part), baton cards in `advanceRoute`, review
  card + commander summary in `launchNext`. Demo work and calls come from `SIM_WORK`/`SIM_CALL` as beats (`simBeats` kept in
  `runner.sim`, played by `simBeat`: first chip, call open (`roomCalling`) and answered, other chips, summary). Nobody watching the
  office (`officeLive()`): `simulationStep` plays them all in one tick (same timing as before); watched: one beat per
  `scheduleStep(cb, ms)`, and in the demo `scheduleStep` also waits (at most 9 s) for `officeSettled()` so the walks complete.
- Live steps use `stepRunOptions(a,p)` = `runOptionsFor` + `agents` from `squadSubagents` (every other squad member keyed by
  `agentSlug`, own prompt + `CALLED_AGENT_SYSTEM`, tools, model, effort; no `Agent`, so no nesting) + `forwardSubagents`, and add
  `Agent` to `tools`/`allowedTools`. `buildStepPrompt` adds the commander's instruction and the colleagues list. `roomEvent` maps
  the stream: text → bubbles, tool_use → chips (`toolActivity`), `Agent` → call card (`roomCalling`), subagent messages
  (`parent_tool_use_id`) → thread, tool_result → the card's answer. Chats never get agents.
- Individual spawn (`spawnAgent`, `kind:'spawn'`) skips the commander but runs in the room too. It overwrites `f.route`/`f.briefs`.
- A failed step (`liveStep`: `[FALHA]` output, status `ready`, `step` 0; route, briefs and `runStart` kept) can be resumed:
  `resumePoint(f)` = the number of deliveries since `runStart`, valid while the route still has the failed agent at that step;
  `roomResumeHTML` puts **Retomar com <agente>** on the latest error message of that feature; `resumeFeature` (live: refused while
  `GET /api/runs` shows a run of that feature still running, with `confirmAction` to cancel it first) starts a `kind:'feature'`
  runner at that step with no plan, and `runner.resume` makes `buildStepPrompt` add `resumeNote` (work left uncommitted, check
  git status/diff, finish without redoing). `streamRun` reconnects with `?after=` (`STREAM_RETRY`, about 80 s) before a step fails.
"Distribuir features" (`openDistribution`, deterministic `routeFor` plan, `applyPlan`) still exists for planning by hand, and
`launchNext` only picks features of `runner.sprintId`. The export orders features sprint by sprint,
adds `sprint:` to each `spec.md`, a Sprints section to `scope.md` and `/executar-sprint`.
