# PixelQG — game overhaul ("le jeu, en plus riche")

The user asked: "change l'interface, fais un truc plus complexe sur le jeu". The app must stop looking like a dashboard with a
game inside and become a GAME with a management HUD (think cosy pixel management sim / small RTS): the office fills the whole
window, the information lives in game-style HUD elements and windows, and the simulation is much richer.
Everything that exists must keep working: launching agents (form), follow-ups, stop/remove, logs, the integrated terminal (xterm),
the library tab (GitHub skills repos + profiles), demo mode, observed sessions, SSE, tokens/cost/timers.
Read docs/CONTRACT.md, docs/TERMINAL.md, docs/LIBRARY.md first, then the current code. French UI (tutoiement). Zero dependencies.

## HARD RULES
- No visible window/popup/dialog on the user's screen (windowsHide everywhere, HEADLESS browser only, no `start`, no MessageBox).
- Never run the real claude binary. Kill everything you start. Do not edit launcher/ or server/ (except where stated).
- The user wants results, not test suites: `node --check` + at most one or two headless screenshots of YOUR part. No new test files.
- Performance: 60 fps with 30 characters on a laptop; pre-render static layers; no per-frame allocations in hot loops where avoidable.
- prefers-reduced-motion respected (fewer particles, no camera easing, no screen shake).

---------------------------------------------------------------------------------------------------
## 1. World (builder WORLD — owns public/js/game/office.js and a new public/js/game/lighting.js)
Bigger, denser, more alive office, top-down 3/4 pixel art (tile 16 px), about 64 × 40 tiles. Rooms (French labels on signs):
| id | label | activity kinds / meaning |
|---|---|---|
| lobby | Hall d'entrée | spawn/exit: elevator with animated doors + floor indicator, reception desk, big "tableau des agents" screen showing live agent names in their colors |
| open | Open space | home desks (16 desks): edit, write, talk, think-at-start |
| library | Bibliothèque | read, search; tall shelves, ladder, reading nooks, the linked-repo plaques/books (keep `setLibrary`) |
| servers | Salle serveurs | bash (generic); racks with blinking LEDs, cable trays, cooling fans |
| tests | Salle de tests | bash whose label matches /test|jest|vitest|pytest|mocha|spec|lint|tsc|build|compile/i ; big wall board with green/red lights reflecting recent results |
| post | Bureau de poste Git | bash whose label matches /\bgit\b|commit|push|pull|merge|rebase/i ; mailboxes, letter sorting shelves, a pneumatic tube |
| web | Labo web | web, tool (MCP); world-map screen with travelling packets, satellite dish |
| meeting | Salle de réunion | task, todo; long table, whiteboard with live scribbles, projector |
| cafe | Cafétéria | done, idle, stopped; coffee machine with steam, fridge, arcade cabinet, couch, tables |
| terrace | Terrasse | extra idle/overflow space outside with plants, benches, sky (day/night) — characters idle in `waiting` (non-interactive) may stroll here |
Each room object: `{ id, label, x, y, w, h (tiles), blurb (one French sentence for tooltips) }` in `office.rooms`; spots per room with
`{ x, y, facing: "up"|"down"|"left"|"right", pose: "type"|"read"|"rack"|"screen"|"board"|"sit"|"stand"|"coffee"|"mail"|"test", item?: string }`.
KEEP the existing Office public API (same names & signatures, characters.js relies on them):
`inBounds, isWalkable, isWall, roomAt, isDoorway, tileCenter, worldToTile, nearestWalkable, findPath, isReservedByOther, releaseSpot,
spotOf, reserveSpot(roomId, owner, near), findFreeTile, reserveTile, assignDesk, freeDesk, deskOf, markDesk(index, mode, color, time, extras?),
updateAmbient(dt, points), setLibrary, libraryPlaques, build, drawBase, drawUnder` + `office.desks`, `office.rooms`, `office.width/height` (px).
`markDesk` gains optional `extras = { name, papers }`: desk shows a nameplate in the owner's color, the monitor shows scrolling code
lines in the owner's color while mode "type", a "…" screen while "think", and a paper stack growing with `papers` (cap 6).
New world methods:
- `setTimeOfDay(hours)` (float 0–24, engine calls it every 30 s with the local time): windows/sky/terrace colors follow a smooth
  day → golden hour → night palette; at night lamps turn on.
