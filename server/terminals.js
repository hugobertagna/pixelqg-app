'use strict';

// Terminal manager (docs/TERMINAL.md section 2): real Windows terminals (cmd.exe) running inside a
// ConPTY bridge (server/bin/hq-pty.exe), streamed to the page over WebSockets by server.js.
// Typing `claude` in one of them runs the shim (server/shim/claude.cmd -> server/claude-shim.js),
// which links the interactive Claude Code session to an agent of the office.
//
// macOS / Linux (experimental, never tested on a real Mac): the user's shell runs inside the
// pseudo-terminal of the system `script` command. That mode cannot resize the pseudo-terminal, so
// the shell waits (1 s at most) for the page's first size and keeps it. `claude` goes through
// server/shim/claude (PATH) and, for bash and zsh, a shell function defined after the user's rc
// files (server/shim/posix), so an rc file that reorders PATH cannot bypass the shim.

const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {
  HqError,
  validateName,
  validateColor,
  validateModel,
  validatePermissionMode,
  validateCwd,
} = require('./agents');

const BIN_DIR = path.join(__dirname, 'bin');
const BRIDGE_SOURCE = path.join(BIN_DIR, 'hq-pty.cs');
const BRIDGE_EXE = path.join(BIN_DIR, 'hq-pty.exe');
const SHIM_DIR = path.join(__dirname, 'shim');
const SHIM_SCRIPT = path.join(__dirname, 'claude-shim.js');

const SHELL = 'cmd.exe';
const POSIX_PLATFORMS = new Set(['darwin', 'linux']);
const SCRIPT_PATHS = ['/usr/bin/script', '/bin/script'];
const POSIX_SHELLS = ['/bin/bash', '/bin/sh'];
const POSIX_START_WAIT_MS = 1000;
// Variables describing the terminal PixelQG itself was started from: wrong inside xterm.js.
const POSIX_STRIPPED_ENV = ['TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID', 'ITERM_SESSION_ID', 'COLUMNS', 'LINES'];
const POSIX_NOTICE = 'Terminal expérimental (macOS / Linux) : sa taille est fixée à son ouverture. Après avoir agrandi la fenêtre, ouvre un nouveau terminal.';
const MAX_TERMINALS = 8;
const REPLAY_BYTES = 256 * 1024;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const COLS_RANGE = [20, 400];
const ROWS_RANGE = [5, 200];
const COMPILE_TIMEOUT_MS = 60000;
const LAUNCH_FALLBACK_MS = 600;
const KILL_GRACE_MS = 2000;
const MIN_WINDOWS_BUILD = 17763; // Windows 10 1809: first release with ConPTY
const STDERR_TAIL = 2048;

const FRAME_INPUT = 0;
const FRAME_RESIZE = 1;
const FRAME_TERMINATE = 2;

// Variables a parent Claude Code session may leave behind: a fresh terminal must not inherit them.
const STRIPPED_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'];

