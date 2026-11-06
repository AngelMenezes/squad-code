# Map: city and office (`src/city.js`)

Reference detail for Claude Code sessions, read on demand from the index in CLAUDE.md. When a change alters what a paragraph here describes, update it in the same commit.

**`src/city.js` (`MapNetwork`).** Three.js scene with two views sharing the same agents: a hexagonal
city (perspective camera) and an isometric office with desks (orthographic). HTML markers/cards are
projected over the canvas (`updatePositions`, which places `[data-node]`, `[data-anchor]` and `[data-pin]` elements);
office agent cards are laid out to avoid overlap. The selected agent's quick-action bubbles (`nodeActionsHTML`,
`.node-actions[data-pin]`) are ignored by the map's pointer handling and are an obstacle for the card layout (`ACT_SPOTS`, same offsets as the CSS).
Move mode (`startMove`/`cancelMove`/`isMoving`, bubble Deslocar): the next click on a free hex/desk calls `onPosition`, with
a preview through `dragHexOf`/`deskOf`, a banner (`.map-move-hint`) and a cursor tip (`.map-move-tip`). The
A docked left panel (the operation chat) is `setInset(px)`: `insetShift()` (what it covers beyond `LEFT_ROOM`, halved) is added to
both cameras' `setViewOffset` and to the 2D fallback, `homePose` frames the remaining width, and the zoom follows that framing
(measured before/after on the current view), so the canvas is never resized while docking or dragging. The bottom map legend is one
compact `.legend-strip` (map controls, `.legend-sep`, agent/briefing/features/help). The
app talks to it through `MapNetwork.set(...)`, `setMode`, `onPosition`, `onEmptyClick`, `onCreateAt`,
`rotate`, `home`. Without WebGL it falls back to a 2D projection using the same camera math. `setMode` switches
views with a cinematic transmorph (`morph`, one 1.2 s tween `morphRun`, swap at `MORPH_SPLIT`): the camera orbits its target
around its right axis (`pose.flip`, applied in `applyCamera` via `orbit`, so lights/projection/picking stay consistent) while
it swings in theta, so the world tips over and spins until edge-on, and the other view arrives from the far side. The agents'
icons fly between the views as ghost clones (`.map-morph-ghosts`, destinations measured with `homePose`/`measureHome`,
blended into the live `agentPoint` at the end); office cards collapse on the way out (`lastCards`, kept by `layoutCards`)
and pop in on landing (`morph-land`, `--i`). Back in the city the buildings resurge in a wave (`sinkCity`/`riseCity`, a
`rise` multiplier per `byHex` group, independent from `k`) after the map is usable again. `.map-morphing` hides the real
markers with `visibility` and blocks the pointer; `zoom`/`rotate`/`focus`/public `home` return while morphing, a toggle
during it is queued, and `finishMorph` ends it at once (pause behind the Painel, reduced motion, resize). The office is built
and its shaders compiled at idle after boot (`gl.prepareOffice`, plus `ensureMorphLayers`), and the frame loop pauses tweens
across long frames instead of letting them skip.
Planet mode (setting `cityShape` 'flat'|'planet', passed in `MapNetwork.set`): the city scene keeps its flat coordinates and
`bendTree` patches every city material once (`bendMaterial`, `onBeforeCompile`, identity at b = 0) so the vertex shader maps
the flat world onto a sphere (`pl_map`, azimuthal equidistant, blend `planet.b` 0..1 curls it; `pl_bend` turns normals) and
disables frustum culling; objects tagged `userData.noBend` (core sphere, stars, halo, south-pole beacon in `planetFx`) are
skipped. `planetMap`/`planetUnmap` mirror it in JS for projection (far side = `behind`), picking (ray/sphere) and the camera,
which is the flat pose carried rigidly by the surface at the focus (`carryQ`, lights turn with it). `setShape` animates the
curl (`CURL_MS`, staged: pulse from the squad, camera first and the bend lagging it, a theta swing and a distance breath, and
`gl.foldWave` running a hologram band over the buildings; a toggle mid-way reverses from the current state; `curling` blocks
picking and camera input, `finishCurl`); `homePose` branches on the setting. The side controls' `.shape-toggle`
(`data-action="city-shape"`, key `P`, `aria-pressed`) flips `settings.cityShape`; render() collapses it (`.off`) in the office
view and without WebGL and plays `.folding`/`.unfolding` on its icon. Side-control icons are the `map-*` keys of `ICONS`. New city materials need
nothing special, but anything placed far from the ground must be subdivided (`hexRing` seg) so chords follow the sphere.
`bendMaterial` chains a material's own `onBeforeCompile` and keys the program by `userData.shaderKey` (the buildings' facade).
The city look (dark monochrome island, after a local reference image in the git-ignored `.inspo/city.jpg`; palette `CITY`, while `C` serves the office and the agents' cyan
accents): one ground mesh shaped like the grid (each hex fan subdivided, at `TILE_H`, so picking is unchanged) carries the street
map (`cityMap`, a CanvasTexture drawn once: avenues on the hex borders, 3 rhombus blocks per hex, light kerb lines, parks, coast),
plus water and a seawall (flat shape only). Buildings are instanced parts per kind (`GEO`: box, prism, round, spire, tree, pine;
`{key, kind, x, z, rot, w, d, h0, h, tone}`, setbacks stack parts), grouped in `byHex`; `writeBuilding` scales each part with
`k * rise`, so free/occupied hexes and the rise wave keep working. Heights follow seeded value noise (`district`), capped near the
squad (towers only from ring 6); density is kept low on purpose (about 40% open lots, mostly one building per block, ~950 parts).
Agents' plazas stand out in electric blue (`AGENT_BLUE`; self-lit body, rim in HDR colour `rimColor()` so the bloom makes it
glow, an outer line and an additive light pool `poolTex`); handoffs keep purple rims. Links (`buildArcs`, both views) carry
transmission signals: a second additive tube with a clone of `signalTex` (bright head, fading tail) whose `offset.x` scrolls
from sender to receiver in `animate` (`packets` entries with `signal`), faster and brighter on the active link.
A plain click on a free hex sets `pickedHex` (outlined by `pickGroup`): `syncCity` counts it as busy, so its buildings go down and
only the ground stays; the same hex again, an agent's hex or a click outside the grid clears it (`MapNetwork.picked` for tests). The facade (floor lines, mullions, darker foot, lit cornice and roofs) is computed from the world
position in `buildMat`'s shader. The key light `sun` casts PCF shadows (r186 removed PCFSoft; softness is `shadow.radius`);
casters use the bent `customDepthMaterial` (`castShadows`). City post-processing (`buildComposer`, the office renders directly):
MSAA target → `GTAOPass` at half resolution (its normal material bent; transparent meshes and `userData.noAO` hidden from the
G-buffer) → subtle `UnrealBloomPass` → `OutputPass`. Shadows (`shadowMap.autoUpdate = false`) and AO are recomputed only when
`geoDirty` (`markDirty`: buildings, plazas, planet, quality, size) or the camera/sun moved (`sameAs`, number by number against
`camPrev`/`sunPrev`, no per-frame allocation); otherwise the cached AO is multiplied straight onto the frame (one pass, `needsSwap`
false). MSAA 2x (0 at dpr > 1.25), bloom at half resolution, ground anisotropy ≤ 4, GTAO 8 samples. Frame pacing (`frame()`,
`pacing`): with the camera still and motion on, ambient animations draw on every vsync ('full'); over 15% of drawn frames above
24 ms switches to 'half' (draw when ≥ 26 ms passed, a steady 30 fps); interaction and tweens always draw; `applyQuality`/`resize`
reset it (`MapNetwork.pacing`). Packets reuse their position vector (`curve.getPoint(k, target)`). Quality: `settings.mapQuality` ('high'|'low', toggle in Configurações) plus automatic degradation (`gl.measure`: average
over 45 ms per frame drops AO, then bloom, then shadows); `MapNetwork.quality` reports it. The Three bundle includes these
addons (`scripts/three-entry.js`).
The office (`OFFICE`/`ROOMS`/`SLOTS`, also read by the app through `officeSlots`): 8 rooms (CMD, REC, R, B, A, LAB, C, WAR),
24 workstations all facing the north window + 6 meeting seats; `firstFreeDesk(taken, role)` puts the commander in CMD and ADR/PRD
in REC, operators fill `DESK_ROOM_ORDER` (A, B, C, LAB...). The War Room (`war: true`, `door: 'west'`, full depth at the end of the
corridor) has no slots: `warAt` gives it the hover cursor and a click calls `onRoomClick('WAR')` (app → `openOpsChat`). Its look
follows `squadState()` through `office.war` (`WAR_LOOK` idle/live/paused, set in `syncOffice`; `animate` pulses 'live'), with two
red `PointLight`s that always stay in the scene; the label gets `.live` ("AO VIVO").
`buildOffice` batches furniture parts by geometry + material into InstancedMeshes (`put`, unit box scaled per instance, in the
frame of each desk/chair). Tall outer walls are a cutaway: `applyCamera` shows only the two whose inner face looks at the camera.
The office key light casts shadows rendered only when `office.shadowDirty` (build, walls swapped, quality), never per frame.
The running desk's lamp is one `PointLight` that always stays in the scene (intensity 0 when idle, so no recompile) plus a
camera-facing glow plane (the bundle has no Sprite). The office has no clock overlay (removed); the green ✓ on markers comes
from the app (`deliveredIn`, office view only).
Office life (`lifeTick`, office view only, motion on): a purely visual scheduler moves "actors" (visual positions through
`lifePos` in `agentPoint`) along door/corridor paths (`officePath`) for meetings, visits, calls and breaks, with badges
(`.life-layer`) and arcs (`gl.lifeArcs`). It never touches `a.desk`; `lifeReset` puts everyone back (mode switch, pause,
Handoffs, motion off, `startMove`). `MapNetwork.officeLife.{state,kick}` helps testing. Idle badges carry a DEMO mark.
The run in the office (`MapNetwork.ops`, from the app's `officeOps()`, sent by `render()` inside `set()` and by `officeFeed()`
(rAF batched, signature without images) on every room change: `roomPush`/`roomUpdate`/`roomRemove`/`roomChrome`): while a run
exists (or its last errands play, `opsBusy`) the random acts end and none starts. `crew` = agents with a popup (commander
planning/awaiting with `hold:'war'`, the baton holder with its last activity chip, a called colleague with `hold:'call'` beside
the caller); `events` = errands from room messages numbered by seq (`ops:'brief'` say → commander to the first agent, baton →
carried to the next desk, final baton → to the commander for review, `ops:'stop'` clears them). `applyOps` never replays (first
data or another project seeds `ops.seen`; events seen outside `lifeOn()` are skipped). `opsTick` (inside `lifeTick`) reconciles
holds and starts queued errands as life acts (`act.ops`, `OPS_SPEED`, errands stay `OPS_STAY`); `doorOf` returns `{in,out}`
(the War Room opens west). Popups (`.ops-pop` in `.ops-layer`, `placeOps`, data-action select-agent: chip, current action `doing`, and a speech balloon `.ops-say`
with the agent's latest line of the run, `say` from `officeOps`) take the agent card's place
in `layoutCards` (`POP_W`/`POP_H`, sticky offset, a walking popup rides above its agent) and show with motion off too.
`MapNetwork.officeOps.{live,settled}` drives the demo pacing (`live` = 'office' | 'city' | '': beats are spaced in both views, the
office also waits for the walks). In the city the same data drives `opsCity`: `gl.runSet` makes each crew agent's plaza glow in its
tone (`RUN_TONE`: breathing emissive, two rings, a light column `beamGeo`, animated in `runAnimate`), open calls become two-way
`runLinks` (tone links in `buildArcs`), and each errand becomes a comet `gl.runBurst` (a `signalTex` clone with one head carried
from sender to receiver, which pulses with `pulseAt({color})`) plus a temporary label in `ops.tags`; `placeCityTags` puts an
`.ops-tag` (state chip) over each agent at work and toggles `.map-node.ops-on` (`--ops-tone`).
