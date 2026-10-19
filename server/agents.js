'use strict';

// AgentManager: owns every agent shown in PixelQG (spawned, demo, observed),
// spawns real Claude Code processes and turns their stream-json output into the
// Agent objects / log entries described in docs/CONTRACT.md (sections 1, 2, 4).
//
// A single StreamParser class interprets stream-json events. It is used for real
// processes, for the demo simulator (which emits synthetic events) and for the
// watcher (which converts transcript lines into the same event shapes).

const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const names = require('./names');

// ------------------------------------------------------------------------------------------------
// Constants shared with server.js (config, section 3.1)

const MAX_LOGS = 500;
const MAX_PROMPT = 100000;
const STDERR_TAIL = 4096;
const MAX_LINE_BYTES = 64 * 1024 * 1024;

const MODELS = Object.freeze([
  { value: '', label: 'Par défaut' },
  { value: 'haiku', label: 'Haiku (rapide, économique)' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'fable', label: 'Fable (le plus puissant)' },
]);

const PERMISSION_MODES = Object.freeze([
  { value: 'default', label: 'Prudent — lecture seule, refuse les modifications' },
  { value: 'acceptEdits', label: 'Modifications de fichiers autorisées' },
  { value: 'auto', label: 'Auto' },
  { value: 'plan', label: 'Plan — réfléchit sans agir' },
  { value: 'bypassPermissions', label: 'Tout autoriser (dangereux)', danger: true },
]);

const EFFORTS = Object.freeze(['', 'low', 'medium', 'high', 'xhigh', 'max']);

const ACTIVE_STATUSES = new Set(['starting', 'working', 'waiting']);

const LABELS = Object.freeze({
  starting: 'Démarre…',
  think: 'Réfléchit…',
  talk: 'Rédige une réponse',
  todo: 'Organise ses tâches',
  done: 'Terminé ✓',
  error: 'Erreur',
  idle: 'En pause',
  stopped: 'Arrêté',
  waitUser: 'Attend ta réponse',
});

// Interactive (terminal) sessions: Claude Code is up and waiting for the first prompt after this delay.
const TERMINAL_READY_MS = 2500;
// Exit codes of an interactive Claude Code session quit with Ctrl+C (treated like a normal exit).
const CTRL_C_EXIT_CODES = new Set([130, -1073741510, 3221225786]);
const TERMINAL_SESSION_RE = /^[0-9a-zA-Z][0-9a-zA-Z_-]{7,127}$/;
const LINK_ID_RE = /^[0-9a-f]{16,64}$/;

const TOOL_KINDS = Object.freeze({
  Read: 'read', NotebookRead: 'read',
  Glob: 'search', Grep: 'search', LS: 'search', ToolSearch: 'search',
  Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Write: 'write',
  Bash: 'bash', PowerShell: 'bash', BashOutput: 'bash', KillShell: 'bash', Monitor: 'bash', TaskStop: 'bash',
  WebFetch: 'web', WebSearch: 'web',
  Agent: 'task', Task: 'task', SendMessage: 'task', Workflow: 'task',
  TodoWrite: 'todo', TaskCreate: 'todo', TaskUpdate: 'todo', TaskList: 'todo', EnterPlanMode: 'todo', ExitPlanMode: 'todo',
  AskUserQuestion: 'talk',
});

// ------------------------------------------------------------------------------------------------
// Small helpers

// Agent profile names: "<plugin>:<agent>" (library wrappers) or a plain agent name.
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;

class HqError extends Error {
  /** @param {number} status HTTP status code @param {string} message French message */
  constructor(status, message) {
    super(message);
    this.name = 'HqError';
    this.status = status;
  }
}

function oneLine(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

/** Truncates to `max` code points, appending an ellipsis when cut. */
function truncate(value, max) {
  const s = String(value == null ? '' : value);
  if (s.length <= max) return s;
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  return chars.slice(0, Math.max(0, max - 1)).join('') + '…';
}

function baseName(p) {
  if (typeof p !== 'string' || !p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function hostOf(url) {
  try {
    return new URL(String(url)).host || '';
  } catch {
    return '';
  }
}

function shortToolName(name) {
  const s = String(name || 'outil');
  if (s.startsWith('mcp__')) {
    const parts = s.split('__').filter(Boolean);
    return parts[parts.length - 1] || s;
  }
  return s;
}

function prettyJson(value, max = 4000) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return truncate(text == null ? '' : text, max);
}

function roundCost(n) {
  return Math.round(n * 1e8) / 1e8;
}

/** Extracts readable text from a tool_result content (string or array of blocks). */
function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block) continue;
      if (typeof block === 'string') parts.push(block);
      else if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (block.type === 'image') parts.push('[image]');
      else if (block.type === 'tool_reference' && block.tool_name) parts.push(`[outil ${block.tool_name}]`);
    }
    return parts.join('\n');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return '';
}

function zeroTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function usageOf(u) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return {
    input: n(u && u.input_tokens),
    output: n(u && u.output_tokens),
    cacheRead: n(u && u.cache_read_input_tokens),
    cacheWrite: n(u && u.cache_creation_input_tokens),
  };
}

/** Maps a raw tool name to an activity kind (contract section 4). */
function toolKind(name) {
  if (!name || typeof name !== 'string') return 'tool';
  if (name.startsWith('mcp__')) return 'tool';
  return Object.prototype.hasOwnProperty.call(TOOL_KINDS, name) ? TOOL_KINDS[name] : 'tool';
}

/** Builds the short French activity label (≤ 60 chars) for a tool call. */
function toolLabel(name, input) {
  const inp = input && typeof input === 'object' ? input : {};
  const kind = toolKind(name);
  let label;
  switch (kind) {
    case 'read':
      label = `Lit ${baseName(inp.file_path || inp.notebook_path || inp.path) || 'un fichier'}`;
      break;
    case 'search': {
      if (name === 'LS') {
        label = `Cherche dans ${baseName(inp.path) || 'le dossier'}`;
      } else {
        const pattern = oneLine(inp.pattern || inp.query || inp.glob || '');
        label = pattern ? `Cherche ${pattern}` : 'Cherche dans le projet';
      }
      break;
    }
    case 'edit':
      label = `Modifie ${baseName(inp.file_path || inp.notebook_path) || 'un fichier'}`;
      break;
    case 'write':
      label = `Écrit ${baseName(inp.file_path) || 'un fichier'}`;
      break;
    case 'bash': {
      const what = oneLine(inp.description || inp.command || '');
      if (what) label = `Exécute ${truncate(what, 40)}`;
      else if (name === 'BashOutput' || name === 'Monitor') label = 'Surveille une commande';
      else if (name === 'KillShell' || name === 'TaskStop') label = 'Arrête une commande';
      else label = 'Exécute une commande';
      break;
    }
    case 'web':
      if (name === 'WebSearch') {
        const q = oneLine(inp.query || '');
        label = q ? `Recherche « ${truncate(q, 40)} »` : 'Recherche sur le web';
      } else {
        const host = hostOf(inp.url);
        label = host ? `Consulte ${host}` : 'Consulte une page web';
      }
      break;
    case 'task': {
      const what = oneLine(inp.description || inp.summary || inp.name || inp.subagent_type || (inp.to ? `message à ${inp.to}` : ''));
      label = `Délègue : ${what || 'une sous-tâche'}`;
      break;
    }
    case 'todo':
      label = LABELS.todo;
      break;
    case 'talk':
      label = 'Pose une question';
      break;
    default:
      label = `Utilise ${shortToolName(name)}`;
  }
  return truncate(label, 60);
}

function resultErrorMessage(ev) {
  const fromResult = typeof ev.result === 'string' ? oneLine(ev.result) : '';
  if (fromResult) return truncate(fromResult, 500);
  switch (ev.subtype) {
    case 'error_max_turns':
      return 'Nombre maximal de tours atteint.';
    case 'error_during_execution':
      return "Erreur pendant l'exécution.";
    case 'error_max_budget_usd':
      return 'Budget maximal atteint.';
    default:
      if (Array.isArray(ev.errors) && ev.errors.length) return truncate(oneLine(ev.errors.join(' ')), 500);
      return 'Claude Code a signalé une erreur.';
  }
}

function formatSeconds(ms) {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  return s.toLocaleString('fr-FR', { maximumFractionDigits: 1 });
}

function formatCost(usd) {
  return usd.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

// ------------------------------------------------------------------------------------------------
// Validation (section 3)

const NAME_RE = /^[\p{L}\p{N} _.-]+$/u;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function validatePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new HqError(400, 'Le prompt est requis.');
  }
  if (prompt.length > MAX_PROMPT) {
    throw new HqError(400, 'Le prompt est trop long (100 000 caractères maximum).');
  }
  return prompt;
}

function isBlank(value) {
  return value === undefined || value === null || value === '';
}

/** Optional agent name: 1–24 chars of letters, digits, spaces, "_", ".", "-", not starting with "-". */
function validateName(value) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string') throw new HqError(400, 'Nom invalide : une chaîne de caractères est attendue.');
  const trimmed = value.trim();
  const len = Array.from(trimmed).length;
  if (len < 1 || len > 24 || !NAME_RE.test(trimmed) || trimmed.startsWith('-')) {
    throw new HqError(400, 'Nom invalide : 1 à 24 caractères (lettres, chiffres, espaces, « _ », « . », « - »), sans tiret au début.');
  }
  return trimmed;
}

