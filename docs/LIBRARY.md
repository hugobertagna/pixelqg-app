# PixelQG — skills & agents library (linked GitHub repos)

Goal: a button in the app to link a GitHub repository of Claude Code skills / agents / commands. HQ clones it,
finds what it contains, and makes those skills and extra agents available to every Claude Code agent HQ launches
(form, follow-ups, integrated terminal), without touching the user's global Claude Code configuration.
Extends docs/CONTRACT.md and docs/TERMINAL.md (read both). Zero npm runtime dependencies. French UI (tutoiement).

## HARD RULES for everyone working on this
- NO visible window, popup or dialog, ever (`windowsHide: true` everywhere, headless browsers only, no `start`, no MessageBox).
  Git must never prompt: always run it with env `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `GIT_ASKPASS=` and
  args `-c credential.helper= -c core.askPass=` (otherwise Git Credential Manager can open a login window).
- Never run the real `claude` binary except `claude --version` and `claude plugin validate <dir> --json` (local, free).
- Network: cloning real public repos for tests is allowed but keep it small (`--depth 1`); prefer local fixture repos
  (`git init` in a temp dir, cloned through an injectable base URL / `file://` ONLY in tests — production accepts github.com only).
- Kill every process you start. Do not edit `launcher/`.

## 1. Verified Claude Code behaviour (tested on 2.1.302)
- `--plugin-dir <dir>` loads a plugin for this session only; pointing it at a FOLDER OF PLUGINS loads each child plugin.
- A plugin = `<dir>/.claude-plugin/plugin.json` (`{ "name", "description", "version" }`) + `skills/<skill>/SKILL.md`
  + `agents/<agent>.md` + `commands/<cmd>.md`. `claude plugin validate <dir> --json` validates it offline
  (`{ success, manifest: { errors: [], warnings: [] }, … }`).
- Loaded names are namespaced by the plugin name: agent `demo-repo:relecteur-fr`, skill/slash command `demo-repo:resume-fichier`.
- `--agent <name>` runs the session as that agent (use the namespaced name).

## 2. Storage (server/library.js) — data dir `HQ_HOME = process.env.PIXELQG_HOME || path.join(os.homedir(), ".pixelqg")`
```
~/.pixelqg/
  library.json                 persisted state (atomic write: tmp file + rename)
  repos/<owner>__<repo>[__<branch>]/      git clones (depth 1)
  library/<plugin-name>/       GENERATED wrapper plugins (the folder passed to --plugin-dir)
```
Repo object (sent to the client):
```js
{ id: "anthropics__skills", url: "https://github.com/anthropics/skills", owner, repo, branch: null|"main", subpath: null|"skills",
  plugin: "anthropics-skills",          // wrapper plugin name: lowercase [a-z0-9-], ≤ 40 chars, unique
  status: "cloning" | "updating" | "ready" | "error", error: null | "French message",
  enabled: true, commit: "a1b2c3d" | null, clonedAt, updatedAt,
  kind: "plugin" | "marketplace" | "loose",   // what the repo itself looks like
  counts: { skills, agents, commands, enabledSkills, enabledAgents, enabledCommands },
  warnings: [ "French text" ],                 // e.g. hooks / MCP servers ignored, items skipped, validation warnings
  items: [ { key: "skill:pdf", type: "skill"|"agent"|"command", name: "pdf", fullName: "anthropics-skills:pdf",
             description: "…", relPath: "skills/pdf", enabled: true, group: null|"document-skills",
             tools: null|"Read, Grep", model: null|"haiku" } ] }
```
Library object: `{ pluginDir: "<abs ~/.pixelqg/library>", gitFound: bool, gitVersion, repos: Repo[],
  profiles: [ { value: "anthropics-skills:code-reviewer", label: "code-reviewer", repo: "anthropics/skills", description } ] }`
(profiles = enabled agents of enabled ready repos).

## 3. Linking a repo
Accepted input (trimmed): `owner/repo`, `https://github.com/owner/repo`, optional `.git`, optional `/tree/<branch>[/<subpath…>]`,
`git@github.com:owner/repo.git`. owner `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`, repo `^[A-Za-z0-9._-]{1,100}$` (not `.`/`..`),
branch `^[A-Za-z0-9._-]{1,100}$` (not starting with `-`), subpath segments `^[A-Za-z0-9._ -]{1,100}$` without `..`. Anything else → 400
« Lien GitHub invalide. Exemple : anthropics/skills ou https://github.com/anthropics/skills ». Already linked → 409.
Clone: `git -c credential.helper= -c core.askPass= clone --depth 1 --single-branch --no-tags [--branch B] https://github.com/<owner>/<repo>.git <dest>`
(args array, no shell, hidden, timeout 180 s, at most 2 git operations at once). Private / missing repo → error
« Dépôt introuvable ou privé (seuls les dépôts publics sont pris en charge) ». Clone bigger than 300 MB → delete + error.
Git missing → `library.gitFound=false`, routes answer 503 « Git n'est pas installé. Installe-le depuis https://git-scm.com ».
Update: `git -C <dest> fetch --depth 1 origin <branch or HEAD>` then `git -C <dest> reset --hard FETCH_HEAD`, rescan, keep per-item
enabled flags by `key`. Remove: delete clone + wrapper (retry on EBUSY), update library.json.

