# PixelQG — shared build contract

Local app: a Node server spawns real Claude Code processes and streams their activity to a browser page.
The page shows a pixel-art office where every agent is a little Clawd-style character (the blocky
Claude Code mascot), tinted in its own color, walking between rooms according to what it is doing.
All UI text is in **French**. Code comments in English. **Zero npm dependencies** (Node 22 built-ins
only, vanilla browser JS, no build step). Windows 11 is the primary platform; must also work on macOS/Linux.

> **2026-10-19: demo mode was removed** (no demo.js, `--demo`, `/api/demo*`, `config.demo` or source "demo" any more); the demo mentions below are historical.

Project root: `C:\Users\alex\OneDrive\Bureau\pixelqg-app`

```
pixelqg-app/
  package.json        scripts: start (node server/server.js), demo (node server/server.js --demo), test (node --test server/test)
  start.bat           double-click launcher (Windows): runs server, opens browser in app mode
  start.sh            same for macOS/Linux
  README.md           French user guide
  docs/CONTRACT.md    this file
  server/
    server.js         HTTP server, static files, auth, REST, SSE      (builder A)
    agents.js         AgentManager: spawn claude, parse stream-json   (builder A)
    claude-bin.js     resolve the claude executable                  (builder A)
    demo.js           simulated agents (no tokens spent)              (builder A)
    watcher.js        observe external Claude Code sessions           (builder A)
    names.js          name + color pools                              (builder A)
    test/*.test.js    node:test unit tests; fixtures/sample-stream.jsonl is a REAL captured stream (builder A)
  public/
    index.html        page shell                                      (builder C)
    style.css         all page styles                                 (builder C)
    js/main.js        boot, API client, SSE, store, wiring            (builder C)
    js/ui.js          HUD: launcher, roster, detail drawer, logs      (builder C)
    js/game/sprites.js     Clawd sprite generator + avatar drawing    (builder B)
    js/game/office.js      map, rooms, furniture, walkable grid, A*   (builder B)
    js/game/characters.js  Character entity, behaviours, bubbles, FX  (builder B)
    js/game/engine.js      canvas loop, camera, input, window.HQGame  (builder B)
```

Scripts are classic `<script>` tags (NOT ES modules), loaded in this order by index.html:
`js/game/sprites.js, js/game/office.js, js/game/characters.js, js/game/engine.js, js/ui.js, js/main.js`.
Each file is an IIFE that attaches to `window` (`window.HQSprites`, `window.HQOffice`,
`window.HQCharacters`, `window.HQGame`, `window.HQUI`). Only `HQGame` and `HQUI` are cross-builder APIs.

---------------------------------------------------------------------------------------------------
## 1. Agent object (server is the source of truth; sent whole to the client)

```js
{
  id: "a1",                 // server-generated, short, unique ("a1","a2"… ; subagents "a1.s1"; observed "o-<first8 of sessionId>"; demo "d1")
  kind: "root" | "sub",
  parentId: null | "a1",    // for subagents
  source: "spawned" | "demo" | "observed",
  name: "Nova",             // display name
  role: null | "general-purpose" | "Explore" | …,   // subagent_type for subs; null for roots
  color: "#D97757",         // hex #RRGGBB
  model: "claude-haiku-5-5" | null,   // from system/init (or requested alias until init arrives)
  cwd: "C:\\Users\\…",
  prompt: "…",              // the first prompt (subs: the Agent tool description + prompt)
  status: "starting" | "working" | "waiting" | "done" | "error" | "stopped",
            // starting: process launched, no init yet. working: turn in progress.
            // waiting: observed session idle (no new lines for 90 s) — only for source "observed".
            // done: turn finished OK. error: process crashed / result.is_error. stopped: killed by user.
  activity: {
    kind: "think"|"read"|"search"|"edit"|"write"|"bash"|"web"|"task"|"todo"|"tool"|"talk"|"idle"|"done"|"error",
    tool: "Read" | null,    // raw tool name when kind comes from a tool_use
    label: "Lit server.js", // short French human label, ≤ 60 chars (see §4)
    since: 1792346237635    // ms epoch when this activity began
  },
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },  // this agent's OWN usage (subs excluded); total = sum of the four
  costUsd: null | 0.0184,   // set from result.total_cost_usd (root: whole session incl. subs). null until known.
  toolCount: 0,             // number of tool_use blocks this agent emitted
  turns: 0,                 // number of completed turns (result events)
  startedAt: ms, endedAt: null | ms,   // endedAt set on done/error/stopped; cleared when a follow-up turn starts
  sessionId: null | "uuid",
  lastText: "",             // last assistant text block, trimmed to 280 chars
  resultText: null | "…",   // result.result trimmed to 2000 chars
  error: null | "message",
  canControl: true          // false for observed agents (cannot stop/message)
}
```