function clamp(n, [min, max]) {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function frame(type, payload) {
  const body = payload ? (Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')) : Buffer.alloc(0);
  const out = Buffer.allocUnsafe(5 + body.length);
  out[0] = type;
  out.writeUInt32LE(body.length, 1);
  body.copy(out, 5);
  return out;
}

function windowsBuild() {
  const parts = String(os.release()).split('.');
  const build = Number(parts[2]);
  return Number.isFinite(build) ? build : 0;
}

/** Absolute path of the system cmd.exe. */
function systemShell() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(root, 'System32', SHELL);
}

function isExecutableFile(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** macOS / Linux: the user's shell ($SHELL), else /bin/bash, else /bin/sh. Null when none runs. */
function findPosixShell(env = process.env) {
  const given = String(env.SHELL || '').trim();
  const candidates = [];
  if (given.startsWith('/') && !/(^|\/)(false|nologin)$/.test(given)) candidates.push(given);
  candidates.push(...POSIX_SHELLS);
  return candidates.find(isExecutableFile) || null;
}

/** Single-quotes a word for a POSIX shell command line. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function findCsc() {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const exe = path.join(windir, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/**
 * Compiles the ConPTY bridge with the .NET Framework C# compiler (hidden, 60 s max).
 * Builds into a temporary file first, then renames it over `exe` (atomic for readers).
 * @returns {Promise<void>} rejects with a French message
 */
function compileBridge(source, exe, timeoutMs = COMPILE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const csc = findCsc();
    if (!csc) {
      reject(new Error('compilateur C# du .NET Framework introuvable'));
      return;
    }
    const tmp = path.join(path.dirname(exe), `hq-pty-build-${process.pid}-${Date.now()}.exe`);
    const args = ['/nologo', '/codepage:65001', '/target:exe', '/optimize+', `/out:${tmp}`, source];
    childProcess.execFile(csc, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        fs.rm(tmp, { force: true }, () => {});
        const firstError = String(stdout || '').split(/\r?\n/).find((l) => /error/i.test(l));
        const detail = err.killed ? 'délai de compilation dépassé' : firstError ? firstError.trim() : err.message;
        reject(new Error(`la compilation de hq-pty.exe a échoué (${detail})`));
        return;
      }
      fs.rename(tmp, exe, (renameErr) => {
        if (renameErr) {
          fs.rm(tmp, { force: true }, () => {});
          reject(new Error(`impossible de remplacer hq-pty.exe (${renameErr.code || renameErr.message})`));
          return;
        }
        resolve();
      });
    });
  });
}