## 4. Scanning (pure function, unit-tested): walk `<clone>/<subpath>` skipping `.git`, `node_modules`, symlinks/junctions
(never follow), depth ≤ 10, ≤ 20 000 entries, files ≤ 1 MB for parsing.
- skill: a file named `SKILL.md` (any case). Name = frontmatter `name` else the folder name. Description = frontmatter `description`
  else first paragraph (≤ 200 chars). The skill = its whole folder (supporting files included).
- agent: a `.md` file (not SKILL.md, not README/CHANGELOG/LICENSE/CONTRIBUTING/CLAUDE.md, not inside a skill folder) whose
  frontmatter has `name` AND `description`, and that either sits under a path segment named `agents` or has a `tools`/`model`/`color` key.
- command: a `.md` under a path segment named `commands` with a frontmatter (name = file name without extension).
- kind: `.claude-plugin/plugin.json` at the root → "plugin"; `.claude-plugin/marketplace.json` → "marketplace"; else "loose".
  `group` = the name of the nearest enclosing folder that has `.claude-plugin/plugin.json` (marketplaces bundle many plugins).
- Hooks (`hooks/hooks.json`, manifest `hooks`), MCP servers (`.mcp.json`, manifest `mcpServers`), LSP/output styles are NEVER loaded:
  add a warning « Ce dépôt contient des hooks (commandes automatiques) : ignorés pour ta sécurité. » / « … des serveurs MCP : ignorés … ».
- Names are normalised to `^[a-z0-9][a-z0-9-]{0,63}$` (lowercase, other chars → `-`); duplicates of the same type get `-2`, `-3`.
- Frontmatter: a tolerant mini YAML reader (key: value, quoted strings, `|`/`>` block scalars, `[a, b]` lists) that never throws.
- More than 500 items → keep the first 500 + warning.

## 5. Wrapper plugins (the integration)
After any change (link done, update, toggle, remove) rebuild `library/<plugin>/` for each enabled ready repo:
`.claude-plugin/plugin.json` = `{ "name": plugin, "description": "Skills et agents du dépôt owner/repo (lié par PixelQG)",
"version": "1.0.0", "author": { "name": owner } }`, `skills/<name>/` = copy of the skill folder (≤ 20 MB per skill, skip `.git`),
`agents/<name>.md`, `commands/<name>.md` (copies, never symlinks), enabled items only. Build in `<plugin>.tmp-<random>`, then swap
(remove old, rename new). Remove wrappers of disabled/removed repos. Validate each wrapper with `claude plugin validate <dir> --json`
(hidden, timeout 30 s, skipped if claude is missing): errors → repo status "error" with the first error in French, wrapper removed;
warnings → `repo.warnings`.
Every PixelQG spawns gets `--plugin-dir <library.pluginDir>` when at least one wrapper exists:
- agents.js spawn + follow-ups (`--resume`),
- the terminal shim (env `PIXELQG_PLUGIN_DIR`; added unless the user passed `--plugin-dir` themselves; also for `-p` runs).
Agent profiles: `POST /api/agents` and `POST /api/terminals` accept `profile` (must be one of `library.profiles[].value`, else 400)
→ adds `--agent <profile>`. New Agent field `profile: null | "anthropics-skills:code-reviewer"` (present on every agent).
Subagents whose `role` is a library agent keep that namespaced role.

## 6. HTTP / SSE (server.js)
| Method | Path | Body | Response |
|---|---|---|---|
| GET | /api/library | – | `{ ok, library }` |
| POST | /api/library/repos | `{ url }` | 202 `{ ok, repo }` (status cloning; progress via SSE) |
| POST | /api/library/repos/:id/update | – | 202 `{ ok, repo }` |
| POST | /api/library/repos/:id/toggle | `{ enabled }` or `{ key, enabled }` | `{ ok, repo }` |
| DELETE | /api/library/repos/:id | – | `{ ok }` |
SSE: `library` event = full Library object on every change; `snapshot` gains `library`. Config gains `library: { gitFound, pluginDir }`.

## 7. Frontend
- New dock tab « Bibliothèque » (next to « Nouvel agent » and « Terminal »):
  input « Lien GitHub » (placeholder `anthropics/skills`), button « Lier le dépôt » (Entrée submits), suggestion chips that only
  FILL the input: `anthropics/skills`, `wshobson/agents`, `VoltAgent/awesome-claude-code-subagents`;
  a one-line safety note « Les skills et agents donnent des instructions à Claude : ne lie que des dépôts de confiance. Hooks et serveurs MCP ne sont jamais chargés. »;
  one card per repo: `owner/repo` (link to GitHub, opens a new tab), status (Clonage… with an animated pixel bar / Mise à jour… / Prêt / Erreur + message),
  commit, counts « 17 skills · 3 agents · 2 commandes », repo on/off switch, « Mettre à jour », « Retirer » (two-step in-page confirm),
  warnings, expandable item list grouped by type (then group) with per-item checkboxes, search filter, descriptions.
  When git is missing: explanatory message instead of the form.
- Launcher (« Nouvel agent ») and terminal toolbar gain a « Profil » select: « Claude Code standard » + library profiles grouped by repo
  (label + description as title). Remembered in localStorage (try/catch); falls back to standard if the profile disappears.
- Roster/detail: profile chip (short name after the colon) when `agent.profile` is set.
- Game: `HQGame.setLibrary(library)` (safe before init) shows the linked repos as small labelled plaques / extra colorful books on the
  Bibliothèque room shelves (up to 6 names, "+N"), so linking a repo visibly adds books to the office library.
