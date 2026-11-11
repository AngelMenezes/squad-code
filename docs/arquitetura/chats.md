# Chats and Agent Teams (`src/app.js`)

Reference detail for Claude Code sessions, read on demand from the index in CLAUDE.md. When a change alters what a paragraph here describes, update it in the same commit.

- Chats: the feature editor's co-writing chat (`ui.featureChat`, `runCoWrite`) and the agent chat (`ui.agentChat`,
  modal kind `agent-chat`, opened by `openAgentChat` on a double click on an agent in the `network` view; a single click selects) share one engine
  and the same DOM ids (`#feMsgs`, `#feChatInput`): generic helpers read `chatNow()` and branch on the chat's `kind`.
  The agent chat offers `AGENT_CHAT_MENUS` per `chatFamily` (commander/adr/prd/op), handled by `agentChatAct`; free
  talk is `runAgentChat` (bridge, no tools). Conversations are kept in `ui.featureChats`/`ui.agentChats`/`ui.docChats` (filled at boot
  from `#squad-memory.chats`): `chatStash` (the Stop functions) stores `chatSnapshot(c)` there, and with the bridge `chatPersist`
  (hooked in `chatPush`/`chatSettle`/`chatFooter`, 800 ms) and `chatFlush` (beacon on `pagehide`) save it to the database.
  Every chat turn runs with `CHAT_RUN` over `runOptionsFor` (`tools:[]`, `permissionMode:'dontAsk'`, `partial:true`, 180 s; Agent Teams turns get 300 s, since the architect's documents take longer); never
  `plan` (its planning flow made replies slow and the model wrote fake tool calls). `claude -p` never offers AskUserQuestion, so
  an agent asks with `"ask":{question,options}` in the reply's ```json block (`COWRITE_SYSTEM`/`AGENT_CHAT_SYSTEM`): `chatAsk`
  turns it into `id:'ask'` buttons (`agentChatChoose` sends the pick back as the person's message; typing also answers).
  `chatStream` grows one live bubble from the text deltas (hidden from ```json on) and `chatSettle` fills it at the end.
  Both chat headers show the effective model (`coWriterModel`) and an effort chip (`effortChipHTML`: 5-bar meter; the model's
  default, dashed, when no level is set; none for Haiku), following the same override rules as `runOptionsFor`/`agentEffort`.
- Feature co-writing also sets **Depende de** and splits a feature (`COWRITE_SYSTEM`). `"dependencies"` (feature keys, the whole field):
  `coWriteDeps` keeps keys with an enabled box in `#featureDeps`, the change `{field:'dependencies'}` goes through `setFeDeps` and its
  undo value is `feDepIds()`. `"split":{context, features:[{title, scope, criteria, tasks}]}` (`coWriteSplit`, at most 5) shows the
  split in the reply (`featureSplitMD`, provisional keys from `featureSplitStart`) with the options `split-create`/`split-adjust`, the
  split kept on the message (`m.split`). `featureSplitChoose` (from `agentChatChoose`; `guardMutation`; refused while the draft is
  unsaved and for setup/map features) creates the features in the form's sprint with its area and priority, chained (the first depends
  on the open feature, each on the previous), and seeds each one's chat (`featureChatSeed`): `inherited {key, title, context, said}`
  (the PO's summary and the person's messages of the source chat plus what that chat had inherited, 8000 chars head and tail) is kept
  in the chat snapshot and restored by `newFeatureChat`, the first agent bubble is marked `inherit` (left out of the prompt history), and
  `coWritePrompt` adds "## Contexto herdado". The open feature keeps its own changes in the form until Salvar feature.
- **Agent Teams** is how the first data of an operation is co-written: an online meetup, Teams style, in a full-screen modal
  (kind `teams`, size `agent-teams`, `openAgentTeams`, only with the bridge: without `liveMode()` it toasts and does not open, there
  is no demo of it). The chat is the third co-writing kind, `doc` (`ui.docChat`, memory `ui.docChats`), on the single document
  `PROJECT_DOCS.kickoff`: briefing, visão, escopo dentro/fora, glossário, arquitetura and ADRs, each field with an `owner`
  (`chatFamily`: commander writes the briefing, PRD vision/scope/glossary, ADR architecture + ADRs; `docOwner` gives an empty seat's
  fields to the commander). `docAgents` reads the squad selected in `#projectForm`; the meeting is a group chat (`c.group` =
  commander, PRD, ADR). The commander conducts: `docTurnCrew` opens a round with the agents the person tags with @ (`@CODENAME` or
  `@comandante`/`@prd`/`@adr`/`@arquiteto`, `teamsMentions`; a name without @ does not route), else whoever asked the pending
  `ask`, else the commander; any reply can pass the word with `"next":"CODENAME"` (`applyDocWrite` → `meta.out.next`), queued in
  the same round, at most `TEAMS_ROUND` (3) turns. Agents cite each other as @CODENAME (system prompt), but only `next` hands
  over the floor. `teamsMentionHTML` turns participants' mentions into `.at-mention` chips in the bubbles (rendered, greeting and
  live; never inside code); a chip or a camera tile (`data-action="teams-mention"`) tags that agent in the composer. Typing `@`
  opens `#atMention` (`teamsMentionMenu`, a window capture keydown takes ↑/↓/Enter/Tab/Esc before the send and leave handlers),
  and `#atTo` ("Para:") shows who will answer. Guests: squad members outside the meeting (`teamsPool`: the squad's seats minus
  `c.group`, at most `TEAMS_GUESTS` at a time) are called in by a host's `"invite":[{agent, reason}]` (`applyDocWrite` →
  `meta.out.invite`, at most 2 per reply) or by the person's `@CODENAME` (`teamsMentionsPool` in `docTurnCrew`). `teamsJoin` adds
  them to `c.group` and `c.guests` (`{by, reason, waiting}`), posts a system note and a camera (`teamsAddTile`, `.guest`, its CRT
  started in step through `--crt-t` from `ui.teamsT0`), and they speak right after the caller (`crew.splice`, the round limit
  grows). A guest gets its own system prompt (called by whom and why, no document fields, only `ask`; `applyDocWrite` ignores its
  fields/next/invite) and leaves once it delivers (`teamsGuestOut`, note + fade); if it asked, it waits (`waiting`), answers the
  pick and leaves. Leftover guests leave at the end of the round, and all of them on close (`docChatStop`; `closeModal` then plays the CRT power-off on an inert ghost of the overlay, `teamsPowerOff`, none with reduced motion); `c.hosts` keeps the
  three fixed participants. The `@` list has a "Convidar" group; the gallery grows to 3/4 columns (`data-n`, `--n`). Each turn is its own `claude -p` (own instructions,
  SOUL, model, effort) and sees the round so far ("Nesta rodada") and the agenda ("## Pauta", `teamsAgenda`, same rule as
  `projectGaps`); `docCoWriteSystem` tells each agent to write only its fields. A host's system prompt must be the same on