- `drawLighting(ctx, t, view)` (lighting.js): a light layer drawn after characters: darkening multiply at night + warm additive pools
  under lamps, monitor glows at occupied desks, server LEDs glow, window light shafts during the day. Pre-render per time-of-day bucket.
- `drawMinimap(ctx, w, h)`: rooms as flat colored blocks with tiny labels (engine adds agent dots and the camera rectangle).
- `roomInfo(id)` → room object; `roomAtWorld(wx, wy)` → id|null (for hover tooltips).
- Ambient life: elevator doors open when someone spawns/leaves (`office.ping("elevator")`), coffee machine steams when used,
  test board flashes green/red (`office.ping("tests", ok)`), mail tube whooshes (`office.ping("post")`), whiteboard scribbles while
  the meeting room is occupied, plants sway subtly, clock shows real time.

## 2. Characters (builder CHARACTERS — owns characters.js, sprites.js, new pets.js, new progression.js)
- Room choice uses §1 table (status overrides as today; interactive `waiting` → home desk idle with a "?" emote; the think rule stays:
  thinking keeps the character where it is). Dwell ≥ 2.5 s before leaving a room except for status changes.
- Smoother movement: 8-direction walking with path smoothing (string-pulling on the A* path), slight acceleration, bob,
  directional sprites (keep the Clawd look from sprites.js; add 3/4 diagonal frames or reuse left/right with offsets), shadow.
- Items carried/used per pose: book (read), magnifier (search), laptop (bash/tests), letter (git → drops it in a mailbox), paper
  (write/edit), coffee mug (cafe), marker (board), globe/tablet (web). Draw them in sprites.js, cached per color.
- Emotes (pixel icons above the head, pop animation, 1.5–3 s): 💡-style lightbulb when a tool starts after thinking, "!" on a new user
  prompt or new turn, "?" when an interactive agent waits for the user, sweat drop on error, heart/stars on done, Zzz when stopped,
  musical note sometimes while idle in the cafe.
- Social scenes:
  - Delegation: when a subagent appears, it walks out of the elevator to its parent; if the parent is in the meeting room they face each
    other and exchange 2–3 tiny bubbles ("…", "📄", "👍" drawn as pixel icons); when the sub finishes it walks to the parent, a paper
    flies from sub to parent (item transfer arc), then the sub goes to the cafe and leaves when removed.
  - Idle chat: two or more idle characters in the cafe/terrace occasionally turn to each other with small chat bubbles.
- Name tag shows a level badge (from progression), selected character gets a pulsing ring + a subtle spotlight.
- Coins: `tokens(delta)` spawns pixel coins that pop from the character; the engine flies them to the HUD counter (§3) — characters.js
  exposes `takeCoins()` → list of {x, y, value} spawned this frame (world coords) for the engine to animate.
- Level-up: when an agent crosses a level threshold → fireworks burst + "NIVEAU N !" floating text; emit event `{ type: "levelup", id, level, title }`.
- Pets (pets.js): a small pixel cat ("Biscuit") wandering on walkable tiles, sleeping on the couch, sometimes following the selected
  agent, purring hearts when clicked (click handled via engine hit test → `pets.click(x,y)`), and a robot vacuum that roams at night.