/** Optional #RRGGBB color (normalized to upper case). */
function validateColor(value) {
  if (isBlank(value)) return null;
  if (typeof value !== 'string' || !COLOR_RE.test(value)) {
    throw new HqError(400, 'Couleur invalide : format attendu #RRGGBB.');
  }
  return value.toUpperCase();
}

/** Optional model alias from MODELS ("" = Claude Code default). */
function validateModel(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || !MODELS.some((m) => m.value === value)) {
    throw new HqError(400, 'Modèle inconnu.');
  }
  return value;
}

/** Optional permission mode from PERMISSION_MODES; returns `fallback` when absent. */
function validatePermissionMode(value, fallback = 'default') {
  if (isBlank(value)) return fallback;
  if (typeof value !== 'string' || !PERMISSION_MODES.some((p) => p.value === value)) {
    throw new HqError(400, 'Mode de permission inconnu.');
  }
  return value;
}

/** Optional working directory: an absolute path to an existing directory (default `defaultCwd`). */
function validateCwd(value, defaultCwd) {
  if (isBlank(value)) return defaultCwd;
  if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
    throw new HqError(400, 'Dossier de travail invalide.');
  }
  const raw = value.trim();
  if (!path.isAbsolute(raw)) {
    throw new HqError(400, 'Le dossier de travail doit être un chemin absolu.');
  }
  const resolved = path.resolve(raw);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    throw new HqError(400, "Le dossier de travail n'existe pas ou n'est pas un dossier.");
  }
  return resolved;
}

/**
 * Validates the body of POST /api/agents. Throws HqError(400) with a French message.
 * @returns {{prompt: string, name: string|null, color: string|null, model: string, cwd: string, permissionMode: string, effort: string}}
 */
function validateCreateInput(body, opts = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HqError(400, 'Corps de requête invalide : un objet JSON est attendu.');
  }
  const prompt = validatePrompt(body.prompt);
  const name = validateName(body.name);
  const color = validateColor(body.color);
  const model = validateModel(body.model);
  const cwd = validateCwd(body.cwd, opts.defaultCwd || os.homedir());
  const permissionMode = validatePermissionMode(body.permissionMode);

  let effort = '';
  if (body.effort !== undefined && body.effort !== null) {
    if (typeof body.effort !== 'string' || !EFFORTS.includes(body.effort)) {
      throw new HqError(400, "Niveau d'effort inconnu.");
    }
    effort = body.effort;
  }

  return { prompt, name, color, model, cwd, permissionMode, effort };
}

// ------------------------------------------------------------------------------------------------
// Line splitter: byte-level newline splitting (safe for UTF-8), handles \r\n and huge lines.

class LineSplitter {
  /**
   * @param {(line: string) => void} onLine
   * @param {{maxLineBytes?: number, onOverflow?: () => void}} [opts]
   */
  constructor(onLine, opts = {}) {
    this.onLine = onLine;
    this.maxLineBytes = opts.maxLineBytes || MAX_LINE_BYTES;
    this.onOverflow = opts.onOverflow || null;
    this.parts = [];
    this.size = 0;
    this.discarding = false;
  }

  /** @param {Buffer|string} chunk */
  push(chunk) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(10, start);
      if (nl === -1) {
        if (start < buf.length) this._append(buf.subarray(start));
        return;
      }
      const piece = buf.subarray(start, nl);
      if (this.discarding) {
        this.discarding = false;
        this.parts = [];
        this.size = 0;
      } else {
        const line = this.parts.length ? Buffer.concat([...this.parts, piece]) : piece;
        this.parts = [];
        this.size = 0;
        this._emit(line);
      }
      start = nl + 1;
    }
  }

  /** Flushes the trailing partial line (call when the stream ends). */
  end() {
    if (!this.discarding && this.parts.length) {
      const line = Buffer.concat(this.parts);
      this.parts = [];
      this.size = 0;
      this._emit(line);
    }
    this.parts = [];
    this.size = 0;
    this.discarding = false;
  }

  /** Bytes currently buffered as an incomplete line. */
  get pendingBytes() {
    return this.size;
  }

  _append(piece) {
    if (this.discarding) return;
    this.parts.push(piece);
    this.size += piece.length;
    if (this.size > this.maxLineBytes) {
      this.parts = [];
      this.size = 0;
      this.discarding = true;
      if (this.onOverflow) this.onOverflow();
    }
  }

  _emit(buf) {
    let text = buf.toString('utf8');
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (text.trim() === '') return;
    this.onLine(text);
  }
}

// ------------------------------------------------------------------------------------------------
// StreamParser: interprets stream-json events for one root agent and its subagents.

class StreamParser {
  /**
   * @param {AgentManager} manager
   * @param {string} rootId
   */
  constructor(manager, rootId) {
    this.manager = manager;
    this.rootId = rootId;
    this.subs = new Map(); // parent_tool_use_id (or synthetic key) -> sub agent id
    this.removedKeys = new Set();
    this.tools = new Map(); // tool_use_id -> { name, agentId }
    this.resultSeen = false;
    this.turnBase = zeroTokens();
  }

  /** Called when a new turn starts (process spawn, follow-up, demo scenario). */
  beginTurn() {
    this.resultSeen = false;
    const root = this.manager._rec(this.rootId);
    this.turnBase = root ? { ...root.agent.tokens } : zeroTokens();
  }

  /** Returns the subagent id registered under a key, if any. */
  subIdForKey(key) {
    return this.subs.get(key) || null;
  }

  /** Stops routing events of a removed subagent (they are dropped from now on). */
  forgetSub(subId) {
    for (const [key, id] of this.subs) {
      if (id === subId) {
        this.subs.delete(key);
        this.removedKeys.add(key);
      }
    }
  }

  /**
   * Handles one stream-json event.
   * @param {object} ev
   * @param {{time?: number}} [ctx] time = event timestamp in ms (defaults to now)
   */
  handle(ev, ctx = {}) {
    if (!ev || typeof ev !== 'object') return;
    if (!this.manager._rec(this.rootId)) return;
    const t = typeof ctx.time === 'number' && Number.isFinite(ctx.time) ? ctx.time : Date.now();
    switch (ev.type) {
      case 'system':
        this._system(ev, t);
        break;
      case 'assistant':
        this._assistant(ev, t);
        break;
      case 'user':
        this._user(ev, t);
        break;
      case 'result':
        this._result(ev, t);
        break;
      default:
        // rate_limit_event, stream_event, post_turn_summary, … are intentionally ignored.
        break;
    }
  }

  /**
   * Creates the subagent registered under `key` if it does not exist yet.
   * @param {string} key parent tool_use id (or a synthetic key such as "agent:<id>")
   * @param {{subagent_type?: string, description?: string, prompt?: string}} info
   * @param {number} [t]
   * @returns {string|null} sub id
   */
  ensureSub(key, info = {}, t = Date.now()) {
    if (!key || this.removedKeys.has(key)) return null;
    const m = this.manager;
    const existingId = this.subs.get(key);
    if (existingId) {
      const rec = m._rec(existingId);
      if (rec) {
        const patch = {};
        if (info.subagent_type && rec.roleDefaulted) {
          patch.role = String(info.subagent_type);
          rec.roleDefaulted = false;
        }
        if (!rec.agent.prompt && (info.description || info.prompt)) {
          patch.prompt = [info.description, info.prompt].filter(Boolean).join('\n\n');
        }
        if (Object.keys(patch).length) m._patch(existingId, patch);
        return existingId;
      }
      this.subs.delete(key);
    }
    const role = info.subagent_type ? String(info.subagent_type) : null;
    const prompt = [info.description, info.prompt].filter((s) => typeof s === 'string' && s).join('\n\n');
    const rec = m._createSub(this.rootId, { role, prompt, time: t, description: info.description });
    if (!rec) return null;
    rec.roleDefaulted = !role;
    this.subs.set(key, rec.agent.id);
    return rec.agent.id;
  }

  _target(ev, t) {
    const key = ev.parent_tool_use_id;
    if (!key) return this.rootId;
    if (this.removedKeys.has(key)) return null;
    const known = this.subs.get(key);
    if (known && this.manager._rec(known)) return known;
    return this.ensureSub(key, { subagent_type: ev.subagent_type, description: ev.task_description }, t);
  }