## 2. Log entries (per agent, server keeps the last 500)

```js
{ t: ms, type: "user"|"text"|"thinking"|"tool"|"tool_result"|"result"|"error"|"system",
  tool: "Read" | undefined, kind: activity kind | undefined,
  text: "short one-line French summary (≤ 200 chars)",
  detail: "optional longer text (≤ 4000 chars): tool input JSON pretty-printed, tool result excerpt, full assistant text" }
```

## 3. HTTP API (server binds 127.0.0.1 ONLY, default port 4317, override with env HQ_PORT or `--port N`)

Security (all mandatory):
- At startup generate `TOKEN = crypto.randomBytes(24).toString("hex")`. `GET /` (and `/index.html`) serves
  public/index.html with the literal placeholder `__HQ_TOKEN__` replaced by TOKEN. No other route reveals it.
- Every `/api/*` request must carry the token: header `X-HQ-Token: <token>`, or query `?token=` (only accepted
  on `GET /api/events`, because EventSource cannot set headers). Wrong/missing → 401 JSON. Compare with crypto.timingSafeEqual.
- Reject any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` → 403 (DNS-rebinding guard).
- If an `Origin` header is present it must be `http://127.0.0.1:<port>` or `http://localhost:<port>` → else 403.
- POST bodies: JSON only (`Content-Type: application/json` required → else 415), max 1 MB → 413.
- Static files: only from public/, resolve + verify the path stays inside public/ (no traversal), correct MIME types,
  `Cache-Control: no-store`. Unknown → 404.
- Responses are JSON `{ ok: true, … }` or `{ ok: false, error: "French message" }` with a proper status code.

Routes:
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/config | – | `{ ok, config }` (§3.1) |
| GET | /api/agents | – | `{ ok, agents: Agent[] }` |
| GET | /api/agents/:id/logs | – | `{ ok, logs: LogEntry[] }` |
| POST | /api/agents | `{ prompt, name?, color?, model?, cwd?, permissionMode?, effort? }` | 201 `{ ok, agent }` |
| POST | /api/agents/:id/message | `{ prompt }` | `{ ok, agent }` — follow-up turn on a finished root agent (uses `--resume <sessionId>`); 409 if still running or no sessionId |
| POST | /api/agents/:id/stop | – | `{ ok, agent }` — kill the process tree; status → stopped. Stopping a sub stops its root. |
| DELETE | /api/agents/:id | – | `{ ok }` — remove agent (+ its subs) from the list; stops it first if running; observed agents can be removed (hidden until new activity) |
| POST | /api/demo | `{ count? }` (1–8, default 4) | `{ ok, agents }` — start simulated agents |
| POST | /api/demo/stop | – | `{ ok }` — remove all demo agents |
| POST | /api/observe | `{ enabled: bool }` | `{ ok, config }` — toggle the external-session watcher |
| GET | /api/events?token=… | – | `text/event-stream` (§3.2) |

Validation of `POST /api/agents` (→ 400 with a French message on failure):
- `prompt`: non-empty string, ≤ 100 000 chars. Passed to claude via **stdin**, never as an argument.
- `name`: optional, 1–24 chars, regex `^[\p{L}\p{N} _.-]+$`u, must not start with `-`. Default: next free name from pool.
- `color`: optional `^#[0-9a-fA-F]{6}$`. Default: next color from pool not used by a live agent.
- `model`: optional, one of `config.models[].value` ("" = Claude Code default → no --model flag).
- `cwd`: optional; must be an absolute path to an existing directory. Default `config.defaultCwd` (user home).
- `permissionMode`: one of `config.permissionModes[].value`; default "default".
- `effort`: optional one of "", "low","medium","high","xhigh","max".