class TerminalManager extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./agents').AgentManager} opts.manager
   * @param {string} [opts.defaultCwd]
   * @param {string} [opts.platform]
   * @param {string} [opts.bridgePath] hq-pty.exe
   * @param {string} [opts.bridgeSource] hq-pty.cs (auto-compiled when newer than the exe)
   * @param {boolean} [opts.autoBuild=true]
   * @param {string} [opts.shimDir] directory put first in the terminals' PATH (holds claude.cmd)
   * @param {string} [opts.shimScript] claude-shim.js
   * @param {number} [opts.maxTerminals=8]
   * @param {number} [opts.replayBytes=262144]
   * @param {Function} [opts.spawn] child_process.spawn replacement (tests)
   * @param {{pluginDir: string}|null} [opts.library] skills library (PIXELQG_PLUGIN_DIR for the shim)
   * @param {string} [opts.scriptPath] macOS / Linux: the `script` command (default /usr/bin/script)
   * @param {string} [opts.shellPath] macOS / Linux: the shell (default $SHELL, /bin/bash, /bin/sh)
   * @param {number} [opts.posixStartWaitMs=1000] macOS / Linux: wait for the page's first size
   */
  constructor(opts) {
    super();
    this.setMaxListeners(50);
    this.manager = opts.manager;
    this.defaultCwd = opts.defaultCwd || os.homedir();
    this.platform = opts.platform || process.platform;
    this.bridgePath = opts.bridgePath || BRIDGE_EXE;
    this.bridgeSource = opts.bridgeSource === undefined ? BRIDGE_SOURCE : opts.bridgeSource;
    this.autoBuild = opts.autoBuild !== false;
    this.shimDir = opts.shimDir || SHIM_DIR;
    this.shimScript = opts.shimScript || SHIM_SCRIPT;
    this.maxTerminals = opts.maxTerminals || MAX_TERMINALS;
    this.replayBytes = opts.replayBytes || REPLAY_BYTES;
    this.spawnFn = typeof opts.spawn === 'function' ? opts.spawn : childProcess.spawn;
    this.library = opts.library || null;
    this.posix = this.platform !== 'win32';
    this.scriptPath = opts.scriptPath || null;
    this.shellPath = this.posix ? opts.shellPath || findPosixShell() : systemShell();
    this.shellName = this.posix ? path.basename(this.shellPath || '/bin/sh') : SHELL;
    this.posixStartWaitMs = Number.isFinite(opts.posixStartWaitMs) ? opts.posixStartWaitMs : POSIX_START_WAIT_MS;

    this.supported = false;
    this.reason = 'Préparation du terminal intégré…';
    this.warnings = [];
    this.endpoint = { url: null };
    this.records = new Map(); // id -> record
    this.counter = 0;
    this.initPromise = null;
    this.closed = false;

    this._onAgentRemove = ({ id }) => {
      for (const rec of this.records.values()) {
        const i = rec.terminal.agentIds.indexOf(id);
        if (i >= 0) {
          rec.terminal.agentIds.splice(i, 1);
          this._emitTerminal(rec);
        }
      }
    };
    this.manager.on('remove', this._onAgentRemove);
  }

  /** Server URL handed to the shim through the terminal environment. */
  setEndpoint(url) {
    this.endpoint = { url };
  }

  /**
   * Whether `given` is the link token of terminal `id`. Each terminal gets its own random token
   * (PIXELQG_TOKEN in its environment), valid only for its link/unlink routes: programs running in
   * a terminal never see the API token of the page.
   */
  linkTokenOk(id, given) {
    const rec = this.records.get(id);
    if (!rec || typeof given !== 'string' || !given || given.length > 512) return false;
    const digest = crypto.createHash('sha256').update(given).digest();
    return crypto.timingSafeEqual(digest, rec.linkTokenDigest);
  }

  /**
   * Checks the platform and makes sure the bridge exists (compiling it when missing or outdated).
   * @returns {Promise<{supported: boolean, reason: string|null, shell: string}>}
   */
  init() {
    if (!this.initPromise) this.initPromise = this._init().then(() => this.config());
    return this.initPromise;
  }

  async _init() {
    const unsupported = (reason) => {
      this.supported = false;
      this.reason = reason;
    };
    if (this.posix) {
      this._initPosix(unsupported);
      return;
    }
    if (windowsBuild() < MIN_WINDOWS_BUILD) {
      unsupported('Le terminal intégré nécessite Windows 10 version 1809 ou plus récente.');
      return;
    }
    if (!fs.existsSync(this.shimScript) || !fs.existsSync(path.join(this.shimDir, 'claude.cmd'))) {
      unsupported('Fichiers du terminal intégré manquants (server/shim/claude.cmd ou server/claude-shim.js).');
      return;
    }
    const stat = async (p) => {
      if (!p) return null;
      try {
        return await fsp.stat(p);
      } catch {
        return null;
      }
    };
    const exe = await stat(this.bridgePath);
    const src = await stat(this.bridgeSource);
    const outdated = Boolean(exe && src && src.mtimeMs > exe.mtimeMs);
    if ((!exe || outdated) && src && this.autoBuild) {
      try {
        await compileBridge(this.bridgeSource, this.bridgePath);
      } catch (err) {
        if (!exe) {
          unsupported(`Impossible de préparer le terminal intégré : ${err.message}.`);
          return;
        }
        this.warnings.push(`Le pont du terminal n’a pas pu être recompilé (${err.message}) : l’ancienne version est utilisée.`);
      }
    } else if (!exe) {
      unsupported('Le pont du terminal (server/bin/hq-pty.exe) est introuvable.');
      return;
    }
    this.supported = true;
    this.reason = null;
  }

  /** macOS / Linux: needs the `script` command, a shell and the POSIX shim. */
  _initPosix(unsupported) {
    if (!POSIX_PLATFORMS.has(this.platform)) {
      unsupported('Le terminal intégré n’est disponible que sous Windows, macOS et Linux.');
      return;
    }
    const script = this.scriptPath ? (isExecutableFile(this.scriptPath) ? this.scriptPath : null) : SCRIPT_PATHS.find(isExecutableFile);
    if (!script) {
      unsupported('Le terminal intégré a besoin de la commande « script » (fournie avec macOS, et avec util-linux sous Linux) : introuvable sur cet ordinateur.');
      return;
    }
    if (!this.shellPath) {
      unsupported('Aucun shell utilisable trouvé (variable SHELL, /bin/bash ou /bin/sh).');
      return;
    }
    const posixShim = path.join(this.shimDir, 'claude');
    if (!fs.existsSync(this.shimScript) || !fs.existsSync(posixShim)) {
      unsupported('Fichiers du terminal intégré manquants (server/shim/claude ou server/claude-shim.js).');
      return;
    }
    // A zip or a Windows checkout may have lost the executable bit of the shim.
    try {
      fs.chmodSync(posixShim, 0o755);
    } catch {
      /* read-only folder: bash and zsh still route `claude` through their shell function */
    }
    this.scriptPath = script;
    this.supported = true;
    this.reason = null;
  }

  /** config.terminal */
  config() {
    return { supported: this.supported, reason: this.supported ? null : this.reason, shell: this.shellName };
  }

  /** @returns {object[]} every terminal, in creation order */
  list() {
    return Array.from(this.records.values(), (r) => r.terminal);
  }

  /** @returns {object|null} */
  get(id) {
    const rec = this.records.get(id);
    return rec ? rec.terminal : null;
  }

  /** Buffered output (last 256 KB) replayed to a socket that (re)connects. */
  replay(id) {
    const rec = this.records.get(id);
    return rec ? rec.chunks.join('') : '';
  }

  /** Number of terminals whose shell still runs. */
  liveCount() {
    let n = 0;
    for (const rec of this.records.values()) if (rec.terminal.status === 'running') n++;
    return n;
  }

  _mustGet(id) {
    const rec = this.records.get(id);
    if (!rec) throw new HqError(404, 'Terminal introuvable.');
    return rec;
  }

  _requireSupported() {
    if (!this.supported) throw new HqError(501, this.reason || 'Le terminal intégré est indisponible.');
  }

  /**
   * POST /api/terminals: opens a new cmd.exe in a pseudoconsole.
   * @param {object} body { cwd?, name?, color?, launchClaude?, model?, permissionMode? }
   * @returns {object} the Terminal
   */
  create(body) {
    this._requireSupported();
    if (this.closed) throw new HqError(503, 'PixelQG est en train de s’arrêter.');
    const input = body === undefined || body === null ? {} : body;
    if (typeof input !== 'object' || Array.isArray(input)) {
      throw new HqError(400, 'Corps de requête invalide : un objet JSON est attendu.');
    }
    const cwd = validateCwd(input.cwd, this.defaultCwd);
    const name = validateName(input.name);
    const color = validateColor(input.color);
    let launchClaude = false;
    if (input.launchClaude !== undefined && input.launchClaude !== null) {
      if (typeof input.launchClaude !== 'boolean') throw new HqError(400, 'Le champ « launchClaude » doit être un booléen (true ou false).');
      launchClaude = input.launchClaude;
    }
    const model = validateModel(input.model);
    const permissionMode = validatePermissionMode(input.permissionMode, '');
    const profile = this.manager.validateProfile(input.profile);
    if (this.liveCount() >= this.maxTerminals) {
      throw new HqError(409, `Tu as déjà ${this.maxTerminals} terminaux ouverts : ferme-en un avant d’en ouvrir un autre.`);
    }

    // Only validated values ever reach the command typed in the terminal.
    const claudeArgs = [];
    if (model) claudeArgs.push('--model', model);
    if (permissionMode) claudeArgs.push('--permission-mode', permissionMode);
    if (profile) claudeArgs.push('--agent', profile); // validated: [A-Za-z0-9._:-] only

    this.counter += 1;
    const id = `t${this.counter}`;
    const now = Date.now();
    const terminal = {
      id,
      title: `Terminal ${this.counter}`,
      cwd,
      shell: this.shellName,
      status: 'running',
      exitCode: null,
      createdAt: now,
      endedAt: null,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      agentIds: [],
      name,
      color,
    };
    const linkToken = crypto.randomBytes(24).toString('hex');
    const rec = {
      terminal,
      linkToken,
      linkTokenDigest: crypto.createHash('sha256').update(linkToken).digest(),
      child: null,
      decoder: new StringDecoder('utf8'),
      chunks: [],
      bytes: 0,
      stderr: '',
      killed: false,
      exited: false,
      exitPromise: null,
      startTimer: null,
      launch: launchClaude ? { text: ['claude', ...claudeArgs].join(' ') + '\r', timer: null } : null,
    };
    rec.exitPromise = new Promise((resolve) => {
      rec.resolveExit = resolve;
    });
    this.records.set(id, rec);
    if (this.posix) {
      // `script` cannot resize its pseudo-terminal later: start with the page's first size.
      this._appendNotice(rec, POSIX_NOTICE);
      rec.startTimer = setTimeout(() => this._startNow(rec), this.posixStartWaitMs);
      rec.startTimer.unref();
    } else {
      this._spawn(rec);
    }
    this._emitTerminal(rec);
    return terminal;
  }

  /** macOS / Linux: starts a terminal whose shell was waiting for its first size. */
  _startNow(rec) {
    if (!rec.startTimer) return;
    clearTimeout(rec.startTimer);
    rec.startTimer = null;
    if (!rec.exited) this._spawn(rec);
  }

  _env(rec) {
    const id = rec.terminal.id;
    const env = {};
    let pathValue = '';
    for (const [k, v] of Object.entries(process.env)) {
      if (/^path$/i.test(k)) {
        if (!pathValue) pathValue = v;
        continue;
      }
      if (/^PIXELQG_/i.test(k) || STRIPPED_ENV.includes(k.toUpperCase())) continue;
      env[k] = v;
    }
    env.PATH = pathValue ? `${this.shimDir}${path.delimiter}${pathValue}` : this.shimDir;
    env.PIXELQG_URL = this.endpoint.url || '';
    env.PIXELQG_TOKEN = rec.linkToken;
    env.PIXELQG_TERMINAL = id;
    env.PIXELQG_NODE = process.execPath;
    env.PIXELQG_SHIM = this.shimScript;
    // The shim adds --plugin-dir only when this folder holds at least one wrapper plugin at launch
    // time, so terminals opened before a library change still follow it.
    env.PIXELQG_PLUGIN_DIR = this.library && this.library.pluginDir ? this.library.pluginDir : '';
    const claude = this.manager.ensureClaude();
    if (claude) {
      env.PIXELQG_REAL_CLAUDE = claude.command;
      if (claude.prefixArgs && claude.prefixArgs.length) env.PIXELQG_REAL_PREFIX = JSON.stringify(claude.prefixArgs);
    }
    if (this.posix) this._posixEnv(env);
    return env;
  }

  /** macOS / Linux: terminal type of xterm.js, UTF-8, and zsh's startup wrapper (server/shim/posix/zsh). */
  _posixEnv(env) {
    for (const k of POSIX_STRIPPED_ENV) delete env[k];
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.SHELL = this.shellPath; // util-linux `script -c` runs its command with $SHELL
    if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = this.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
    const zshDir = path.join(this.shimDir, 'posix', 'zsh');
    if (this.shellName === 'zsh' && fs.existsSync(path.join(zshDir, '.zshrc'))) {
      env.PIXELQG_USER_ZDOTDIR = process.env.ZDOTDIR || '';
      env.ZDOTDIR = zshDir;
    }
  }

  /**
   * macOS / Linux: arguments of the `script` command. The inner /bin/sh sets the pseudo-terminal
   * size (its only chance: `script` has no resize), then becomes the user's shell.
   *   macOS:  script -q /dev/null /bin/sh -c '<inner>'
   *   Linux:  script -qefc '<inner>' /dev/null   (-e: exit code of the shell, -f: flush at once)
   */
  _posixArgs(rec) {
    const t = rec.terminal;
    const shellArgs = [this.shellPath];
    const bashrc = path.join(this.shimDir, 'posix', 'bashrc');
    if (this.shellName === 'bash' && fs.existsSync(bashrc)) shellArgs.push('--rcfile', bashrc);
    const inner = `stty cols ${t.cols} rows ${t.rows} 2>/dev/null; exec ${shellArgs.map(shQuote).join(' ')}`;
    if (this.platform === 'linux') return ['-qefc', inner, '/dev/null'];
    return ['-q', '/dev/null', '/bin/sh', '-c', inner];
  }

  /** What a keystroke becomes on the child's stdin: a bridge frame (Windows) or raw bytes. */
  _inputChunk(text) {
    return this.posix ? Buffer.from(text, 'utf8') : frame(FRAME_INPUT, text);
  }

  /**
   * The shell command line. Besides the claude.cmd shim found through PATH, a doskey macro makes a
   * typed `claude` run the shim directly: no batch file in between, so Ctrl+C inside Claude Code
   * never triggers cmd's "Terminate batch job (Y/N)?" prompt.
   * The shell is given by absolute path: CreateProcess would otherwise look in the working folder
   * first, where a planted cmd.exe could hide.
   */
  _commandLine() {
    return `"${systemShell()}" /k doskey claude="%PIXELQG_NODE%" "%PIXELQG_SHIM%" $*`;
  }

  _spawn(rec) {
    const t = rec.terminal;
    const file = this.posix ? this.scriptPath : this.bridgePath;
    const args = this.posix
      ? this._posixArgs(rec)
      : ['--cols', String(t.cols), '--rows', String(t.rows), '--cwd', t.cwd, '--cmd', this._commandLine()];
    let child;
    try {
      child = this.spawnFn(file, args, {
        cwd: t.cwd,
        env: this._env(rec),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        // macOS / Linux: own process group, so a Ctrl+C in the window running PixelQG never reaches it.
        detached: this.posix,
      });
    } catch (err) {
      this._appendNotice(rec, `Impossible de lancer le terminal : ${err && err.message ? err.message : err}`);
      this._onExit(rec, null);
      return;
    }
    rec.child = child;
    child.stdout.on('data', (chunk) => this._onOutput(rec, rec.decoder.write(chunk)));
    child.stderr.on('data', (chunk) => {
      rec.stderr = (rec.stderr + chunk.toString('utf8')).slice(-STDERR_TAIL);
    });
    child.stdin.on('error', () => {
      /* EPIPE once the bridge is gone: reported through its exit */
    });
    child.on('error', (err) => {
      if (!child.pid) {
        const missing = this.posix ? 'commande « script » introuvable' : 'hq-pty.exe introuvable';
        this._appendNotice(rec, `Impossible de lancer le terminal : ${err.code === 'ENOENT' ? missing : err.message}`);
        this._onExit(rec, null);
      }
    });
    child.on('close', (code) => {
      this._onOutput(rec, rec.decoder.end());
      this._onExit(rec, code);
    });
    if (rec.launch) {
      rec.launch.timer = setTimeout(() => this._launchClaude(rec), LAUNCH_FALLBACK_MS);
      rec.launch.timer.unref();
    }
  }

  _launchClaude(rec) {
    const launch = rec.launch;
    if (!launch) return;
    rec.launch = null;
    if (launch.timer) clearTimeout(launch.timer);
    this._send(rec, this._inputChunk(launch.text));
  }

  _send(rec, buf) {
    if (rec.exited || !rec.child || !rec.child.stdin || rec.child.stdin.destroyed || rec.child.stdin.writableEnded) return false;
    try {
      rec.child.stdin.write(buf);
      return true;
    } catch {
      return false;
    }
  }

  /** @param {boolean} [fromShell=true] false for PixelQG's own notices (the shell may not be up yet) */
  _onOutput(rec, text, fromShell = true) {
    if (!text) return;
    rec.chunks.push(text);
    rec.bytes += Buffer.byteLength(text, 'utf8');
    this._trimReplay(rec);
    this.emit('output', { id: rec.terminal.id, data: text });
    if (fromShell && rec.launch) this._launchClaude(rec); // the shell is up: type `claude`
  }

  _trimReplay(rec) {
    while (rec.bytes > this.replayBytes && rec.chunks.length > 1) {
      rec.bytes -= Buffer.byteLength(rec.chunks.shift(), 'utf8');
    }
    if (rec.bytes > this.replayBytes && rec.chunks.length === 1) {
      // A single huge chunk: keep its tail, never starting in the middle of a surrogate pair.
      const s = rec.chunks[0];
      let cut = Math.max(0, s.length - this.replayBytes);
      let tail = s.slice(cut);
      while (Buffer.byteLength(tail, 'utf8') > this.replayBytes) {
        cut += 1024;
        tail = s.slice(cut);
      }
      const first = tail.charCodeAt(0);
      if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
      rec.chunks[0] = tail;
      rec.bytes = Buffer.byteLength(tail, 'utf8');
    }
  }

  /** Writes a dim French notice into the terminal output (bridge errors). */
  _appendNotice(rec, message) {
    this._onOutput(rec, `\r\n\x1b[2m[PixelQG] ${message}\x1b[0m\r\n`, false);
  }

  _onExit(rec, code) {
    if (rec.exited) return;
    rec.exited = true;
    if (rec.startTimer) clearTimeout(rec.startTimer);
    rec.startTimer = null;
    if (rec.launch && rec.launch.timer) clearTimeout(rec.launch.timer);
    rec.launch = null;
    const t = rec.terminal;
    // Bridge errors (90-99) on Windows; on macOS / Linux, whatever `script` said before failing.
    const failed = this.posix ? typeof code === 'number' && code !== 0 : typeof code === 'number' && code >= 90 && code <= 99;
    if (!rec.killed && failed) {
      const msg = rec.stderr.trim().split(/\r?\n/).pop();
      if (msg) this._appendNotice(rec, msg);
    }
    t.status = 'exited';
    t.exitCode = typeof code === 'number' ? code : null;
    t.endedAt = Date.now();
    // Interactive sessions started here end with their terminal.
    this.manager.endTerminalLinksOf(t.id, {
      killed: rec.killed,
      reason: rec.killed ? 'Arrêté : terminal fermé' : 'Terminal terminé',
    });
    this.emit('exit', { id: t.id, code: t.exitCode });
    if (this.records.get(t.id) === rec) this._emitTerminal(rec);
    if (rec.resolveExit) rec.resolveExit();
  }

  _emitTerminal(rec) {
    this.emit('terminal', rec.terminal);
  }

  /** Keystrokes from a socket (UTF-8 text). */
  write(id, data) {
    const rec = this._mustGet(id);
    if (typeof data !== 'string' || !data) return false;
    return this._send(rec, this._inputChunk(data));
  }

  /**
   * Resizes the pseudoconsole (cols clamped to 20–400, rows to 5–200).
   * macOS / Linux: only the first size counts (it starts the shell); later sizes are ignored.
   */
  resize(id, cols, rows) {
    const rec = this._mustGet(id);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return false;
    const c = clamp(cols, COLS_RANGE);
    const r = clamp(rows, ROWS_RANGE);
    if (rec.terminal.status !== 'running') return false;
    if (this.posix) {
      if (!rec.startTimer) return false;
      rec.terminal.cols = c;
      rec.terminal.rows = r;
      this._startNow(rec);
      this._emitTerminal(rec);
      return true;
    }
    if (c === rec.terminal.cols && r === rec.terminal.rows) return true;
    const payload = Buffer.allocUnsafe(4);
    payload.writeUInt16LE(c, 0);
    payload.writeUInt16LE(r, 2);
    this._send(rec, frame(FRAME_RESIZE, payload));
    rec.terminal.cols = c;
    rec.terminal.rows = r;
    this._emitTerminal(rec);
    return true;
  }

  /** Kills the shell tree of a terminal. Resolves once the bridge exited. */
  kill(id) {
    const rec = this._mustGet(id);
    return this._kill(rec);
  }

  _kill(rec) {
    if (rec.exited) return Promise.resolve();
    rec.killed = true;
    if (rec.startTimer || !rec.child) {
      // macOS / Linux terminal whose shell has not started yet.
      this._onExit(rec, null);
      return rec.exitPromise;
    }
    if (this.posix) return this._killPosix(rec);
    if (!this._send(rec, frame(FRAME_TERMINATE))) {
      try {
        rec.child.kill();
      } catch {
        /* already gone */
      }
    }
    // The bridge answers a terminate frame at once; force it if it does not.
    const force = setTimeout(() => {
      if (!rec.exited && rec.child) {
        try {
          rec.child.kill();
        } catch {
          /* already gone */
        }
      }
    }, KILL_GRACE_MS);
    force.unref();
    return rec.exitPromise.then(() => clearTimeout(force));
  }

  /**
   * macOS / Linux: SIGKILL to `script`. The kernel then hangs up its pseudo-terminal, exactly like
   * closing a terminal window: the shell, Claude Code and their jobs get SIGHUP. (Gentler signals do
   * not work: util-linux `script` ignores SIGHUP and hands SIGTERM to the shell, which ignores it
   * when interactive; checked with util-linux 2.37.)
   */
  _killPosix(rec) {
    try {
      rec.child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    // A program that kept a copy of the output pipe would delay 'close' forever.
    const force = setTimeout(() => this._onExit(rec, null), KILL_GRACE_MS);
    force.unref();
    return rec.exitPromise.then(() => clearTimeout(force));
  }

  /** Kills and forgets a terminal (its linked agents stay in the office). */
  remove(id) {
    const rec = this._mustGet(id);
    const done = this._kill(rec);
    this.records.delete(id);
    this.emit('terminal-remove', { id });
    return done;
  }

  /** POST /api/terminals/:id/link */
  link(id, body) {
    const rec = this._mustGet(id);
    const { agent, linkId } = this.manager.linkTerminal(rec.terminal, body);
    // Most recent last; a resumed session moves to the terminal it now runs in.
    for (const other of this.records.values()) {
      const i = other.terminal.agentIds.indexOf(agent.id);
      if (i >= 0 && (other !== rec || i !== other.terminal.agentIds.length - 1)) {
        other.terminal.agentIds.splice(i, 1);
        if (other !== rec) this._emitTerminal(other);
      }
    }
    if (rec.terminal.agentIds[rec.terminal.agentIds.length - 1] !== agent.id) {
      rec.terminal.agentIds.push(agent.id);
      this._emitTerminal(rec);
    }
    return { agent, linkId };
  }

  /** POST /api/terminals/:id/unlink */
  unlink(id, body) {
    const rec = this._mustGet(id);
    return this.manager.unlinkTerminal(rec.terminal, body);
  }

  /** Kills every terminal (server shutdown). Resolves when all bridges exited or after 4 s. */
  shutdown() {
    this.closed = true;
    this.manager.off('remove', this._onAgentRemove);
    const waits = [];
    for (const rec of this.records.values()) waits.push(this._kill(rec));
    const timeout = new Promise((resolve) => setTimeout(resolve, 4000).unref());
    return Promise.race([Promise.all(waits), timeout]);
  }

  /**
   * Last-resort synchronous kill (process 'exit' handler): the job objects take the trees down
   * (Windows); on macOS / Linux the hang-up of each pseudo-terminal does.
   */
  killAllSync() {
    for (const rec of this.records.values()) {
      if (rec.startTimer) clearTimeout(rec.startTimer);
      if (!rec.exited && rec.child) {
        try {
          rec.child.kill(this.posix ? 'SIGKILL' : 'SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  }
}

module.exports = {
  TerminalManager,
  compileBridge,
  frame,
  BRIDGE_EXE,
  BRIDGE_SOURCE,
  SHIM_DIR,
  SHIM_SCRIPT,
  MAX_TERMINALS,
  REPLAY_BYTES,
  FRAME_INPUT,
  FRAME_RESIZE,
  FRAME_TERMINATE,
};