  _system(ev, t) {
    const m = this.manager;
    switch (ev.subtype) {
      case 'init': {
        if (ev.parent_tool_use_id) return;
        const root = m._rec(this.rootId);
        const patch = {};
        if (typeof ev.session_id === 'string' && ev.session_id) patch.sessionId = ev.session_id;
        if (typeof ev.model === 'string' && ev.model) patch.model = ev.model;
        if (root.agent.status === 'starting' || root.agent.status === 'waiting') patch.status = 'working';
        m._patch(this.rootId, patch);
        if (patch.sessionId) m._onSessionId(this.rootId, patch.sessionId);
        m._setActivity(this.rootId, 'think', LABELS.think, null, t);
        m._log(this.rootId, {
          t,
          type: 'system',
          text: `Session ${root.agent.turns > 0 ? 'reprise' : 'démarrée'}${ev.model ? ` · modèle ${ev.model}` : ''}`,
          detail: prettyJson({ session_id: ev.session_id, model: ev.model, cwd: ev.cwd, permissionMode: ev.permissionMode }),
        });
        break;
      }
      case 'task_started': {
        const id = this.ensureSub(ev.tool_use_id, ev, t);
        const existing = id ? m._rec(id) : null;
        if (existing && !ACTIVE_STATUSES.has(existing.agent.status)) {
          // The same subagent is resumed (continued task): back to work.
          m._patch(id, { status: 'working', endedAt: null, error: null });
          m._setActivity(id, 'think', LABELS.think, null, t);
        }
        if (id) {
          m._log(id, {
            t,
            type: 'system',
            text: `Mission reçue : ${oneLine(ev.description || ev.subagent_type || 'sous-tâche')}`,
            detail: typeof ev.prompt === 'string' ? truncate(ev.prompt, 4000) : undefined,
          });
        }
        break;
      }
      case 'task_progress': {
        const id = this.ensureSub(ev.tool_use_id, ev, t);
        if (!id) return;
        const rec = m._rec(id);
        if (!ACTIVE_STATUSES.has(rec.agent.status)) return;
        const kind = ev.last_tool_name ? toolKind(ev.last_tool_name) : rec.agent.activity.kind;
        const label = ev.description ? truncate(oneLine(ev.description), 60) : rec.agent.activity.label;
        m._setActivity(id, kind, label, ev.last_tool_name || rec.agent.activity.tool || null, t);
        break;
      }
      case 'task_notification': {
        const id = this.ensureSub(ev.tool_use_id, ev, t);
        if (!id) return;
        const status = String(ev.status || 'completed').toLowerCase();
        let final = 'done';
        if (/fail|error/.test(status)) final = 'error';
        else if (/kill|stop|cancel|abort/.test(status)) final = 'stopped';
        this._finishSub(id, final, typeof ev.summary === 'string' ? ev.summary : '', t);
        break;
      }
      case 'compact_boundary':
        m._log(this.rootId, { t, type: 'system', text: 'Contexte compacté pour libérer de la place' });
        break;
      case 'api_retry':
        m._log(this.rootId, { t, type: 'system', text: "Nouvelle tentative d'appel à l'API…" });
        break;
      default:
        break;
    }
  }

  _assistant(ev, t) {
    const id = this._target(ev, t);
    if (!id) return;
    const m = this.manager;
    const rec = m._rec(id);
    const msg = ev.message && typeof ev.message === 'object' ? ev.message : {};
    if (msg.usage) m._addUsage(id, msg.id, msg.usage);
    if (typeof msg.id === 'string') rec.lastMsgId = msg.id;
    if (typeof msg.model === 'string' && msg.model && !msg.model.startsWith('<') && rec.agent.model !== msg.model) {
      m._patch(id, { model: msg.model });
    }
    const active = this._activate(rec);
    let content = [];
    if (Array.isArray(msg.content)) content = msg.content;
    else if (typeof msg.content === 'string') content = [{ type: 'text', text: msg.content }];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        if (active) m._setActivity(id, 'think', LABELS.think, null, t);
        const thought = typeof block.thinking === 'string' ? block.thinking.trim() : '';
        if (thought) m._log(id, { t, type: 'thinking', kind: 'think', text: thought, detail: truncate(thought, 4000) });
      } else if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text.trim() : '';
        if (!text) continue;
        if (active) m._setActivity(id, 'talk', LABELS.talk, null, t);
        m._patch(id, { lastText: truncate(text, 280) });
        m._log(id, { t, type: 'text', kind: 'talk', text, detail: truncate(text, 4000) });
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        this._toolUse(id, block, active, t);
      }
    }
  }

  _toolUse(id, block, active, t) {
    const m = this.manager;
    const rec = m._rec(id);
    const name = typeof block.name === 'string' && block.name ? block.name : 'outil';
    const input = block.input && typeof block.input === 'object' ? block.input : {};
    const kind = toolKind(name);
    const label = toolLabel(name, input);
    m._patch(id, { toolCount: rec.agent.toolCount + 1 });
    if (block.id) this.tools.set(block.id, { name, agentId: id });
    if (active) m._setActivity(id, kind, label, name, t);
    m._log(id, { t, type: 'tool', tool: name, kind, text: label, detail: prettyJson(input) });
    const spawnsAgent = name === 'Agent' || (name === 'Task' && (input.prompt || input.subagent_type));
    if (spawnsAgent && block.id) {
      this.ensureSub(block.id, { subagent_type: input.subagent_type, description: input.description, prompt: input.prompt }, t);
    }
  }

  _user(ev, t) {
    const id = this._target(ev, t);
    if (!id) return;
    const m = this.manager;
    const content = ev.message && ev.message.content;
    if (!Array.isArray(content)) return; // plain prompt echo: already known
    const rec = m._rec(id);
    let sawResult = false;
    for (const block of content) {
      if (!block || block.type !== 'tool_result') continue;
      sawResult = true;
      const info = this.tools.get(block.tool_use_id);
      const toolName = info ? info.name : undefined;
      const isError = block.is_error === true;
      const raw = contentText(block.content);
      const excerpt = truncate(raw, 4000);
      const who = toolName ? shortToolName(toolName) : "l'outil";
      const head = isError ? `Échec de ${who}` : `Résultat de ${who}`;
      const summary = oneLine(raw);
      m._log(id, {
        t,
        type: 'tool_result',
        tool: toolName,
        kind: isError ? 'error' : toolName ? toolKind(toolName) : undefined,
        text: summary ? `${head} : ${summary}` : head,
        detail: excerpt || undefined,
      });

      if (id === this.rootId && this.subs.has(block.tool_use_id)) {
        this._subToolResult(this.subs.get(block.tool_use_id), ev, block, isError, raw, t);
      }
    }
    if (sawResult && this._activate(rec)) m._setActivity(id, 'think', LABELS.think, null, t);
  }

  _subToolResult(subId, ev, block, isError, raw, t) {
    const m = this.manager;
    const sub = m._rec(subId);
    if (!sub) return;
    const tur = ev.tool_use_result || ev.toolUseResult;
    const turStatus = tur && typeof tur === 'object' ? String(tur.status || '') : '';
    const launchedOnly = /launch|spawn|running|pending|queued|background/i.test(turStatus) || /^async agent launched/i.test(String(raw || '').trim());
    if (launchedOnly) return; // background agent: it keeps working, task_notification will finish it

    // The hand-back carries the final usage of the sub's last message: merge it (deduped).
    if (tur && typeof tur === 'object' && tur.usage && sub.lastMsgId) {
      const last = sub.usage.get(sub.lastMsgId);
      const fin = usageOf(tur.usage);
      if (last && last.input === fin.input && last.cacheRead === fin.cacheRead && last.cacheWrite === fin.cacheWrite) {
        m._addUsage(subId, sub.lastMsgId, tur.usage);
      }
    }
    let summary = '';
    if (tur && typeof tur === 'object' && Array.isArray(tur.content)) summary = contentText(tur.content);
    if (!summary) summary = raw;
    this._finishSub(subId, isError ? 'error' : 'done', summary, t);
  }

  _finishSub(subId, status, summary, t) {
    const m = this.manager;
    const rec = m._rec(subId);
    if (!rec) return;
    const text = typeof summary === 'string' ? summary.trim() : '';
    if (!ACTIVE_STATUSES.has(rec.agent.status)) {
      if (text && !rec.agent.resultText) m._patch(subId, { resultText: truncate(text, 2000) });
      return;
    }
    const patch = { status, endedAt: t };
    if (text && !rec.agent.resultText) patch.resultText = truncate(text, 2000);
    if (status === 'error') patch.error = text ? truncate(oneLine(text), 500) : 'Le sous-agent a échoué.';
    m._patch(subId, patch);
    if (status === 'done') m._setActivity(subId, 'done', LABELS.done, null, t);
    else if (status === 'error') m._setActivity(subId, 'error', LABELS.error, null, t);
    else m._setActivity(subId, 'idle', LABELS.stopped, null, t);
    m._log(subId, {
      t,
      type: status === 'error' ? 'error' : 'result',
      kind: status === 'error' ? 'error' : 'done',
      text: status === 'done' ? 'Mission terminée ✓' : status === 'error' ? 'Mission échouée' : 'Mission interrompue',
      detail: text ? truncate(text, 4000) : undefined,
    });
  }

  _result(ev, t) {
    if (ev.parent_tool_use_id) return;
    const m = this.manager;
    const root = m._rec(this.rootId);
    this.resultSeen = true;

    // Stream usage is captured at message start (low output counts): reconcile with the
    // final per-turn usage of the main thread, adding only what was not counted yet.
    if (ev.usage && typeof ev.usage === 'object') {
      const fin = usageOf(ev.usage);
      const cur = root.agent.tokens;
      const base = this.turnBase || zeroTokens();
      const delta = {};
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        const counted = cur[k] - (base[k] || 0);
        delta[k] = fin[k] > counted ? fin[k] - counted : 0;
      }
      m._addTokens(this.rootId, delta);
    }

    const patch = { turns: root.agent.turns + 1, endedAt: t };
    if (typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd)) {
      patch.costUsd = roundCost((root.agent.costUsd || 0) + ev.total_cost_usd);
    }
    if (typeof ev.session_id === 'string' && ev.session_id && !root.agent.sessionId) {
      patch.sessionId = ev.session_id;
    }
    if (typeof ev.result === 'string' && ev.result.trim()) patch.resultText = truncate(ev.result.trim(), 2000);
    const isError = ev.is_error === true;
    if (isError) {
      patch.status = 'error';
      patch.error = resultErrorMessage(ev);
    } else {
      patch.status = 'done';
      patch.error = null;
    }
    m._patch(this.rootId, patch);
    if (patch.sessionId) m._onSessionId(this.rootId, patch.sessionId);
    if (isError) m._setActivity(this.rootId, 'error', LABELS.error, null, t);
    else m._setActivity(this.rootId, 'done', LABELS.done, null, t);

    for (const subId of m._subIdsOf(this.rootId)) {
      const sub = m._rec(subId);
      if (sub && ACTIVE_STATUSES.has(sub.agent.status)) this._finishSub(subId, 'done', '', t);
    }

    const parts = [];
    if (typeof ev.duration_ms === 'number') parts.push(`${formatSeconds(ev.duration_ms)} s`);
    if (typeof ev.total_cost_usd === 'number') parts.push(`${formatCost(ev.total_cost_usd)} $`);
    m._log(this.rootId, {
      t,
      type: isError ? 'error' : 'result',
      kind: isError ? 'error' : 'done',
      text: isError ? `Erreur : ${patch.error}` : `Terminé${parts.length ? ` en ${parts.join(' · ')}` : ''}`,
      detail: typeof ev.result === 'string' && ev.result ? truncate(ev.result, 4000) : undefined,
    });
  }

  /** Marks a starting/waiting agent as working; returns whether activity updates apply. */
  _activate(rec) {
    const status = rec.agent.status;
    if (status === 'starting' || status === 'waiting') {
      this.manager._patch(rec.agent.id, { status: 'working' });
      return true;
    }
    return status === 'working';
  }
}

