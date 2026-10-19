# PixelQG — integrated terminal ("CMD") contract

Goal: inside the app, the user opens a real Windows terminal (cmd.exe), types `claude` (interactive Claude Code,
full TUI), and every Claude Code session started in that terminal automatically appears in the office as a linked
agent character (name, color, tokens, activity, timer…), exactly like agents launched from the form.
This extends docs/CONTRACT.md (read it first; everything there still applies). Zero npm runtime dependencies,
except the vendored xterm.js files under public/vendor (copied from the official npm packages, MIT).

## HARD RULES for everyone working on this
- NO visible window, popup or dialog on the user's screen, ever: every spawned process uses `windowsHide: true`;
  never run a non-headless browser, never `start`, never `--open`, never MessageBox, never run `PixelQG.exe`.
- Never run the real `claude` binary except `claude --version` (it costs money). Use fake binaries for tests.
- Kill every process you start; leave nothing running. Keep test runs short.
- User-facing strings in French (tutoiement), code comments in English.

---------------------------------------------------------------------------------------------------
## 1. PTY bridge — `server/bin/hq-pty.cs` → `server/bin/hq-pty.exe` (Windows only)

Node has no built-in pseudo-terminal, so a tiny C# console program wraps Windows ConPTY
(CreatePseudoConsole, Windows 10 1809+). Built with the .NET Framework compiler that ships with Windows:
`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /codepage:65001 /target:exe /optimize+ /out:hq-pty.exe hq-pty.cs`
(C# 5 only: no `$""`, no `?.`, no expression-bodied members). `server/bin/build-pty.bat` does it. The server also
compiles it automatically at startup if `hq-pty.exe` is missing or older than `hq-pty.cs` (hidden execFile of csc,
timeout 60 s; on failure terminals are reported unavailable with a French reason).

Usage: `hq-pty.exe --cols <n> --rows <n> --cwd <dir> --cmd "<full command line>"`
- Creates pipes + pseudoconsole of cols×rows, starts the command line in it with
  `EXTENDED_STARTUPINFO_PRESENT` + `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, cwd = --cwd, inheriting the bridge's environment.
- Puts the child in a kill-on-close Job Object so killing the bridge kills the whole shell tree.
- stdout of the bridge = raw bytes read from the ConPTY output pipe (UTF-8 VT sequences), flushed promptly.
- stdin of the bridge = framed messages: `[type u8][length u32 little-endian][payload]`
  - type 0: input — payload bytes are written to the ConPTY input pipe (keystrokes, UTF-8).
  - type 1: resize — payload = cols u16 LE, rows u16 LE → ResizePseudoConsole.
  - type 2: terminate — kill the job and exit.
  - EOF on stdin = terminate.
- When the child exits: drain remaining output, close the pseudoconsole, exit with the child's exit code.
- Errors go to stderr (one line, French) with exit code 90+.

## 2. Terminal manager — `server/terminals.js`

```js
Terminal = { id: "t1", title: "Terminal 1", cwd, shell: "cmd.exe", status: "running" | "exited",
             exitCode: null | n, createdAt: ms, endedAt: null | ms, cols, rows,
             agentIds: [],            // root agents linked to sessions started in this terminal (most recent last)
             name: "Nova" | null, color: "#D97757" | null }   // defaults for claude sessions started here
```
- `create({ cwd, name?, color?, launchClaude?, claudeArgs? })`: spawns `hq-pty.exe --cols 120 --rows 30 --cwd <cwd> --cmd "cmd.exe /k"`
  with env = process.env plus:
  `PATH = <server/shim dir>;<PATH>` · `PIXELQG_URL=http://127.0.0.1:<port>` · `PIXELQG_TOKEN=<token>` · `PIXELQG_TERMINAL=<id>` ·
  `PIXELQG_NODE=<process.execPath>` · `PIXELQG_SHIM=<abs path server/claude-shim.js>` · `PIXELQG_REAL_CLAUDE=<resolved claude path>`
  (+ `PIXELQG_REAL_PREFIX` JSON array if the resolved claude is a .js run by node).
  If `launchClaude`, write `claude` + extra args + `\r` to the PTY once the first output arrived (or after 600 ms).
  `claudeArgs` is built ONLY from validated values: `--model <alias from config.models>`, `--permission-mode <mode from config>`.
- Keeps the last 256 KB of output per terminal (replayed to a client that (re)connects).
- `write(id, data)`, `resize(id, cols, rows)` (clamp 20–400 × 5–200), `kill(id)`, `remove(id)` (kill + forget; linked agents stay).
- On exit: status exited, exitCode, endedAt; linked agents still running → done (or stopped if killed).
- Max 8 live terminals (409 + French message beyond). All terminals killed on server shutdown.
- Non-Windows or bridge unavailable: `config.terminal = { supported: false, reason: "…" }`; routes answer 501.

## 3. The `claude` shim — `server/shim/claude.cmd` + `server/claude-shim.js`
`claude.cmd`: `@"%PIXELQG_NODE%" "%PIXELQG_SHIM%" %*` (CRLF line endings). Because the shim dir is first in PATH,
typing `claude …` in an HQ terminal runs the shim, which:
1. Parses argv. Pass-through WITHOUT linking (just exec the real claude) when: `-p/--print`, `-v/--version`, `-h/--help`,
   or the first arg is a subcommand (`mcp`, `config`, `update`, `doctor`, `install`, `plugin`, `agents`, `setup-token`, `migrate-installer`…).
2. Determine the session id: `--session-id <uuid>` given → use it; `-r/--resume <id>` → that id; `-c/--continue` or bare `--resume`
   → unknown (null); otherwise generate `crypto.randomUUID()` and append `--session-id <uuid>` to the args.
3. `POST ${PIXELQG_URL}/api/terminals/${PIXELQG_TERMINAL}/link` (header X-HQ-Token, JSON `{ sessionId, cwd: process.cwd(),
   pid: process.pid, name: value of -n/--name if given, args: argv joined, ≤ 300 chars }`, timeout 2 s). On failure print one
   dim French line ("PixelQG : liaison impossible, la session tourne quand même.") and continue.
4. Spawn the real claude (`PIXELQG_REAL_CLAUDE`, or `process.execPath` + prefix for a .js) with the final args,
   `stdio: "inherit"`, `windowsHide: false` (it must share the PTY console; the PTY itself is invisible).
   Ignore SIGINT/SIGBREAK in the shim (the child handles Ctrl+C). Report the child pid in a second call
   `POST …/link` with `{ sessionId, childPid }` is NOT needed: send `childPid` in an `update` instead:
   `POST /api/terminals/:id/link` accepts an optional `childPid` and `linkId` to update an existing link.
5. On child exit: `POST …/unlink { linkId, exitCode }` (best effort, 1 s timeout), then exit with the same code.
Without `PIXELQG_*` env (shim run outside HQ) it simply execs the real claude found in PATH after removing its own dir.

## 4. Linking sessions to agents (server/agents.js + server/watcher.js)
`POST /api/terminals/:id/link` creates (or reuses, for a resumed sessionId already known) a ROOT agent:
`source: "terminal"`, `terminalId: "t1"`, `interactive: true`, `kind: "root"`, `name` = link name || terminal.name || next pool name,
`color` = terminal.color || next pool color, `cwd`, `prompt: ""` (filled with the first user prompt from the transcript),
`status: "starting"`, `sessionId` (may be null), `canControl: true` (stop = kill the claude child tree with taskkill /T /F; follow-up
"message" is NOT offered: the user types in the terminal → POST /api/agents/:id/message answers 409 for interactive agents).
Response `{ ok, agent, linkId }`. The terminal's `agentIds` gets the agent id (SSE `terminal` event).
New Agent fields (always present on every agent): `terminalId: null | "t1"`, `interactive: boolean`.

The transcript watcher feeds linked sessions into that agent (instead of creating an "observed" one), and it MUST track
linked sessions even when general observation is disabled. Transcript location: `~/.claude/projects/<cwd with every
non-alphanumeric char replaced by "-">/<sessionId>.jsonl` (e.g. `C:\Users\alex\OneDrive\Bureau` → `C--Users-alex-OneDrive-Bureau`);
for a linked session look there first, and also accept the file wherever the watcher finds that sessionId.
Unknown sessionId (`--continue`): the first transcript file created/modified in the cwd's project dir after the link time,
whose sessionId is not already linked, is adopted by that agent.
Interactive turn tracking from transcript lines:
- `type:"user"` with string content or text blocks, not `isMeta`, not a tool_result → new turn: status working, activity think
  "Réfléchit…", log `user` entry (text ≤ 200 chars), and set `prompt` if empty, `endedAt = null`.
- `type:"assistant"` with `message.stop_reason === "end_turn"` → turn finished: status `waiting`, activity idle
  "Attend ta réponse", `lastText` from its text, turns++ (tokens deduped by message.id as everywhere else).
- tool_use / tool_result / thinking → same activity mapping as the stream parser.
- unlink (process exit) → status done (exit code 0) or error (non-zero, `error: "Claude Code s'est arrêté (code N)"`), activity done/error, endedAt.
Cost for interactive sessions stays `null` (transcripts carry no cost) — the HUD shows "—".

## 5. HTTP / WebSocket (server/server.js, new `server/ws.js`)
Same Host/Origin/token guards as every other `/api/*` route.
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/terminals | – | `{ ok, terminals }` |
| POST | /api/terminals | `{ cwd?, name?, color?, launchClaude?, model?, permissionMode? }` | 201 `{ ok, terminal }` (validation as POST /api/agents) |
| DELETE | /api/terminals/:id | – | `{ ok }` |
| POST | /api/terminals/:id/link | `{ sessionId?, cwd, pid, name?, args?, linkId?, childPid? }` | `{ ok, agent, linkId }` |
| POST | /api/terminals/:id/unlink | `{ linkId, exitCode }` | `{ ok }` |
| GET (Upgrade) | /api/terminals/:id/socket?token=… | – | WebSocket |
SSE additions: `terminal` (full Terminal) and `terminal-remove` (`{ id }`); the `snapshot` gains `terminals: Terminal[]`.
Config additions: `terminal: { supported: bool, reason: string|null, shell: "cmd.exe" }`.
WebSocket (`server/ws.js`, zero-dependency RFC 6455 server): validate Host, Origin and `token` query BEFORE completing the
handshake (else write a 401/403 HTTP response and destroy); Sec-WebSocket-Accept = base64(sha1(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"));
handle masked client frames, fragmentation, 16/64-bit lengths (reject frames > 1 MB), ping→pong, close handshake.
Messages are JSON text frames:
- client → server: `{ "type": "input", "data": "<string>" }` · `{ "type": "resize", "cols": n, "rows": n }`
- server → client: `{ "type": "replay", "data": "<buffered output>" }` (first message) · `{ "type": "output", "data": "<string>" }` ·
  `{ "type": "exit", "code": n }`. Decode PTY bytes with a StringDecoder("utf8") so multi-byte chars never split. Several sockets may watch one terminal.
Add `server/bin`, `server/shim` to what the server serves NOTHING from (static stays public/ only).

## 6. Frontend
- Vendor xterm: `public/vendor/xterm/xterm.js`, `xterm.css` (from @xterm/xterm@5.5.0 `lib/xterm.js`, `css/xterm.css`) and
  `public/vendor/xterm/addon-fit.js` (from @xterm/addon-fit@0.10.0 `lib/addon-fit.js`), obtained with `npm pack` into a temp
  folder (never `npm install` into the project). Keep their LICENSE files next to them. index.html loads them before the app scripts.
- The bottom dock gets two tabs: « Nouvel agent » (the existing launcher) and « Terminal ». The Terminal tab:
  toolbar with dossier (shared with the launcher's remembered cwd), nom + couleur (defaults for sessions started there),
  buttons « Nouveau terminal » and « Lancer Claude Code » (creates a terminal with launchClaude), a row of terminal tabs
  (title, status dot, linked agents' mini avatars, close ×), and the active xterm (theme from the CSS tokens, font JetBrains Mono,
  cursor blink, scrollback 5000, FitAddon + ResizeObserver → `resize` message, debounced). An « Agrandir » toggle makes the dock tall
  (about 65 % of the viewport) so the TUI is comfortable; remember dock height/tab in localStorage (try/catch).
  When `config.terminal.supported` is false, the tab shows the French reason instead.
- Socket per open terminal with reconnect; output written to xterm; keystrokes (`term.onData`) sent as input.
- Agents with `source: "terminal"`: roster chip « Terminal », detail drawer button « Voir son terminal » (switches the dock to that
  terminal), no follow-up box (show a hint « Réponds-lui directement dans son terminal »), cost shows « — ».
- Game: terminal agents get a small ">_" marker (like the eye marker for observed agents); status `waiting` already sends
  characters to the cafétéria — for interactive agents in `waiting`, keep them at their home desk with an idle pose instead
  (they are waiting for the user, not finished).