every turn of the meeting (built from `c.hosts` only; the round, the guests and who is outside go in `docCoWritePrompt`): any change
in it makes the next turn write the whole system prompt to the prompt cache again. Screen: top bar (clock `teamsTick`, from `ui.teamsT0`, so it restarts on every open, agenda chips,
  tabs Chat/Documentos, save, Sair), stage with one tile per agent plus Você (`data-state` from `c.speakerId` + `c.phase`:
  thinking → speaking (first streamed words, `chatStream` `onFirst`) → sharing; every tile has a CRT overlay in its
  `:before`/`:after`, under the labels, all cameras in sync (no per-tile delay and no state may swap those animations), and
  agent tiles show the writing balloon `.at-tile-typing` in the bottom-right corner while their state is not idle), the bar
  `#atSplit` that resizes the chat (`teamsSplitDrag` with pointer capture, ←/→, Home/End, double click resets; `--at-side`,
  persisted as `state.settings.teamsChat`, 0 = default, in `normalizeWorkspace`; hidden under 900px), and the shared screen: `chatApply` calls
  `teamsShow` for every field written (`c.sharing`, block reveal, 1.5 s per field), back to the gallery on the next round or
  "Voltar à galeria". `teamsSync` (no-op outside the meetup) keeps tiles, chips and counters in step. The chat keeps the engine's
  DOM ids (`#feMsgs`, `#feChatInput`) in a Teams skin (`.at-chat`; sender with time, `feSenderFor`, `chatWho`, tails per
  `data-who`; `chatAgent` returns `c.speakerId`); the Documentos tab holds `#docForm` + `#docAdrList`, so `setFeField`,
  `applyDocAdrs` and `undoCoWrite` work as in the editors. After the greetings `teamsOpening` (scripted) presents the agenda by
  what is missing. Sair or Esc with unsaved documents (`teamsDirty`, snapshot at open) asks in the bar (`#atConfirm`; never
  `confirmAction`, it would replace the modal). Entry points: the Agent Teams button in the briefing section head (`teamsCtaHTML`)
  and the portraits on the briefing label and the DOCUMENTAÇÃO rows (`DOC_ROWS` → `kickoff`, `data-action="agent-teams"`,
  `preventDefault`ed inside `<summary>`), all refreshed by `refreshDocAgents` when the squad changes. It starts from the page
  form's current values; "Salvar no projeto" (`#docForm` → `saveProjectDoc`) writes back into `#projectForm`, calls `saveProject`
  (a new operation only fills the form: "Aplicar ao formulário") and opens and highlights every page place.