// ------------------------------------------------------------------------------------------------
// Process tree termination

function killProcessTree(child, platform = process.platform) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.once('exit', done);
    if (platform === 'win32' && child.pid) {
      const taskkill = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
      const exe = fs.existsSync(taskkill) ? taskkill : 'taskkill';
      try {
        childProcess.execFile(exe, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, (err) => {
          if (err) {
            try {
              child.kill();
            } catch {
              /* already gone */
            }
          }
          setTimeout(done, 1500).unref();
        });
      } catch {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
        setTimeout(done, 1500).unref();
      }
    } else {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
        setTimeout(done, 500).unref();
      }, 3000);
      timer.unref();
    }
  });
}

/**
 * Kills a process tree by pid (interactive terminal sessions, where PixelQG does not own the
 * ChildProcess object). Resolves once taskkill finished (or after the POSIX signal was sent).
 */
function killPidTree(pid, platform = process.platform) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve();
    if (platform === 'win32') {
      const taskkill = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
      const exe = fs.existsSync(taskkill) ? taskkill : 'taskkill';
      try {
        childProcess.execFile(exe, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => resolve());
      } catch {
        resolve();
      }
      return;
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    resolve();
  });
}

/** Cleans a display name coming from a command line (-n/--name): no control chars, ≤ 24 chars. */
function cleanDisplayName(value) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return (chars.length > 24 ? chars.slice(0, 24).join('') : s).trim();
}

function isPid(value) {
  return Number.isInteger(value) && value > 0 && value <= 0xffffffff;
}

// ------------------------------------------------------------------------------------------------
// AgentManager

