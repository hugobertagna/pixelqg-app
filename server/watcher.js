'use strict';

// Watcher (contract section 6): observes Claude Code sessions started outside of
// PixelQG by tailing their transcripts in ~/.claude/projects/*/*.jsonl (plus the
// subagent transcripts in <sessionId>/subagents/). Transcript lines are converted
// into stream-json-like events and fed to the shared StreamParser through the
// AgentManager, so observed agents behave exactly like spawned ones.
//
// It also feeds the interactive sessions started in PixelQG terminals (docs/TERMINAL.md
// section 4): a linked session goes to its "terminal" agent instead of an observed one,
// with interactive turn tracking, and is tracked even when general observation is disabled.

const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { LineSplitter } = require('./agents');

const SESSION_FILE_RE = /^([0-9a-zA-Z][0-9a-zA-Z_-]{7,})\.jsonl$/;
const SUB_FILE_RE = /^agent-([0-9a-zA-Z_-]+)\.jsonl$/;
const READ_CHUNK = 1024 * 1024;
const MAX_READ_PER_POLL = 32 * 1024 * 1024;
const LINKED_SEARCH_MS = 5000;
// stop_reason values that end an interactive turn (the assistant hands control back to the user).
const TURN_END_REASONS = new Set(['end_turn', 'refusal', 'stop_sequence', 'max_tokens']);
const INTERRUPT_RE = /^\[Request interrupted by user/i;

function defaultProjectsDir(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim()
    ? env.CLAUDE_CONFIG_DIR.trim()
    : path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/**
 * Name of the transcript folder Claude Code uses for a working directory: every
 * non-alphanumeric character becomes "-" (C:\Users\alex\OneDrive\Bureau -> C--Users-alex-OneDrive-Bureau).
 */
function projectDirName(cwd) {
  return String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');
}

/** Key of a transcript in the watcher maps (Windows paths are case-insensitive). */
function fileKey(file) {
  return process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
}

function sameDir(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function cleanName(value) {
  const s = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > 24 ? chars.slice(0, 24).join('').trim() : s;
}

function cwdName(cwd) {
  if (typeof cwd !== 'string' || !cwd) return '';
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/);
  return cleanName(parts[parts.length - 1] || cwd);
}

function parseTime(value, fallback) {
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return t;
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return fallback;
}

/** Returns the human prompt carried by a transcript user line, or '' (tool results, commands…). */
function promptText(line) {
  if (!line || line.type !== 'user' || line.isMeta || line.isCompactSummary) return '';
  const content = line.message && line.message.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((b) => b && b.type === 'tool_result')) return '';
    text = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  text = text.trim();
  if (!text) return '';
  if (/^<(command-|local-command|system-reminder|bash-|user-memory)/i.test(text) || /^Caveat:/i.test(text)) return '';
  const chars = Array.from(text);
  return chars.length > 4000 ? chars.slice(0, 3999).join('') + '…' : text;
}

function isIgnorableFsError(err) {
  return Boolean(err && ['ENOENT', 'EACCES', 'EPERM', 'EBUSY', 'ENOTDIR', 'EISDIR', 'EMFILE', 'ENFILE', 'ELOOP', 'EINVAL'].includes(err.code));
}

class SessionWatcher {
  /**
   * @param {import('./agents').AgentManager} manager
   * @param {object} [opts]
   * @param {string} [opts.projectsDir] defaults to ~/.claude/projects (or $CLAUDE_CONFIG_DIR/projects)
   * @param {number} [opts.pollMs=2000]
   * @param {number} [opts.recentMs=600000] only files modified within this window are picked up
   * @param {number} [opts.idleMs=90000] no new line for this long -> "waiting"
   * @param {number} [opts.removeMs=1200000] no change for this long -> removed
   * @param {number} [opts.minAgeMs=2500] brand-new files are left alone this long (HQ's own spawns register first)
   * @param {number} [opts.maxInitialBytes] first read covers the whole file up to this size…
   * @param {number} [opts.tailBytes] …otherwise only the last tailBytes
   * @param {boolean} [opts.autoPoll=true] schedule polls with timers when started
   * @param {() => number} [opts.now]
   */
  constructor(manager, opts = {}) {
    this.manager = manager;
    this.projectsDir = opts.projectsDir || defaultProjectsDir();
    this.pollMs = opts.pollMs != null ? opts.pollMs : 2000;
    this.recentMs = opts.recentMs != null ? opts.recentMs : 10 * 60 * 1000;
    this.idleMs = opts.idleMs != null ? opts.idleMs : 90 * 1000;
    this.removeMs = opts.removeMs != null ? opts.removeMs : 20 * 60 * 1000;
    this.minAgeMs = opts.minAgeMs != null ? opts.minAgeMs : 2500;
    this.maxInitialBytes = opts.maxInitialBytes != null ? opts.maxInitialBytes : 8 * 1024 * 1024;
    this.tailBytes = opts.tailBytes != null ? opts.tailBytes : 4 * 1024 * 1024;
    this.autoPoll = opts.autoPoll !== false;
    this.now = typeof opts.now === 'function' ? opts.now : Date.now;

    /** Observation of external sessions (config.observe). Linked terminal sessions are always tracked. */
    this.enabled = false;
    this.disposed = false;
    this.files = new Map(); // absolute file path -> file state
    this.sessions = new Map(); // sessionId -> session state
    this.searches = new Map(); // linked sessionId -> last time every project dir was searched for it
    this.timer = null;
    this.inFlight = null;

    this._onRemove = ({ id }) => {
      for (const s of this.sessions.values()) {
        if (s.rootId === id) {
          s.rootId = null;
          s.subActivity.clear();
        }
        if (s.linkedAgentId === id) s.linkedAgentId = null;
      }
    };
    this._onSpawnedSession = ({ sessionId }) => this._ignoreSession(sessionId);
    this._onLink = (info) => this._linked(info);
    manager.on('remove', this._onRemove);
    manager.on('session', this._onSpawnedSession);
    manager.on('link', this._onLink);
  }

  /** Starts observing external sessions (immediate first poll, then every pollMs). */
  start() {
    if (this.enabled || this.disposed) return;
    this.enabled = true;
    if (this.autoPoll && !this.inFlight) this._schedule(0);
  }

  /** Stops observing external sessions and removes every observed agent (linked sessions keep being tracked). */
  stop() {
    this.enabled = false;
    for (const [sid, s] of Array.from(this.sessions.entries())) {
      if (s.linkedAgentId) continue;
      if (s.rootId && this.manager.get(s.rootId)) this.manager.remove(s.rootId);
      this.sessions.delete(sid);
    }
    for (const [file, state] of Array.from(this.files.entries())) {
      const s = this.sessions.get(state.sessionId);
      if (!s || !s.linkedAgentId) this.files.delete(file);
    }
    if (!this._active() && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Enables or disables the observation of external sessions. */
  setEnabled(enabled) {
    if (enabled) this.start();
    else this.stop();
  }

  /** Detaches from the manager (server shutdown / tests). */
  dispose() {
    this.enabled = false;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.manager.off('remove', this._onRemove);
    this.manager.off('session', this._onSpawnedSession);
    this.manager.off('link', this._onLink);
  }

  /**
   * Reads what linked transcripts still hold right now (called before an interactive session is
   * marked finished, so its last lines are attributed while the link is still active).
   */
  async flushLinked() {
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        /* the next poll reports its own errors */
      }
    }
    await this.poll();
  }

  _active() {
    return !this.disposed && (this.enabled || this.manager.hasActiveTerminalLinks());
  }

  _schedule(delay) {
    if (!this.autoPoll || !this._active()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.poll();
      } catch (err) {
        console.error('[watcher]', err && err.message ? err.message : err);
      }
      this._schedule(this.pollMs);
    }, delay);
    this.timer.unref();
  }

  /** Makes sure polls run (a linked session appeared while observation is disabled). */
  _wake() {
    if (!this.autoPoll || this.disposed || this.timer || this.inFlight) return;
    this._schedule(0);
  }

  /** Runs one scan. Concurrent calls share the in-flight scan. */
  poll() {
    if (!this._active()) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._poll().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** A terminal session was linked: it owns its transcript from now on. */
  _linked({ agentId, sessionId }) {
    if (sessionId) this._claimSession(sessionId, agentId);
    this._wake();
  }

  /**
   * Routes a session to a linked agent. When another terminal agent owned it (a finished session
   * continued in a new one), only the new lines go to the new agent. Otherwise any observed agent
   * showing the same session is dropped and the transcript is re-read from the start for the new owner.
   */
  _claimSession(sessionId, agentId) {
    const s = this.sessions.get(sessionId);
    if (s && s.linkedAgentId === agentId) return;
    if (s && s.linkedAgentId && this.manager.get(s.linkedAgentId)) {
      s.linkedAgentId = agentId;
      s.rootId = agentId;
      s.subActivity.clear();
      return;
    }
    if (s && s.rootId && s.rootId !== agentId) {
      const other = this.manager.get(s.rootId);
      if (other && other.source === 'observed') this.manager.remove(s.rootId);
    }
    this.sessions.delete(sessionId);
    for (const [file, state] of Array.from(this.files.entries())) {
      if (state.sessionId === sessionId) this.files.delete(file);
    }
  }

  _linkContext() {
    const links = this.manager.terminalLinks();
    const bySid = new Map();
    const pending = [];
    // Oldest first so that a live link overrides a finished one for the same session.
    links.sort((a, b) => (a.active === b.active ? a.since - b.since : a.active ? 1 : -1));
    for (const link of links) {
      if (link.sessionId) bySid.set(link.sessionId, link);
      else if (link.active) pending.push(link);
    }
    pending.sort((a, b) => a.since - b.since);
    return { links, bySid, pending, adopt: new Map() };
  }

  /**
   * --continue / --resume picker: for each pending link (oldest first), the transcript of its cwd
   * written after the link time and not owned by a live link. Brand-new files win, then the earliest write.
   */
  _planAdoptions(candidates, ctx) {
    const taken = new Set();
    for (const p of ctx.pending) {
      const dir = path.join(this.projectsDir, projectDirName(p.cwd));
      let best = null;
      let bestScore = null;
      for (const c of candidates) {
        if (c.sub || taken.has(c.file) || c.st.mtimeMs <= p.since) continue;
        if (this.manager.spawnedSessionIds.has(c.sessionId)) continue;
        const owner = ctx.bySid.get(c.sessionId);
        if (owner && owner.active) continue;
        if (!sameDir(path.dirname(c.file), dir)) continue;
        const born = c.st.birthtimeMs && c.st.birthtimeMs > 0 ? c.st.birthtimeMs : c.st.ctimeMs;
        const score = [born > p.since ? 0 : 1, c.st.mtimeMs];
        if (!best || score[0] < bestScore[0] || (score[0] === bestScore[0] && score[1] < bestScore[1])) {
          best = c;
          bestScore = score;
        }
      }
      if (best) {
        taken.add(best.file);
        ctx.adopt.set(best.file, p);
      }
    }
  }

  async _poll() {
    const now = this.now();
    const ctx = this._linkContext();
    const candidates = [];
    const seen = new Set();
    const push = (c) => {
      const key = fileKey(c.file);
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(c);
    };

    if (this.enabled) await this._collectAll(now, push);
    if (ctx.links.length) await this._collectLinked(ctx, now, push);

    // Root files first so that a session exists before its subagents report in.
    candidates.sort((a, b) => (a.sub ? 1 : 0) - (b.sub ? 1 : 0));
    if (ctx.pending.length) this._planAdoptions(candidates, ctx);
    for (const c of candidates) {
      try {
        await this._processFile(c, now, ctx);
      } catch (err) {
        if (!isIgnorableFsError(err)) console.error('[watcher]', err && err.message ? err.message : err);
      }
    }
    this._checkIdle(this.now());
  }

  /** Observation: every recent transcript of every project. */
  async _collectAll(now, push) {
    let projects = [];
    try {
      projects = await fsp.readdir(this.projectsDir, { withFileTypes: true });
    } catch {
      projects = [];
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const pdir = path.join(this.projectsDir, project.name);
      let entries;
      try {
        entries = await fsp.readdir(pdir, { withFileTypes: true });
      } catch {
        continue;
      }
      const recentSessions = new Set();
      for (const e of entries) {
        if (!e.isFile()) continue;
        const m = SESSION_FILE_RE.exec(e.name);
        if (!m) continue;
        const file = path.join(pdir, e.name);
        const st = await this._stat(file);
        if (!st) continue;
        const sid = m[1];
        if (this.files.has(fileKey(file)) || now - st.mtimeMs <= this.recentMs) {
          push({ file, st, sessionId: sid, sub: null });
          recentSessions.add(sid);
        }
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const sid = e.name;
        if (!recentSessions.has(sid) && !this.sessions.has(sid)) continue;
        await this._collectSubFiles(path.join(pdir, sid, 'subagents'), sid, now, push, 0);
      }
    }
  }

  /** Linked terminal sessions (also when observation is disabled). */
  async _collectLinked(ctx, now, push) {
    for (const link of ctx.links) {
      if (!link.active) continue;
      const dir = path.join(this.projectsDir, projectDirName(link.cwd));
      if (link.sessionId) {
        let file = path.join(dir, `${link.sessionId}.jsonl`);
        let st = await this._stat(file);
        if (!st && !this._trackedFileOf(link.sessionId)) {
          // Not where the naming rule says (long paths are shortened by Claude Code): look everywhere.
          const last = this.searches.get(link.sessionId) || 0;
          if (now - last >= LINKED_SEARCH_MS) {
            this.searches.set(link.sessionId, now);
            file = await this._findSessionFile(link.sessionId);
            st = file ? await this._stat(file) : null;
          }
        }
        if (st) {
          push({ file, st, sessionId: link.sessionId, sub: null });
          await this._collectSubFiles(path.join(path.dirname(file), link.sessionId, 'subagents'), link.sessionId, now, push, 0);
        }
      } else {
        // --continue / --resume picker: adopt the first transcript of the cwd written after the link.
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isFile()) continue;
          const m = SESSION_FILE_RE.exec(e.name);
          if (!m) continue;
          const file = path.join(dir, e.name);
          const st = await this._stat(file);
          if (st && st.mtimeMs > link.since) push({ file, st, sessionId: m[1], sub: null });
        }
      }
    }
    // Files already tracked for linked sessions, wherever they were found (subagents included).
    for (const [file, state] of this.files) {
      if (!ctx.bySid.has(state.sessionId) || state.ignored) continue;
      const link = ctx.bySid.get(state.sessionId);
      if (!link.active) continue;
      const st = await this._stat(file);
      if (st) push({ file: state.file || file, st, sessionId: state.sessionId, sub: state.sub });
    }
  }

  _trackedFileOf(sessionId) {
    for (const state of this.files.values()) {
      if (state.sessionId === sessionId && !state.sub && !state.ignored) return state.file;
    }
    return null;
  }

  async _findSessionFile(sessionId) {
    let projects;
    try {
      projects = await fsp.readdir(this.projectsDir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const project of projects) {
      if (!project.isDirectory()) continue;
      const file = path.join(this.projectsDir, project.name, `${sessionId}.jsonl`);
      if (await this._stat(file)) return file;
    }
    return null;
  }

  async _collectSubFiles(dir, sessionId, now, push, depth) {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // subagents/workflows/<run>/agent-*.jsonl
        if (depth < 2) await this._collectSubFiles(full, sessionId, now, push, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      const m = SUB_FILE_RE.exec(e.name);
      if (!m) continue;
      const st = await this._stat(full);
      if (!st) continue;
      if (this.files.has(fileKey(full)) || now - st.mtimeMs <= this.recentMs) {
        push({ file: full, st, sessionId, sub: { agentId: m[1], metaPath: full.replace(/\.jsonl$/, '.meta.json') } });
      }
    }
  }

  async _stat(file) {
    try {
      const st = await fsp.stat(file);
      return st.isFile() ? st : null;
    } catch {
      return null;
    }
  }

  async _readMeta(metaPath) {
    try {
      const raw = await fsp.readFile(metaPath, 'utf8');
      const meta = JSON.parse(raw);
      return meta && typeof meta === 'object' ? meta : {};
    } catch {
      return {};
    }
  }

  _ignoreSession(sessionId) {
    if (!sessionId) return;
    const s = this.sessions.get(sessionId);
    if (s && s.linkedAgentId) return; // a terminal session resumed by an HQ agent stays with its terminal
    if (s && s.rootId && this.manager.get(s.rootId)) this.manager.remove(s.rootId);
    this.sessions.delete(sessionId);
    for (const f of this.files.values()) if (f.sessionId === sessionId) f.ignored = true;
  }

  /** Adopts the transcript planned for a pending (--continue) link. */
  _adopt(c, ctx) {
    const p = ctx.adopt.get(c.file);
    if (!p) return null;
    ctx.adopt.delete(c.file);
    const i = ctx.pending.indexOf(p);
    if (i >= 0) ctx.pending.splice(i, 1);
    if (!this.manager.adoptTerminalSession(p.agentId, c.sessionId)) return null;
    const link = { ...p, sessionId: c.sessionId };
    ctx.bySid.set(c.sessionId, link);
    this._claimSession(c.sessionId, p.agentId);
    return link;
  }

  async _processFile(c, now, ctx) {
    const { file, st, sessionId } = c;
    let link = ctx.adopt.has(file) ? this._adopt(c, ctx) : ctx.bySid.get(sessionId) || null;
    if (link && !this.manager.get(link.agentId)) link = null;

    if (!link) {
      if (!this.enabled) return;
      if (this.manager.spawnedSessionIds.has(sessionId)) {
        this._ignoreSession(sessionId);
        const state = this.files.get(fileKey(file));
        if (state) state.ignored = true;
        else this.files.set(fileKey(file), { ignored: true, sessionId, file });
        return;
      }
    }
    let state = this.files.get(fileKey(file));
    if (state && state.ignored) {
      if (!link) return;
      this.files.delete(fileKey(file)); // a session HQ ignored is now owned by a terminal
      state = null;
    }
    if (!state) {
      const born = st.birthtimeMs && st.birthtimeMs > 0 ? st.birthtimeMs : st.ctimeMs;
      if (!link && this.minAgeMs > 0 && now - born < this.minAgeMs) return; // let HQ register its own sessions first
      state = {
        file,
        sessionId,
        sub: c.sub,
        subKey: null,
        meta: null,
        offset: 0,
        initialized: false,
        skipToNewline: false,
        splitter: null,
        firstUserSeen: false,
      };
      this.files.set(fileKey(file), state);
    }
    if (state.sub && !state.meta) {
      state.meta = await this._readMeta(state.sub.metaPath);
      state.subKey = typeof state.meta.toolUseId === 'string' && state.meta.toolUseId
        ? state.meta.toolUseId
        : `agent:${state.sub.agentId}`;
    }

    let size = st.size;
    if (state.initialized && size < state.offset) {
      // Truncated or replaced: start over from the beginning.
      state.offset = 0;
      state.splitter = null;
      state.skipToNewline = false;
    }
    const catchUp = !state.initialized;
    if (!state.initialized) {
      state.initialized = true;
      if (size > this.maxInitialBytes) {
        state.offset = Math.max(0, size - this.tailBytes);
        state.skipToNewline = state.offset > 0;
      } else {
        state.offset = 0;
      }
    }
    if (size <= state.offset) return;

    const lines = [];
    if (!state.splitter) state.splitter = new LineSplitter((line) => lines.push(line));
    else state.splitter.onLine = (line) => lines.push(line);

    let handle;
    try {
      handle = await fsp.open(file, 'r');
    } catch (err) {
      if (isIgnorableFsError(err)) return;
      throw err;
    }
    try {
      const end = Math.min(size, state.offset + MAX_READ_PER_POLL);
      const buf = Buffer.allocUnsafe(Math.min(READ_CHUNK, end - state.offset));
      while (state.offset < end) {
        const want = Math.min(buf.length, end - state.offset);
        const { bytesRead } = await handle.read(buf, 0, want, state.offset);
        if (bytesRead <= 0) break;
        state.offset += bytesRead;
        let chunk = Buffer.from(buf.subarray(0, bytesRead));
        if (state.skipToNewline) {
          const nl = chunk.indexOf(10);
          if (nl === -1) continue;
          chunk = chunk.subarray(nl + 1);
          state.skipToNewline = false;
        }
        state.splitter.push(chunk);
      }
    } finally {
      await handle.close().catch(() => {});
    }
    if (!lines.length) return;

    const fileTime = st.mtimeMs;
    const session = this._session(sessionId);
    if (link) session.linkedAgentId = link.agentId;
    session.lastActivityAt = catchUp ? Math.max(session.lastActivityAt, fileTime) : Math.max(session.lastActivityAt, now);
    if (state.sub) session.subActivity.set(state.subKey, catchUp ? fileTime : now);

    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // malformed line: skipped silently
      }
      if (!obj || typeof obj !== 'object') continue;
      try {
        this._handleLine(state, session, obj, catchUp, catchUp ? fileTime : now);
      } catch (err) {
        console.error('[watcher] ligne ignorée :', err && err.message ? err.message : err);
      }
    }
    if (session.rootId) this.manager.setQuiet(session.rootId, false);

    if (catchUp && session.rootId && !session.linkedAgentId) {
      // History replayed: reflect the real current state.
      const idle = now - session.lastActivityAt > this.idleMs;
      if (idle) this._markWaiting(session, session.lastActivityAt);
    }
  }

  _session(sessionId) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        sessionId,
        rootId: null,
        linkedAgentId: null,
        name: null,
        cwd: null,
        prompt: '',
        firstAt: null,
        lastActivityAt: 0,
        subActivity: new Map(),
        waiting: false,
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  _ensureRoot(session, time) {
    if (session.linkedAgentId) {
      // Terminal session: its agent exists already (never create an observed duplicate).
      session.rootId = this.manager.get(session.linkedAgentId) ? session.linkedAgentId : null;
      return session.rootId;
    }
    if (session.rootId && this.manager.get(session.rootId)) return session.rootId;
    const sid = session.sessionId;
    const agent = this.manager.createRoot({
      source: 'observed',
      id: `o-${sid.slice(0, 8)}`,
      name: session.name || cwdName(session.cwd) || `Session ${sid.slice(0, 4)}`,
      cwd: session.cwd || '',
      prompt: session.prompt || '',
      status: 'working',
      canControl: false,
      sessionId: sid,
      startedAt: session.firstAt || time,
    });
    session.rootId = agent.id;
    session.waiting = false;
    return agent.id;
  }

  _handleLine(state, session, obj, catchUp, fallbackTime) {
    const type = obj.type;
    const linked = Boolean(session.linkedAgentId);
    if (type === 'agent-name' || type === 'custom-title') {
      if (state.sub) return;
      const raw = type === 'agent-name' ? obj.agentName : obj.customTitle;
      const name = cleanName(raw);
      if (!name) return;
      session.name = name;
      // A terminal agent keeps the name chosen in PixelQG (titles are generated automatically).
      if (!linked && session.rootId && this.manager.get(session.rootId)) this.manager.patchAgent(session.rootId, { name });
      return;
    }
    if (type !== 'assistant' && type !== 'user') return;

    const time = parseTime(obj.timestamp, fallbackTime);
    if (!session.cwd && typeof obj.cwd === 'string' && obj.cwd) session.cwd = obj.cwd;
    if (session.firstAt == null) session.firstAt = time;

    const prompt = promptText(obj);
    if (!linked && !state.sub && prompt && !session.prompt && !obj.isSidechain) {
      session.prompt = prompt;
      if (session.rootId && this.manager.get(session.rootId)) this.manager.patchAgent(session.rootId, { prompt });
    }

    const rootId = this._ensureRoot(session, time);
    if (!rootId) return; // linked agent removed by the user
    const root = this.manager.get(rootId);
    if (!root) return;
    if (!linked) {
      if (root.cwd === '' && session.cwd) this.manager.patchAgent(rootId, { cwd: session.cwd });
      if (root.name.startsWith('Session ') && !session.name && session.cwd) {
        const n = cwdName(session.cwd);
        if (n) this.manager.patchAgent(rootId, { name: n });
      }
    }
    this.manager.setQuiet(rootId, catchUp);
    if (!catchUp) session.waiting = false;

    let key = null;
    if (state.sub) {
      key = state.subKey;
      const meta = state.meta || {};
      const info = {
        subagent_type: typeof meta.agentType === 'string' ? meta.agentType : undefined,
        description: typeof meta.description === 'string' ? meta.description : undefined,
        prompt: !state.firstUserSeen && prompt ? prompt : undefined,
      };
      if (type === 'user' && prompt) state.firstUserSeen = true;
      const subId = this.manager.ensureSub(rootId, key, info, time);
      if (!subId) return; // removed by the user
      if (!catchUp) session.subActivity.set(key, this.now());
    } else if (obj.isSidechain && typeof obj.agentId === 'string' && obj.agentId) {
      key = `agent:${obj.agentId}`;
    }

    // Interactive turn tracking (main thread of a terminal session only).
    const mainThread = linked && !key;
    if (mainThread && type === 'user' && prompt) {
      if (INTERRUPT_RE.test(prompt)) this.manager.terminalTurnEnd(rootId, null, time, true);
      else this.manager.terminalPrompt(rootId, prompt, time);
    }

    const event = {
      type,
      message: obj.message,
      parent_tool_use_id: key,
      session_id: session.sessionId,
    };
    if (obj.toolUseResult !== undefined) event.tool_use_result = obj.toolUseResult;
    this.manager.feed(rootId, event, { time });

    if (mainThread && type === 'assistant' && obj.message && TURN_END_REASONS.has(obj.message.stop_reason)) {
      this.manager.terminalTurnEnd(rootId, typeof obj.message.id === 'string' ? obj.message.id : null, time);
    }
  }

  _markWaiting(session, since) {
    const root = session.rootId ? this.manager.get(session.rootId) : null;
    if (!root) return;
    if (root.status === 'working' || root.status === 'starting') {
      this.manager.patchAgent(root.id, { status: 'waiting' });
      this.manager.setActivity(root.id, 'idle', 'En pause', null, since || this.now());
    }
    session.waiting = true;
  }

  _checkIdle(now) {
    for (const [sid, session] of Array.from(this.sessions.entries())) {
      const root = session.rootId ? this.manager.get(session.rootId) : null;
      if (!root) {
        if (now - session.lastActivityAt > this.removeMs) this.sessions.delete(sid);
        continue;
      }
      // Interactive terminal sessions: their status follows the turns, never the idle timers.
      if (!session.linkedAgentId) {
        if (now - session.lastActivityAt > this.removeMs) {
          this.manager.remove(root.id);
          this.sessions.delete(sid);
          continue;
        }
        if (now - session.lastActivityAt > this.idleMs) this._markWaiting(session, session.lastActivityAt);
      }
      // Subagents whose own transcript went quiet.
      for (const [key, last] of session.subActivity) {
        if (now - last <= this.idleMs) continue;
        const subId = this._subIdForKey(root.id, key);
        const sub = subId ? this.manager.get(subId) : null;
        if (sub && sub.status === 'working') {
          this.manager.patchAgent(sub.id, { status: 'waiting' });
          this.manager.setActivity(sub.id, 'idle', 'En pause', null, last);
          this._refreshSubMeta(session, key, sub.id);
        }
      }
    }
  }

  _subIdForKey(rootId, key) {
    const parserOwner = this.manager._rec(rootId);
    return parserOwner && parserOwner.parser ? parserOwner.parser.subIdForKey(key) : null;
  }

  /** A quiet subagent whose meta says "finished" is done rather than paused. */
  _refreshSubMeta(session, key, subId) {
    for (const state of this.files.values()) {
      if (state.sessionId !== session.sessionId || !state.sub || state.subKey !== key) continue;
      this._readMeta(state.sub.metaPath).then((meta) => {
        const sub = this.manager.get(subId);
        if (!sub || !meta || meta.finished !== true || sub.status !== 'waiting') return;
        const t = this.now();
        this.manager.patchAgent(subId, { status: 'done', endedAt: t });
        this.manager.setActivity(subId, 'done', 'Terminé ✓', null, t);
      }).catch(() => {});
      return;
    }
  }
}

module.exports = { SessionWatcher, defaultProjectsDir, projectDirName, promptText };