- progression.js → `window.HQProgression` (also used by the HUD):
  `level(tokens)` → `{ level, title, progress (0..1), floor, next }` with thresholds
  L1 0 · L2 10 000 · L3 50 000 · L4 150 000 · L5 400 000 · L6 1 000 000 · L7 2 500 000 · L8 6 000 000 · L9 15 000 000 · L10 40 000 000,
  titles: Stagiaire, Junior, Confirmé, Senior, Expert, Architecte, Maestro, Légende, Mythe, Oracle.
  `ACHIEVEMENTS` = array of `{ id, icon (single pixel-icon name), title, description, test(stats) }` (≈ 15, French, fun), with
  `stats = { totalTokens, agentsLaunched, toolsUsed, reads, searches, edits, writes, bashes, tests, gits, webs, tasks, errors, done,
  subagents, terminalSessions, reposLinked, maxConcurrent }`. `HQProgression.ICONS` = small pixel-art drawing functions or bitmaps shared
  by game and HUD (lightbulb, coin, star, trophy, book, wrench, terminal, globe, letter, heart, bolt, clock, flame, crown).

## 3. Engine + game HUD (builder HUD — owns engine.js, index.html, style.css, ui.js, main.js)
engine.js keeps the HQGame API (init, upsertAgent, removeAgent, log, tokens, select, drawAvatar, setReducedMotion, setLibrary) and adds:
`attachMinimap(canvas)`, `setTour(bool)` (visite guidée: camera glides between active agents every ~8 s, stops on user input),
`setSound(bool)` (WebAudio synthesized 8-bit sounds, OFF by default, started only after a click: typing ticks, done chime, error buzz,
level-up arpeggio, coin blip, elevator ding), `setCoinTarget(fn)` (fn() → {x, y} client coords of the HUD token counter; coins fly
there in screen space and the engine calls `onEvent({type:"coin", value})`), `onEvent(cb)` (levelup, coin, petclick, roomclick),
`focusRoom(id)`, hover tooltips for rooms (label + blurb + occupants) and characters, render order: base → under → characters →
lighting → overlays → coins/fx, time-of-day updates, screen shake on errors (tiny, disabled with reduced motion).
Layout (game-first):
- The canvas fills the whole window. HUD elements float over it (pixel panels with 2 px borders, slight translucency, crisp).
- Top-left "ressources" bar: coin icon + tokens totaux (animated counter that the flying coins hit), coût total, agents actifs / total,
  temps cumulé, connection dot, Claude Code version (or warning).
- Top-right toolbar (pixel icon buttons with tooltips): Nouvel agent, Terminal, Bibliothèque, Succès, Mode démo, Sessions externes,
  Visite guidée, Son, Plein écran. Each opens/toggles a game WINDOW.
- Bottom "équipe" bar (RTS party bar): one portrait per root agent (drawAvatar), name, level badge, status ring color, small token bar,
  current activity pixel icon; subagents as small stacked portraits behind their parent; click = select & follow; scrolls horizontally.
- Bottom-left minimap (toggle), click to move the camera.
- Character sheet window (right side) when an agent is selected: big portrait, name + level title + XP bar, status, model/profile chips,
  « Mission » (prompt), stats as RPG bars (tokens entrée/sortie/cache lu/cache écrit), coût, outils, tours, temps, session id copy,
  sub-agents list, journal (logs, expandable), actions (Arrêter / follow-up / Voir son terminal / Retirer two-step).
- Windows (Nouvel agent, Terminal, Bibliothèque, Succès): draggable by title bar, closable, z-order on focus, positions remembered
  (localStorage try/catch), Terminal window resizable (xterm refits). On screens < 900 px windows become bottom sheets.
- Achievements: main.js accumulates `stats` from the store + SSE `log` events (kinds) and calls HQProgression tests; unlocking shows a
  game toast « Succès débloqué : … » with its icon (persist unlocked ids in localStorage, try/catch); the Succès window lists all
  (locked ones greyed with their description).
- Keep every existing feature's behaviour and endpoints. DOM via createElement/textContent only (no innerHTML with data).