### 3.1 config
```js
{ version: "1.0.0", port, defaultCwd: os.homedir(), claudeFound: bool, claudePath: "…"|null, claudeVersion: "2.1.302 (Claude Code)"|null,
  models: [ {value:"", label:"Par défaut"}, {value:"haiku",label:"Haiku (rapide, économique)"}, {value:"sonnet",label:"Sonnet"},
            {value:"opus",label:"Opus"}, {value:"fable",label:"Fable (le plus puissant)"} ],
  permissionModes: [ {value:"default",label:"Prudent — lecture seule, refuse les modifications"},
                     {value:"acceptEdits",label:"Modifications de fichiers autorisées"},
                     {value:"auto",label:"Auto"}, {value:"plan",label:"Plan — réfléchit sans agir"},
                     {value:"bypassPermissions",label:"Tout autoriser (dangereux)", danger:true} ],
  colors: [12 palette hex], observe: bool, demo: bool }
```

### 3.2 SSE events (`event:` name + `data:` JSON). Send `: ping` comment every 15 s. On connect send `snapshot` first.
| event | data |
|---|---|
| `snapshot` | `{ agents: Agent[], config }` |
| `agent` | `Agent` (full object; sent on create AND on every change; client upserts by id) |
| `log` | `{ id, entry: LogEntry }` |
| `remove` | `{ id }` |
| `tokens` | `{ id, delta: number }` — emitted when an agent's tokens.total grows (for floating "+1.2k" FX) |

Throttle `agent` events per agent to at most one every 150 ms (coalesce; always flush the latest state).

---------------------------------------------------------------------------------------------------
## 4. Spawning and parsing (builder A)