class AgentManager extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {{command: string, prefixArgs: string[], path: string}|null} [opts.claude] resolved binary
   * @param {() => ({command: string, prefixArgs: string[], path: string}|null)} [opts.resolveClaude] re-resolution when missing
   * @param {Function} [opts.spawn] child_process.spawn replacement (tests)
   * @param {string} [opts.defaultCwd]
   * @param {{pluginDirArgs: () => string[], hasProfile: (v: string) => boolean}|null} [opts.library] skills library (docs/LIBRARY.md)
   */
  constructor(opts = {}) {
    super();
    this.setMaxListeners(50);
    this.claude = opts.claude || null;
    this.library = opts.library || null;
    this.resolveClaude = typeof opts.resolveClaude === 'function' ? opts.resolveClaude : null;
    this.spawnFn = typeof opts.spawn === 'function' ? opts.spawn : childProcess.spawn;
    this.platform = opts.platform || process.platform;
    this.defaultCwd = opts.defaultCwd || os.homedir();
    this.records = new Map(); // id -> record
    this.counters = new Map(); // id prefix -> last number
    /** Session ids of agents spawned by PixelQG (the watcher skips them). */
    this.spawnedSessionIds = new Set();
    /** Terminal links: linkId -> agent id (see linkTerminal). */
    this.links = new Map();
    this.terminalReadyMs = opts.terminalReadyMs != null ? opts.terminalReadyMs : TERMINAL_READY_MS;
  }

  // ---------------------------------------------------------------- public read API

  /** @returns {object[]} every agent, in creation order */
  list() {
    return Array.from(this.records.values(), (r) => r.agent);
  }

  /** @returns {object|null} */
  get(id) {
    const rec = this.records.get(id);
    return rec ? rec.agent : null;
  }

  /** @returns {object[]|null} the last 500 log entries of an agent */
  getLogs(id) {
    const rec = this.records.get(id);
    return rec ? rec.logs.slice() : null;
  }

  usedNames() {
    return this.list().map((a) => a.name);
  }

  usedColors() {
    return this.list().map((a) => a.color);
  }

  nextName() {
    return names.pickName(this.usedNames());
  }

  nextColor() {
    return names.pickColor(this.usedColors());
  }

  /** Whether a usable Claude Code binary is known (re-resolves when missing). */
  ensureClaude() {
    if (!this.claude && this.resolveClaude) {
      try {
        this.claude = this.resolveClaude() || null;
      } catch {
        this.claude = null;
      }
      if (this.claude) this.emit('claude', this.claude);
    }
    return this.claude;
  }

  // ---------------------------------------------------------------- spawned agents

  /**
   * Validates the input and launches a real Claude Code agent.
   * @param {object} body raw POST /api/agents body
   * @returns {object} the new agent
   */
  createAgent(body) {
    const input = validateCreateInput(body, { defaultCwd: this.defaultCwd });
    const profile = this.validateProfile(body.profile);
    if (!this.ensureClaude()) {
      throw new HqError(503, "Claude Code est introuvable. Installe-le (npm install -g @anthropic-ai/claude-code) ou définis la variable d'environnement CLAUDE_BIN.");
    }
    const rec = this._createRoot({
      source: 'spawned',
      name: input.name || this.nextName(),
      color: input.color || this.nextColor(),
      model: input.model || null,
      cwd: input.cwd,
      prompt: input.prompt,
      status: 'starting',
      canControl: true,
      profile,
    });
    rec.options = { permissionMode: input.permissionMode, model: input.model, effort: input.effort, profile };
    this._beginTurn(rec, input.prompt);
    this._spawnTurn(rec, input.prompt, false);
    return rec.agent;
  }

  /**
   * Optional library profile (POST /api/agents, POST /api/terminals): null when absent, else one of
   * library.profiles[].value. Throws HqError(400) otherwise.
   * @returns {string|null}
   */
  validateProfile(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !PROFILE_RE.test(value) || !this.library || !this.library.hasProfile(value)) {
      throw new HqError(400, 'Profil inconnu : il a peut-être été désactivé ou retiré de la bibliothèque.');
    }
    return value;
  }

  /** ["--plugin-dir", <library dir>] when the library has at least one wrapper plugin, else []. */
  pluginDirArgs() {
    if (!this.library) return [];
    try {
      const args = this.library.pluginDirArgs();
      return Array.isArray(args) ? args : [];
    } catch {
      return [];
    }
  }

  /**
   * Starts a follow-up turn on a finished root agent.
   * @returns {object} the agent
   */
  sendMessage(id, body) {
    const rec = this._mustGet(id);
    if (rec.agent.interactive || rec.agent.source === 'terminal') {
      throw new HqError(409, 'Cet agent tourne dans un terminal : réponds-lui directement dans son terminal.');
    }
    const prompt = validatePrompt(body && typeof body === 'object' ? body.prompt : undefined);
    const agent = rec.agent;
    if (agent.kind !== 'root') {
      throw new HqError(409, "Seul l'agent principal peut recevoir un nouveau message.");
    }
    if (!agent.canControl || agent.source === 'observed') {
      throw new HqError(409, 'Cette session externe est seulement observée : impossible de lui écrire depuis PixelQG.');
    }
    const exiting = rec.proc && (rec.proc.resultSeen || rec.proc.stopRequested);
    if (ACTIVE_STATUSES.has(agent.status) || (rec.proc && !exiting) || rec.pendingTurn) {
      throw new HqError(409, "L'agent travaille encore : attends la fin de son tour ou arrête-le.");
    }
    if (rec.controller && typeof rec.controller.message === 'function') {
      rec.controller.message(prompt);
      return rec.agent;
    }
    if (!agent.sessionId) {
      throw new HqError(409, "Aucune session à reprendre : l'agent n'a pas encore de sessionId.");
    }
    if (!this.ensureClaude()) {
      throw new HqError(503, "Claude Code est introuvable. Installe-le (npm install -g @anthropic-ai/claude-code) ou définis la variable d'environnement CLAUDE_BIN.");
    }
    this._beginTurn(rec, prompt);
    if (rec.proc) {
      // The previous process already delivered its result and is exiting: start the
      // follow-up as soon as it is gone (forcing it after a few seconds).
      const old = rec.proc;
      rec.pendingTurn = { prompt, resume: true };
      const timer = setTimeout(() => {
        if (rec.proc === old && !old.finished) old.killPromise = old.killPromise || killProcessTree(old.child, this.platform);
      }, 5000);
      timer.unref();
      rec.pendingTurn.timer = timer;
    } else {
      this._spawnTurn(rec, prompt, true);
    }
    return rec.agent;
  }

  /**
   * Stops an agent (a subagent stops its root). Idempotent for finished agents.
   * @returns {object} the agent
   */
  stop(id) {
    const rec = this._mustGet(id);
    const root = rec.agent.kind === 'sub' ? this.records.get(rec.agent.parentId) || rec : rec;
    if (!root.agent.canControl || root.agent.source === 'observed') {
      throw new HqError(409, "Impossible d'arrêter une session externe : elle est seulement observée.");
    }
    if (root.agent.source === 'terminal') {
      this._stopTerminalSession(root, 'Arrêté par l’utilisateur');
      return rec.agent;
    }
    const running = ACTIVE_STATUSES.has(root.agent.status) || Boolean(root.proc);
    if (!running) {
      // A resting demo agent would start a new scenario on its own: freeze it.
      if (root.agent.source === 'demo' && root.controller && root.agent.status === 'done') {
        root.controller.stop();
        const t = Date.now();
        this._patch(root.agent.id, { status: 'stopped', endedAt: root.agent.endedAt || t });
        this._setActivity(root.agent.id, 'idle', LABELS.stopped, null, t);
        this._log(root.agent.id, { t, type: 'system', text: 'Arrêté par l’utilisateur' });
      }
      return rec.agent;
    }
    this._clearPendingTurn(root);
    if (root.proc) {
      root.proc.stopRequested = true;
      root.proc.killPromise = killProcessTree(root.proc.child, this.platform);
    }
    if (root.controller && typeof root.controller.stop === 'function') root.controller.stop();
    if (ACTIVE_STATUSES.has(root.agent.status)) this._markStopped(root, 'Arrêté par l’utilisateur');
    return rec.agent;
  }

  /**
   * Removes an agent from the list. Roots are stopped first and take their subs with them.
   * Removing a subagent only hides it (its root keeps working).
   */
  remove(id) {
    const rec = this._mustGet(id);
    if (rec.agent.kind === 'sub') {
      const root = this.records.get(rec.agent.parentId);
      if (root && root.parser) root.parser.forgetSub(id);
      this._delete(id);
      return true;
    }
    this._clearPendingTurn(rec);
    if (rec.proc) {
      rec.proc.stopRequested = true;
      rec.proc.removed = true;
      rec.proc.killPromise = killProcessTree(rec.proc.child, this.platform);
    }
    if (rec.link) {
      // Removing a live terminal session ends it, like removing a running spawned agent.
      if (rec.link.active) this._stopTerminalSession(rec, 'Retiré par l’utilisateur');
      this._clearLink(rec);
    }
    if (rec.controller && typeof rec.controller.dispose === 'function') {
      try {
        rec.controller.dispose();
      } catch {
        /* controller cleanup must never block removal */
      }
    }
    for (const subId of this._subIdsOf(id)) this._delete(subId);
    this._delete(id);
    return true;
  }

  /** Kills every running process (server shutdown). Resolves when all are gone or after 5 s. */
  stopAll() {
    const waits = [];
    for (const rec of this.records.values()) {
      this._clearPendingTurn(rec);
      if (rec.proc) {
        rec.proc.stopRequested = true;
        waits.push(rec.proc.killPromise || (rec.proc.killPromise = killProcessTree(rec.proc.child, this.platform)));
        if (ACTIVE_STATUSES.has(rec.agent.status)) this._markStopped(rec, 'Arrêté (fermeture de PixelQG)');
      }
      if (rec.controller && typeof rec.controller.dispose === 'function' && rec.agent.source === 'demo') {
        try {
          rec.controller.dispose();
        } catch {
          /* ignore */
        }
      }
      // Interactive sessions die with their terminal (the terminal manager kills every PTY tree).
      if (rec.link && rec.link.active) this.endTerminalLink(rec.agent.id, { killed: true, reason: 'Arrêté (fermeture de PixelQG)' });
    }
    const timeout = new Promise((resolve) => setTimeout(resolve, 5000).unref());
    return Promise.race([Promise.all(waits), timeout]);
  }

  /** Last-resort synchronous kill (process 'exit' handler). */
  killAllSync() {
    for (const rec of this.records.values()) {
      if (rec.proc && rec.proc.child) {
        try {
          rec.proc.child.kill();
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Number of running Claude Code processes. */
  runningProcesses() {
    let n = 0;
    for (const rec of this.records.values()) if (rec.proc) n++;
    return n;
  }

  // ---------------------------------------------------------------- API for demo.js / watcher.js

  /**
   * Creates a root agent driven by an external source (demo or watcher).
   * @param {object} spec { source, id?, name?, color?, model?, cwd, prompt, status?, canControl?, sessionId?, startedAt? }
   * @returns {object} the agent
   */
  createRoot(spec) {
    const rec = this._createRoot(spec);
    return rec.agent;
  }

  /** Attaches a controller { stop(), message(prompt), dispose() } to a root. */
  attachController(id, controller) {
    const rec = this.records.get(id);
    if (rec) rec.controller = controller;
  }

  /** Feeds one stream-json event to the root's parser. */
  feed(rootId, event, ctx) {
    const rec = this.records.get(rootId);
    if (!rec || !rec.parser) return;
    rec.parser.handle(event, ctx);
  }

  /** Starts a new turn (status starting, prompt logged) for demo scenarios. */
  beginTurn(rootId, prompt) {
    const rec = this.records.get(rootId);
    if (rec) this._beginTurn(rec, prompt);
  }

  /** Marks a root (and its active subs) as stopped. */
  markStopped(rootId, reason) {
    const rec = this.records.get(rootId);
    if (rec && ACTIVE_STATUSES.has(rec.agent.status)) this._markStopped(rec, reason || 'Arrêté par l’utilisateur');
  }

  /** Ensures a subagent exists under a root (watcher: subagent transcript files). */
  ensureSub(rootId, key, info, time) {
    const rec = this.records.get(rootId);
    if (!rec || !rec.parser) return null;
    return rec.parser.ensureSub(key, info || {}, time);
  }

  /** Applies a shallow patch to an agent (name, prompt, status…) and emits it. */
  patchAgent(id, patch) {
    if (this.records.has(id)) this._patch(id, patch);
  }

  /** Sets an agent activity from outside (watcher idle state). */
  setActivity(id, kind, label, tool, time) {
    if (this.records.has(id)) this._setActivity(id, kind, label, tool || null, time);
  }

  /** While quiet, logs are stored but not emitted and token deltas are not announced. */
  setQuiet(rootId, quiet) {
    const rec = this.records.get(rootId);
    if (rec) rec.quiet = Boolean(quiet);
  }

  /** Ids of the subagents of a root. */
  subIdsOf(rootId) {
    return this._subIdsOf(rootId);
  }

  // ---------------------------------------------------------------- interactive terminal sessions

  /**
   * POST /api/terminals/:id/link — called by the `claude` shim of an HQ terminal.
   * Creates (or reuses, for a resumed session already known) the root agent of an interactive
   * Claude Code session, or, with { linkId, childPid }, updates an existing link.
   * @param {{id: string, title?: string, name?: string|null, color?: string|null}} terminal
   * @param {object} body { sessionId?, cwd, pid, name?, args?, linkId?, childPid? }
   * @returns {{agent: object, linkId: string, created: boolean}}
   */
  linkTerminal(terminal, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HqError(400, 'Corps de requête invalide : un objet JSON est attendu.');
    }
    let childPid = null;
    if (!isBlank(body.childPid)) {
      if (!isPid(body.childPid)) throw new HqError(400, 'Identifiant de processus (childPid) invalide.');
      childPid = body.childPid;
    }

    if (!isBlank(body.linkId)) {
      const rec = this._linkRecord(terminal.id, body.linkId);
      if (childPid) {
        rec.link.childPid = childPid;
        this._scheduleTerminalReady(rec);
      }
      return { agent: rec.agent, linkId: rec.link.linkId, created: false };
    }

    let sessionId = null;
    if (!isBlank(body.sessionId)) {
      if (typeof body.sessionId !== 'string' || !TERMINAL_SESSION_RE.test(body.sessionId)) {
        throw new HqError(400, 'Identifiant de session invalide.');
      }
      sessionId = body.sessionId;
    }
    if (typeof body.cwd !== 'string' || !body.cwd || body.cwd.length > 4096 || body.cwd.includes('\0') || !path.isAbsolute(body.cwd)) {
      throw new HqError(400, 'Dossier de travail invalide : un chemin absolu est attendu.');
    }
    const cwd = path.resolve(body.cwd);
    if (!isPid(body.pid)) throw new HqError(400, 'Identifiant de processus (pid) invalide.');
    if (!isBlank(body.name) && (typeof body.name !== 'string' || body.name.length > 200)) {
      throw new HqError(400, 'Nom invalide.');
    }
    if (!isBlank(body.args) && (typeof body.args !== 'string' || body.args.length > 4000)) {
      throw new HqError(400, 'Arguments invalides.');
    }
    const linkName = cleanDisplayName(body.name || '');
    const args = truncate(oneLine(body.args || ''), 300);
    // --agent <profile> seen by the shim (never blocks the link: anything odd is ignored).
    const profile = typeof body.profile === 'string' && body.profile.length <= 200 && PROFILE_RE.test(body.profile) ? body.profile : null;
    const where = terminal.title || `le terminal ${terminal.id}`;
    const t = Date.now();

    let rec = sessionId ? this._terminalRootForSession(sessionId) : null;
    let created = false;
    if (rec) {
      if (rec.link) this._clearLink(rec); // the same session relaunched: the newest process wins
      const patch = { terminalId: terminal.id, interactive: true, status: 'starting', endedAt: null, error: null, cwd, profile };
      if (linkName) patch.name = linkName;
      this._patch(rec.agent.id, patch);
      this._setActivity(rec.agent.id, 'think', LABELS.starting, null, t);
      this._log(rec.agent.id, { t, type: 'system', text: `Session reprise dans ${where}`, detail: args ? `claude ${args}` : undefined });
    } else {
      rec = this._createRoot({
        source: 'terminal',
        terminalId: terminal.id,
        interactive: true,
        name: this._freeName(linkName || terminal.name || '') || this.nextName(),
        color: terminal.color || this.nextColor(),
        cwd,
        prompt: '',
        status: 'starting',
        canControl: true,
        sessionId,
        startedAt: t,
        profile,
      });
      created = true;
      this._log(rec.agent.id, { t, type: 'system', text: `Session Claude Code lancée dans ${where}`, detail: args ? `claude ${args}` : undefined });
    }

    const linkId = crypto.randomBytes(12).toString('hex');
    rec.link = {
      linkId,
      terminalId: terminal.id,
      pid: body.pid,
      childPid,
      active: true,
      stopRequested: false,
      since: t,
      cwd,
      sessionId,
      lastTurnEndId: null,
      readyTimer: null,
    };
    this.links.set(linkId, rec.agent.id);
    if (childPid) this._scheduleTerminalReady(rec);
    this.emit('link', { agentId: rec.agent.id, terminalId: terminal.id, sessionId, cwd, since: t });
    return { agent: rec.agent, linkId, created };
  }

  /**
   * POST /api/terminals/:id/unlink — the interactive Claude Code process exited.
   * @param {{id: string}} terminal
   * @param {object} body { linkId, exitCode }
   * @returns {object} the agent
   */
  unlinkTerminal(terminal, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new HqError(400, 'Corps de requête invalide : un objet JSON est attendu.');
    }
    const rec = this._linkRecord(terminal.id, body.linkId);
    let exitCode = null;
    if (!isBlank(body.exitCode)) {
      if (!Number.isInteger(body.exitCode)) throw new HqError(400, 'Code de sortie invalide.');
      exitCode = body.exitCode;
    }
    this.endTerminalLink(rec.agent.id, { exitCode });
    return rec.agent;
  }

  /**
   * Ends the link of an interactive session: done (exit 0), error (other codes) or stopped
   * (stop requested by the user, or `killed` when its terminal was closed).
   * @param {string} agentId
   * @param {{exitCode?: number|null, killed?: boolean, reason?: string}} [info]
   */
  endTerminalLink(agentId, info = {}) {
    const rec = this.records.get(agentId);
    const link = rec && rec.link;
    if (!link || !link.active) return;
    link.active = false;
    link.exitCode = info.exitCode === undefined ? null : info.exitCode;
    if (link.readyTimer) clearTimeout(link.readyTimer);
    link.readyTimer = null;
    const t = Date.now();
    const id = rec.agent.id;
    const code = link.exitCode;
    if (link.stopRequested || info.killed) {
      if (ACTIVE_STATUSES.has(rec.agent.status)) {
        this._markStopped(rec, info.reason || (link.stopRequested ? 'Arrêté par l’utilisateur' : 'Terminal fermé'));
      }
    } else if (code === null || code === 0 || CTRL_C_EXIT_CODES.has(code)) {
      this._patch(id, { status: 'done', endedAt: t, error: null });
      this._setActivity(id, 'done', LABELS.done, null, t);
      this._log(id, { t, type: 'result', kind: 'done', text: info.reason || 'Session Claude Code terminée' });
      for (const subId of this._subIdsOf(id)) {
        const sub = this.records.get(subId);
        if (sub && ACTIVE_STATUSES.has(sub.agent.status)) {
          this._patch(subId, { status: 'done', endedAt: t });
          this._setActivity(subId, 'done', LABELS.done, null, t);
        }
      }
    } else {
      this._fail(rec, `Claude Code s'est arrêté (code ${code})`);
    }
    this.emit('unlink', { agentId: id, sessionId: link.sessionId, terminalId: link.terminalId });
  }

  /** A terminal exited: every live session linked to it ends (stopped when the terminal was killed). */
  endTerminalLinksOf(terminalId, info = {}) {
    for (const rec of Array.from(this.records.values())) {
      if (rec.link && rec.link.active && rec.link.terminalId === terminalId) this.endTerminalLink(rec.agent.id, info);
    }
  }

  /** Every interactive session known to the manager (for the transcript watcher). */
  terminalLinks() {
    const out = [];
    for (const rec of this.records.values()) {
      if (!rec.link || rec.agent.kind !== 'root') continue;
      out.push({
        agentId: rec.agent.id,
        terminalId: rec.link.terminalId,
        sessionId: rec.link.sessionId || rec.agent.sessionId || null,
        cwd: rec.link.cwd,
        since: rec.link.since,
        active: rec.link.active,
      });
    }
    return out;
  }

  /** Whether a live interactive session is linked (the watcher keeps polling for it). */
  hasActiveTerminalLinks() {
    for (const rec of this.records.values()) if (rec.link && rec.link.active) return true;
    return false;
  }

  /** --continue / --resume picker: the watcher found the transcript of a linked session. */
  adoptTerminalSession(agentId, sessionId) {
    const rec = this.records.get(agentId);
    if (!rec || !rec.link || typeof sessionId !== 'string' || !sessionId) return false;
    rec.link.sessionId = sessionId;
    this._patch(agentId, { sessionId });
    for (const subId of this._subIdsOf(agentId)) {
      const sub = this.records.get(subId);
      if (sub && !sub.agent.sessionId) this._patch(subId, { sessionId });
    }
    return true;
  }

  /** Interactive turn tracking: a human prompt was submitted in the terminal. */
  terminalPrompt(agentId, text, time) {
    const rec = this.records.get(agentId);
    if (!rec || !rec.link || !rec.link.active || rec.link.stopRequested) return;
    const t = time || Date.now();
    const patch = { status: 'working', endedAt: null, error: null };
    if (!rec.agent.prompt) patch.prompt = truncate(text, 4000);
    this._patch(agentId, patch);
    this._setActivity(agentId, 'think', LABELS.think, null, t);
    this._log(agentId, { t, type: 'user', text, detail: truncate(text, 4000) });
    if (rec.parser) rec.parser.beginTurn();
  }

  /**
   * Interactive turn tracking: the assistant finished its turn (stop_reason end_turn…) or the user
   * interrupted it. Transcripts repeat stop_reason on every line of a message: turns are counted once
   * per message id.
   */
  terminalTurnEnd(agentId, msgId, time, interrupted = false) {
    const rec = this.records.get(agentId);
    if (!rec || !rec.link || !rec.link.active || rec.link.stopRequested) return;
    const t = time || Date.now();
    const repeated = !interrupted && typeof msgId === 'string' && msgId && rec.link.lastTurnEndId === msgId;
    const patch = { status: 'waiting' };
    if (!repeated && !interrupted) {
      patch.turns = rec.agent.turns + 1;
      if (msgId) rec.link.lastTurnEndId = msgId;
    }
    this._patch(agentId, patch);
    this._setActivity(agentId, 'idle', LABELS.waitUser, null, t);
    if (repeated) return;
    this._log(agentId, interrupted
      ? { t, type: 'system', text: 'Tour interrompu dans le terminal' }
      : { t, type: 'result', kind: 'done', text: 'Tour terminé : Claude attend ta réponse' });
  }

  // ---------------------------------------------------------------- internals

  _linkRecord(terminalId, linkId) {
    if (typeof linkId !== 'string' || !LINK_ID_RE.test(linkId)) {
      throw new HqError(400, 'Identifiant de liaison invalide.');
    }
    const agentId = this.links.get(linkId);
    const rec = agentId ? this.records.get(agentId) : null;
    if (!rec || !rec.link || rec.link.linkId !== linkId || rec.link.terminalId !== terminalId) {
      throw new HqError(404, 'Liaison introuvable.');
    }
    return rec;
  }

  /** The terminal agent of a session: the live one if any, else the most recently linked. */
  _terminalRootForSession(sessionId) {
    let best = null;
    for (const rec of this.records.values()) {
      if (rec.agent.kind !== 'root' || rec.agent.source !== 'terminal') continue;
      if (rec.agent.sessionId !== sessionId && !(rec.link && rec.link.sessionId === sessionId)) continue;
      if (rec.link && rec.link.active) return rec;
      const since = rec.link ? rec.link.since : rec.agent.startedAt;
      const bestSince = best ? (best.link ? best.link.since : best.agent.startedAt) : -Infinity;
      if (since >= bestSince) best = rec;
    }
    return best;
  }

  _clearLink(rec) {
    const link = rec.link;
    if (!link) return;
    if (link.readyTimer) clearTimeout(link.readyTimer);
    link.readyTimer = null;
    link.active = false;
    this.links.delete(link.linkId);
    rec.link = null;
  }

  /** Claude Code shows its prompt right after start: "waiting for you" once the process is up. */
  _scheduleTerminalReady(rec) {
    const link = rec.link;
    if (!link || !link.active || link.readyTimer) return;
    link.readyTimer = setTimeout(() => {
      link.readyTimer = null;
      if (rec.link !== link || !link.active || this.records.get(rec.agent.id) !== rec) return;
      if (rec.agent.status !== 'starting') return;
      this._patch(rec.agent.id, { status: 'waiting' });
      this._setActivity(rec.agent.id, 'idle', LABELS.waitUser, null, Date.now());
    }, this.terminalReadyMs);
    link.readyTimer.unref();
  }

  /** Stop = kill the interactive Claude Code process tree (the shim then reports the exit). */
  _stopTerminalSession(rec, reason) {
    const link = rec.link;
    if (!link || !link.active) return;
    link.stopRequested = true;
    const id = rec.agent.id;
    const target = link.childPid || link.pid;
    killPidTree(target, this.platform).then(() => {
      // Without a child pid the shim itself was killed: no unlink will ever come.
      if (!link.childPid && rec.link === link) this.endTerminalLink(id, {});
    });
    if (ACTIVE_STATUSES.has(rec.agent.status)) this._markStopped(rec, reason);
  }

  /** `base` when no running agent uses it, else "base 2", "base 3"… ('' when base is empty). */
  _freeName(base) {
    const clean = cleanDisplayName(base);
    if (!clean) return '';
    const used = new Set();
    for (const rec of this.records.values()) {
      if (ACTIVE_STATUSES.has(rec.agent.status)) used.add(String(rec.agent.name).toLowerCase());
    }
    if (!used.has(clean.toLowerCase())) return clean;
    for (let n = 2; n < 100; n++) {
      const suffix = ` ${n}`;
      const head = Array.from(clean).slice(0, 24 - suffix.length).join('').trim();
      const candidate = `${head}${suffix}`;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
    return clean;
  }

  _clearPendingTurn(rec) {
    if (rec && rec.pendingTurn) {
      if (rec.pendingTurn.timer) clearTimeout(rec.pendingTurn.timer);
      rec.pendingTurn = null;
    }
  }

  _mustGet(id) {
    const rec = this.records.get(id);
    if (!rec) throw new HqError(404, 'Agent introuvable.');
    return rec;
  }

  _rec(id) {
    return this.records.get(id) || null;
  }

  _nextId(prefix) {
    const n = (this.counters.get(prefix) || 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}${n}`;
  }

  _uniqueId(wanted) {
    if (!this.records.has(wanted)) return wanted;
    for (let i = 2; ; i++) {
      const candidate = `${wanted}-${i}`;
      if (!this.records.has(candidate)) return candidate;
    }
  }

  _createRoot(spec) {
    const now = Date.now();
    const source = spec.source || 'spawned';
    let id;
    if (spec.id) id = this._uniqueId(spec.id);
    else id = this._nextId(source === 'demo' ? 'd' : source === 'observed' ? 'o' : 'a');
    while (this.records.has(id)) id = this._nextId(source === 'demo' ? 'd' : 'a');
    const status = spec.status || 'starting';
    const agent = {
      id,
      kind: 'root',
      parentId: null,
      source,
      name: spec.name || this.nextName(),
      role: null,
      color: spec.color || this.nextColor(),
      model: spec.model || null,
      cwd: spec.cwd || this.defaultCwd,
      prompt: typeof spec.prompt === 'string' ? spec.prompt : '',
      status,
      activity: {
        kind: status === 'waiting' ? 'idle' : 'think',
        tool: null,
        label: status === 'waiting' ? LABELS.idle : status === 'starting' ? LABELS.starting : LABELS.think,
        since: spec.startedAt || now,
      },
      tokens: zeroTokens(),
      costUsd: null,
      toolCount: 0,
      turns: 0,
      startedAt: spec.startedAt || now,
      endedAt: null,
      sessionId: spec.sessionId || null,
      lastText: '',
      resultText: null,
      error: null,
      canControl: spec.canControl !== undefined ? Boolean(spec.canControl) : true,
      terminalId: spec.terminalId || null,
      interactive: Boolean(spec.interactive),
      profile: typeof spec.profile === 'string' && spec.profile ? spec.profile : null,
    };
    const rec = this._newRecord(agent, id);
    rec.parser = new StreamParser(this, id);
    rec.subCounter = 0;
    this.records.set(id, rec);
    if (agent.sessionId && source === 'spawned') this.spawnedSessionIds.add(agent.sessionId);
    this.emit('agent', agent);
    return rec;
  }

  _newRecord(agent, rootId) {
    return {
      agent,
      rootId,
      logs: [],
      usage: new Map(),
      lastMsgId: null,
      parser: null,
      controller: null,
      proc: null,
      options: null,
      pendingTurn: null,
      quiet: false,
      roleDefaulted: false,
      link: null,
    };
  }

  _createSub(rootId, info) {
    const root = this.records.get(rootId);
    if (!root) return null;
    root.subCounter = (root.subCounter || 0) + 1;
    let id = `${rootId}.s${root.subCounter}`;
    while (this.records.has(id)) {
      root.subCounter += 1;
      id = `${rootId}.s${root.subCounter}`;
    }
    const t = info.time || Date.now();
    const agent = {
      id,
      kind: 'sub',
      parentId: rootId,
      source: root.agent.source,
      name: this.nextName(),
      role: info.role || 'general-purpose',
      color: this.nextColor(),
      model: root.agent.model,
      cwd: root.agent.cwd,
      prompt: info.prompt || '',
      status: 'working',
      activity: { kind: 'think', tool: null, label: LABELS.think, since: t },
      tokens: zeroTokens(),
      costUsd: null,
      toolCount: 0,
      turns: 0,
      startedAt: t,
      endedAt: null,
      sessionId: root.agent.sessionId,
      lastText: '',
      resultText: null,
      error: null,
      canControl: root.agent.canControl,
      terminalId: root.agent.terminalId || null,
      interactive: false,
      profile: null,
    };
    const rec = this._newRecord(agent, rootId);
    this.records.set(id, rec);
    this.emit('agent', agent);
    this._log(rootId, {
      t,
      type: 'system',
      kind: 'task',
      text: `Nouveau sous-agent : ${agent.name} (${agent.role})`,
      detail: info.prompt ? truncate(info.prompt, 4000) : undefined,
    });
    return rec;
  }

  _subIdsOf(rootId) {
    const out = [];
    for (const rec of this.records.values()) {
      if (rec.agent.kind === 'sub' && rec.agent.parentId === rootId) out.push(rec.agent.id);
    }
    return out;
  }

  _delete(id) {
    if (!this.records.has(id)) return;
    this.records.delete(id);
    this.emit('remove', { id });
  }

  _patch(id, patch) {
    const rec = this.records.get(id);
    if (!rec) return;
    let changed = false;
    for (const key of Object.keys(patch)) {
      if (rec.agent[key] !== patch[key]) {
        rec.agent[key] = patch[key];
        changed = true;
      }
    }
    if (changed) this.emit('agent', rec.agent);
  }

  _setActivity(id, kind, label, tool, time) {
    const rec = this.records.get(id);
    if (!rec) return;
    const a = rec.agent.activity;
    const lbl = truncate(label || LABELS[kind] || '', 60);
    const tl = tool || null;
    if (a.kind === kind && a.label === lbl && a.tool === tl) return;
    rec.agent.activity = { kind, tool: tl, label: lbl, since: time || Date.now() };
    this.emit('agent', rec.agent);
  }

  _isQuiet(rec) {
    const root = rec.agent.kind === 'sub' ? this.records.get(rec.agent.parentId) : rec;
    return Boolean(root && root.quiet);
  }

  _log(id, entry) {
    const rec = this.records.get(id);
    if (!rec) return;
    const clean = { t: entry.t || Date.now(), type: entry.type };
    if (entry.tool) clean.tool = entry.tool;
    if (entry.kind) clean.kind = entry.kind;
    clean.text = truncate(oneLine(entry.text), 200);
    if (entry.detail) clean.detail = truncate(String(entry.detail), 4000);
    rec.logs.push(clean);
    if (rec.logs.length > MAX_LOGS) rec.logs.splice(0, rec.logs.length - MAX_LOGS);
    if (!this._isQuiet(rec)) this.emit('log', { id, entry: clean });
  }

  /** Counts usage once per message id: only increases over what was already counted are added. */
  _addUsage(id, msgId, usage) {
    const rec = this.records.get(id);
    if (!rec) return;
    const u = usageOf(usage);
    if (typeof msgId !== 'string' || !msgId) {
      this._addTokens(id, u);
      return;
    }
    const prev = rec.usage.get(msgId);
    if (!prev) {
      rec.usage.set(msgId, u);
      this._addTokens(id, u);
      return;
    }
    const delta = {};
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      delta[k] = u[k] > prev[k] ? u[k] - prev[k] : 0;
      if (u[k] > prev[k]) prev[k] = u[k];
    }
    this._addTokens(id, delta);
  }

  _addTokens(id, delta) {
    const rec = this.records.get(id);
    if (!rec) return;
    const add = (k) => (delta && typeof delta[k] === 'number' && delta[k] > 0 ? delta[k] : 0);
    const d = { input: add('input'), output: add('output'), cacheRead: add('cacheRead'), cacheWrite: add('cacheWrite') };
    const sum = d.input + d.output + d.cacheRead + d.cacheWrite;
    if (sum <= 0) return;
    const tk = rec.agent.tokens;
    rec.agent.tokens = {
      input: tk.input + d.input,
      output: tk.output + d.output,
      cacheRead: tk.cacheRead + d.cacheRead,
      cacheWrite: tk.cacheWrite + d.cacheWrite,
      total: tk.total + sum,
    };
    this.emit('agent', rec.agent);
    if (!this._isQuiet(rec)) this.emit('tokens', { id, delta: sum });
  }

  _onSessionId(rootId, sessionId) {
    const rec = this.records.get(rootId);
    if (!rec) return;
    if (rec.agent.source === 'spawned') {
      this.spawnedSessionIds.add(sessionId);
      this.emit('session', { id: rootId, sessionId });
    }
    for (const subId of this._subIdsOf(rootId)) {
      const sub = this.records.get(subId);
      if (sub && !sub.agent.sessionId) this._patch(subId, { sessionId });
    }
  }

  _beginTurn(rec, prompt) {
    const t = Date.now();
    this._patch(rec.agent.id, { status: 'starting', endedAt: null, error: null });
    this._setActivity(rec.agent.id, 'think', LABELS.starting, null, t);
    this._log(rec.agent.id, { t, type: 'user', text: prompt, detail: truncate(prompt, 4000) });
    if (rec.parser) rec.parser.beginTurn();
  }

  _markStopped(rec, reason) {
    const t = Date.now();
    this._patch(rec.agent.id, { status: 'stopped', endedAt: t });
    this._setActivity(rec.agent.id, 'idle', LABELS.stopped, null, t);
    this._log(rec.agent.id, { t, type: 'system', text: reason });
    for (const subId of this._subIdsOf(rec.agent.id)) {
      const sub = this.records.get(subId);
      if (sub && ACTIVE_STATUSES.has(sub.agent.status)) {
        this._patch(subId, { status: 'stopped', endedAt: t });
        this._setActivity(subId, 'idle', LABELS.stopped, null, t);
      }
    }
  }

  _fail(rec, message) {
    const t = Date.now();
    this._patch(rec.agent.id, { status: 'error', error: message, endedAt: t });
    this._setActivity(rec.agent.id, 'error', LABELS.error, null, t);
    this._log(rec.agent.id, { t, type: 'error', kind: 'error', text: message, detail: truncate(message, 4000) });
    for (const subId of this._subIdsOf(rec.agent.id)) {
      const sub = this.records.get(subId);
      if (sub && ACTIVE_STATUSES.has(sub.agent.status)) {
        this._patch(subId, { status: 'error', error: "L'agent principal s'est arrêté.", endedAt: t });
        this._setActivity(subId, 'error', LABELS.error, null, t);
      }
    }
  }

  _buildArgs(rec, resume) {
    const opts = rec.options || { permissionMode: 'default', model: '', effort: '' };
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--forward-subagent-text',
      '--permission-prompts', 'none',
      '--permission-mode', opts.permissionMode || 'default',
      '--name=' + rec.agent.name,
    ];
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--effort', opts.effort);
    if (resume && rec.agent.sessionId) args.push('--resume', rec.agent.sessionId);
    // Library (docs/LIBRARY.md §5): wrapper plugins + optional agent profile, also on follow-ups.
    args.push(...this.pluginDirArgs());
    if (opts.profile) args.push('--agent', opts.profile);
    return args;
  }

  _spawnTurn(rec, prompt, resume) {
    const claude = this.claude;
    const args = [...claude.prefixArgs, ...this._buildArgs(rec, resume)];
    let child;
    try {
      child = this.spawnFn(claude.command, args, {
        cwd: rec.agent.cwd,
        env: process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._fail(rec, `Impossible de lancer Claude Code : ${err && err.message ? err.message : String(err)}`);
      return;
    }
    const proc = {
      child,
      pid: child.pid,
      resultSeen: false,
      stopRequested: false,
      removed: false,
      finished: false,
      spawnError: null,
      stderr: '',
      killPromise: null,
    };
    rec.proc = proc;

    const splitter = new LineSplitter(
      (line) => this._onStdoutLine(rec, proc, line),
      {
        onOverflow: () => {
          if (this.records.get(rec.agent.id) === rec) {
            this._log(rec.agent.id, { type: 'system', text: 'Ligne de sortie trop longue ignorée (plus de 64 Mo).' });
          }
        },
      }
    );
    const errDecoder = new StringDecoder('utf8');

    if (child.stdout) child.stdout.on('data', (chunk) => splitter.push(chunk));
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        proc.stderr += errDecoder.write(chunk);
        if (proc.stderr.length > STDERR_TAIL) proc.stderr = proc.stderr.slice(-STDERR_TAIL);
      });
    }
    child.on('error', (err) => {
      proc.spawnError = err;
      if (!child.pid) this._finishProcess(rec, proc, splitter, null, null);
    });
    child.on('close', (code, signal) => this._finishProcess(rec, proc, splitter, code, signal));

    if (child.stdin) {
      child.stdin.on('error', () => {
        /* EPIPE when the process exits before reading its prompt: reported via exit handling */
      });
      try {
        child.stdin.end(prompt, 'utf8');
      } catch {
        /* same as above */
      }
    }
  }

  _onStdoutLine(rec, proc, line) {
    if (this.records.get(rec.agent.id) !== rec || proc.removed || rec.pendingTurn) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      this._log(rec.agent.id, { type: 'system', text: line, detail: truncate(line, 4000) });
      return;
    }
    if (proc.stopRequested && rec.agent.status === 'stopped') return;
    if (event && event.type === 'result' && !event.parent_tool_use_id) proc.resultSeen = true;
    try {
      rec.parser.handle(event);
    } catch (err) {
      this._log(rec.agent.id, {
        type: 'system',
        text: `Événement illisible ignoré (${err && err.message ? err.message : 'erreur inconnue'})`,
        detail: truncate(line, 4000),
      });
    }
  }

  _finishProcess(rec, proc, splitter, code, signal) {
    if (proc.finished) return;
    proc.finished = true;
    try {
      splitter.end();
    } catch {
      /* ignore */
    }
    if (rec.proc === proc) rec.proc = null;
    if (this.records.get(rec.agent.id) !== rec || proc.removed) return;
    if (rec.pendingTurn && !rec.proc) {
      const next = rec.pendingTurn;
      this._clearPendingTurn(rec);
      this._spawnTurn(rec, next.prompt, next.resume);
      return;
    }
    if (proc.stopRequested) {
      if (ACTIVE_STATUSES.has(rec.agent.status)) this._markStopped(rec, 'Arrêté par l’utilisateur');
      return;
    }
    if (proc.resultSeen) return; // the result event already set the final status
    let message;
    if (proc.spawnError) {
      const err = proc.spawnError;
      message = err.code === 'ENOENT'
        ? `Impossible de lancer Claude Code : exécutable introuvable (${this.claude ? this.claude.command : 'claude'}).`
        : `Impossible de lancer Claude Code : ${err.message}`;
    } else {
      const tail = proc.stderr.trim();
      if (tail) {
        message = truncate(tail.length > 1000 ? '…' + tail.slice(-1000) : tail, 1001);
      } else if (signal) {
        message = `Claude Code s'est arrêté brutalement (signal ${signal}).`;
      } else {
        message = `Claude Code s'est arrêté sans terminer son tour (code ${code}).`;
      }
    }
    this._fail(rec, message);
  }
}

module.exports = {
  AgentManager,
  StreamParser,
  LineSplitter,
  HqError,
  validateCreateInput,
  validatePrompt,
  validateName,
  validateColor,
  validateModel,
  validatePermissionMode,
  validateCwd,
  toolKind,
  toolLabel,
  killProcessTree,
  killPidTree,
  MODELS,
  PERMISSION_MODES,
  EFFORTS,
  LABELS,
  MAX_LOGS,
  MAX_PROMPT,
};