Resolve the binary (claude-bin.js), in order: env `CLAUDE_BIN`; on win32 scan PATH dirs for `claude.exe` and for
`claude.cmd` whose content references `…\claude.exe` or `cli.js` (resolve `%dp0%` to the .cmd's dir); on other OSes
`claude` in PATH. If the target is a `.js` file spawn `process.execPath` with it. **Never use `shell: true`.**
On this machine the real target is `C:\Users\alex\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`
(claude.cmd contains the line `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*`).
Get the version with `execFile(bin, ["--version"])` at startup (timeout 15 s).

Args (array, no shell): `["-p", "--output-format", "stream-json", "--verbose", "--forward-subagent-text",
"--permission-prompts", "none", "--permission-mode", mode, "--name=" + name]` + `["--model", m]` if m +
`["--effort", e]` if e + `["--resume", sessionId]` for follow-ups. Write the prompt to stdin then end stdin
(verified: `echo "…" | claude.exe -p --output-format stream-json --verbose …` works). `cwd` = the validated directory.
env = process.env. `windowsHide: true`.
Read stdout line by line (buffer partial lines; a line can be > 1 MB). Ignore non-JSON lines (log them as system).
Collect stderr (last 4 KB) for error messages. On exit: if no `result` event was seen → status error with stderr tail
(or "stopped" if user killed it).
Stop: win32 → `execFile("taskkill", ["/pid", String(pid), "/T", "/F"])`; else `child.kill("SIGTERM")`, SIGKILL after 3 s.
On server shutdown (SIGINT/SIGTERM/exit) stop all children.

Real stream format (see `server/test/fixtures/sample-stream.jsonl`, a real capture with one subagent):
- `{type:"system",subtype:"init", session_id, model, cwd, permissionMode, …}` → set sessionId, model, status working.
- `{type:"assistant", message:{id, content:[…], usage:{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}}, parent_tool_use_id, agent_id?}`
  **The same `message.id` repeats across several assistant events (one per content block) with the SAME usage → count
  usage once per message.id per agent (keep a Map id→counted usage; if a later event for the same id carries larger numbers, add only the difference).**
  `parent_tool_use_id == null` → root agent. Otherwise → the subagent whose key is that tool_use id.
  Content blocks: `thinking` → activity think; `text` → activity talk + lastText + log text; `tool_use` → activity from tool (below), toolCount++, log tool with detail = input JSON.
- `{type:"user", message:{content:[{type:"tool_result", tool_use_id, content, is_error?}]}, parent_tool_use_id}` → log tool_result (excerpt ≤ 4000; content may be a string or an array of {type:"text",text}), activity → think ("Réfléchit…").
  A `tool_result` on the ROOT whose tool_use_id is a subagent key → that subagent is done (status done, activity done, endedAt).
  A user message with plain `text` content and parent_tool_use_id set is the subagent's prompt → ignore (already known).
- `{type:"system",subtype:"task_started", tool_use_id, description, subagent_type, prompt}` → create the subagent if not yet created.
- `{type:"system",subtype:"task_progress", tool_use_id, description, last_tool_name, usage:{total_tokens}}` → update sub activity label from description.
- `{type:"system",subtype:"task_notification", tool_use_id, status:"completed"|"failed"|…, summary}` → finish the sub (done or error), resultText = summary.
- `{type:"result", subtype, is_error, result, total_cost_usd, duration_ms, num_turns, session_id}` → root: status done (or error if is_error),
  activity done ("Terminé ✓") / error, costUsd = sum of total_cost_usd over all turns of this agent, resultText, turns++, endedAt.
  Any subagent still running under it → done.
- Everything else (rate_limit_event, post_turn_summary, task_summary, session_title_changed, task_updated…) → ignore (optionally log as system when useful).
- Subagent creation (whichever arrives first: the root's `tool_use` with name "Agent" or "Task", task_started, or any event with an unknown parent_tool_use_id):
  id = `${root.id}.s${n}`, kind "sub", parentId root.id, role = input.subagent_type || "general-purpose",
  name = a fresh pool name, color = a fresh pool color, prompt = input.description + "\n\n" + input.prompt, model = root.model,
  cwd = root.cwd, status working, canControl true, source = root.source.
  Subs are separate characters in the game; they appear next to their parent in the meeting room.

Tool → activity kind (exact tool names; anything starting with `mcp__` → "tool"; unknown → "tool"):
read: Read, NotebookRead · search: Glob, Grep, LS, ToolSearch · edit: Edit, MultiEdit, NotebookEdit · write: Write ·
bash: Bash, PowerShell, BashOutput, KillShell, Monitor, TaskStop · web: WebFetch, WebSearch · task: Agent, Task, SendMessage, Workflow ·
todo: TodoWrite, TaskCreate, TaskUpdate, TaskList, EnterPlanMode, ExitPlanMode · talk: AskUserQuestion.

French activity labels (use the file basename / pattern / host, truncated):
read "Lit {file}" · search "Cherche {pattern}" · edit "Modifie {file}" · write "Écrit {file}" · bash "Exécute {first 40 chars of description or command}" ·
web "Consulte {host}" / "Recherche « {query} »" · task "Délègue : {description}" · todo "Organise ses tâches" · tool "Utilise {short tool name}" ·
think "Réfléchit…" · talk "Rédige une réponse" · done "Terminé ✓" · error "Erreur" · idle "En pause".

## 5. Demo mode (demo.js)
Simulated agents go through the SAME AgentManager code path: demo.js produces synthetic stream-json events
(system init, assistant with tool_use blocks + plausible usage, user tool_results, occasional Agent tool_use with
task_started → sub events → task_notification, and finally result with a cost) and feeds them to the same parser
used for real processes. Timings: an event every 0.8–3.5 s. Each demo agent runs a scripted scenario of 8–20 steps
(e.g. "Refactoriser le module de paiement", "Écrire les tests de l'API", "Auditer les dépendances", "Rédiger la doc"),
then rests 6–12 s and starts a new scenario (forever, until removed). source "demo", canControl true (stop = freeze to stopped; message = start a new scenario).
`--demo` flag starts 4 demo agents at boot. Must never spawn a real process.

## 6. Watcher (watcher.js) — observe sessions started elsewhere
Poll every 2 s `~/.claude/projects/*/*.jsonl` (plus `*/<sessionId>/subagents/*.jsonl` if such dirs exist) for files modified
in the last 10 minutes. For each, tail from a stored byte offset (first read: whole file if ≤ 8 MB, else last 4 MB
starting at the next newline). Lines: `{type:"assistant", message:{id,content,usage}, sessionId, cwd, timestamp}` and
`{type:"user", message:{content:[tool_result…]}}` (same handling as the stream parser, usage deduped by message.id),
`{type:"agent-name", agentName}` / `{type:"custom-title", customTitle}` → display name (else basename of cwd, ≤ 24 chars).
Other line types (queue-operation, attachment, last-prompt, file-history-snapshot, system…) → ignore.
Skip sessions whose sessionId belongs to an agent HQ spawned itself. id `o-<first 8 chars of sessionId>`, source "observed",
canControl false, status working while lines arrive, "waiting" after 90 s with no new line (activity idle "En pause"),
removed (event `remove`) after 20 min without changes. Malformed/partial lines are skipped silently (keep the partial tail for next poll).
Enabled by default; `--no-observe` disables. Must cope with files being appended concurrently and with permission errors.

## 7. Names & colors (names.js)
Colors (in this order): `#D97757 #5BA4E6 #7BC67E #B48EE0 #F2C14E #E0709B #4FC1B9 #E8955A #8E9BF0 #C9D86B #F07C6C #A0A7B8`.
Names: Nova, Pixel, Biscotte, Orion, Luna, Zéphyr, Praline, Cosmo, Mochi, Atlas, Noisette, Kiwi, Comète, Sirius, Galette, Écho,
Pistache, Nimbus, Caramel, Vega, Myrtille, Quartz, Sésame, Lyra. When exhausted append a number (Nova 2).

---------------------------------------------------------------------------------------------------
## 8. window.HQGame API (builder B implements, builder C calls)

```js
HQGame.init(canvas, { onSelect(id|null), onHover(id|null) })   // canvas fills its CSS box; handle devicePixelRatio and resize (ResizeObserver)
HQGame.upsertAgent(agent)          // create or update the character from a full Agent object (idempotent, cheap)
HQGame.removeAgent(id)             // character walks to the exit door and disappears (fade), then is deleted
HQGame.log(id, entry)              // optional flash: short speech bubble for tool/text entries
HQGame.tokens(id, delta)           // floating "+1,2k" token popup above the character
HQGame.select(id|null)             // highlight ring + camera follows; null = fit whole office
HQGame.drawAvatar(canvas, color, { size = 48, status = "working", frame = 0 })   // static mini sprite for cards/roster (sets canvas size itself, handles DPR)
HQGame.setReducedMotion(bool)      // fewer particles, no camera easing
```
All methods must be safe to call before init and with unknown ids (no throw).

## 9. window.HQUI API (builder C) — main.js owns the store and wires HQGame + HQUI + API + SSE.

---------------------------------------------------------------------------------------------------
## 10. The office (builder B)

Top-down 3/4 pixel art, procedurally drawn on canvas (no image files), tile 16 px, map about 44 × 28 tiles, rendered with
`imageSmoothingEnabled = false` at an integer zoom that fits the viewport (min 1, prefer 2–3); wheel = zoom, drag = pan,
double-click empty floor = reset camera. Pre-render static layers (floor, walls, furniture) to an offscreen canvas.
Rooms (French labels painted on the floor/door sign) and what happens there:

| room | activity kinds | furniture / spots |
|---|---|---|
| Open space (centre, largest) | edit, write, talk, think | 12 desks with monitors + chairs; each agent gets a HOME desk (assigned on create, freed on remove); overflow agents get a free floor spot |
| Bibliothèque (top-left) | read, search | bookshelves, reading table, 6 spots |
| Salle serveurs (top-right) | bash | server racks with blinking LEDs, 6 terminal spots |
| Labo web (right) | web, tool | big world-map screen, antenna, 5 spots |
| Salle de réunion (bottom-left) | task, todo | long table, whiteboard, 8 spots; subagents spawn here next to their parent |
| Cafétéria (bottom-right) | done, idle, stopped (and status waiting) | coffee machine, couch, plants, 8 spots |
| Entrée (door / elevator on the bottom edge) | spawn + exit | |

Rooms joined by doorways; A* on a walkable grid, spots reserved per character, fallback to nearest free floor.
Character behaviour: new agent appears at the entrance (elevator sparkle) → walks to target; when activity.kind changes →
walk to the matching room spot (speed ≈ 3.5 tiles/s; avoid stacking on one spot). Debounce: if the activity changes again
within 1.2 s, keep walking toward the latest target (never jitter). Status overrides activity for placement:
done/stopped/waiting → cafétéria; error → stays where it is with a red "!".
At the spot play a pose: typing (arms bob, monitor glow), reading (holds a book), at rack (screen flicker), at web screen,
at whiteboard (marker), sipping coffee / sitting on couch, thinking ("…" thought bubble, small bob).
Overlays above each character (always readable, drawn in screen space so they don't blur): name tag in the agent color,
speech bubble with activity.label (truncate ~28 chars) shown for 4 s after a change then shrinks to an icon;
error → red "!" bounce; done → ✓ sparkles then walk to the cafétéria; stopped → "Zzz"; observed → small eye marker;
sub → thin dashed line to its parent while both visible. Floating token popups "+1,2k" rise and fade.
Hover → pointer cursor + highlight; click → onSelect(id). Selected → pulsing ring under feet.
Ambient life: server LEDs blink, coffee steam, monitor glow when the desk owner types, potted plants, wall clock.
Respect prefers-reduced-motion. Target 60 fps with 30 characters; pause rendering when the tab is hidden.

### Clawd sprite (sprites.js)
Inspired by the Claude Code terminal mascot: a chunky rectangular block body (wider than tall, ~14×9 px), two black square
eyes near the top, small rectangular arm nubs sticking out left and right, four short legs underneath; flat pixel shading
(top highlight row lighter, bottom/side darker). Tinted with the agent color (derive light/dark shades via HSL).
Frames: idle (2-frame breathing bob), walk (4 frames, legs alternate) in 4 directions (left/right mirrored; up shows back, no eyes),
work (arms up/down), plus blink every few seconds. Cache rendered frames per color in offscreen canvases.
Scale the sprite so a character is about 1.2 tiles wide on screen. Drop shadow ellipse under feet.

## 11. Page / HUD (builder C)
Layout (desktop): top bar · main area = game canvas (left, flexible) + right sidebar 360 px (roster + detail drawer) ·
launcher dock under the canvas (collapsible). Narrow (< 900 px): sidebar stacks under the canvas.
- Top bar: wordmark "PixelQG" with a mini Clawd, live global stats: agents actifs / total, tokens totaux (k/M),
  coût total ($, 2–4 decimals), temps cumulé; buttons: "Mode démo" toggle, "Sessions externes" toggle (observe), claude version / "Claude Code introuvable" warning.
- Launcher: prompt textarea (Ctrl+Entrée = lancer), name input (placeholder = next name), color swatches (12), model select,
  permission select (warning text when danger), effort select, working-directory input (default config.defaultCwd, remembered
  in localStorage), "Lancer l'agent" button; inline French errors from the API.
- Roster: one card per agent (roots first, subs indented under parent): avatar (HQGame.drawAvatar), name, role/model chip,
  status pill (colour + word: "Démarre", "Travaille", "En attente", "Terminé", "Erreur", "Arrêté"), activity label,
  live timer (mm:ss / h:mm:ss, ticking every second from startedAt → endedAt|now), tokens total, cost. Click → select.
- Detail drawer (selected agent): big avatar, name, status, model, cwd, session id (copy button), timer, tokens breakdown
  (entrée / sortie / cache lu / cache écrit) with a small stacked bar, cost, tools used count, turns, prompt (collapsible),
  last text / result (rendered as plain text, preserve line breaks — NEVER innerHTML with server strings), subagent list,
  live log feed (icon per kind, time, text; click entry → expand detail; auto-scroll unless user scrolled up; load history
  from GET /api/agents/:id/logs on select), actions: "Arrêter" (when running & canControl), follow-up textarea +
  "Envoyer" (when done/error/stopped & root & canControl & sessionId), "Retirer" (two-step confirm inside the page; no confirm()).
- Toasts for errors / "Agent Nova lancé".
- SSE reconnect with backoff; connection indicator dot.
Visual style: cosy night-office game UI. Tokens:
```css
--ink:#14151f; --panel:#1d1f2e; --panel-2:#262a3d; --line:#363b55; --text:#ece8f4; --muted:#9b9cb8;
--accent:#D97757; --accent-2:#f0a37f; --ok:#6cc28a; --warn:#f2c14e; --err:#e5534b; --info:#6aa9ff; --idle:#8a8fa8;
--font-pixel:"Silkscreen", "Press Start 2P", monospace;   /* labels, headings, pills — use sparingly */
--font-ui:"Rubik", system-ui, sans-serif;                   /* body */
--font-mono:"JetBrains Mono", ui-monospace, Consolas, monospace; /* numbers, logs, paths */
```
Load Silkscreen, Rubik, JetBrains Mono from Google Fonts (fallbacks above work offline). Panels: 2 px solid --line border,
small radius (4 px), pixel-ish inset shadow; buttons look pressable (bottom border darker, translateY on :active).
Tabular numbers for all stats. Visible focus rings. All text French.
