'use strict';

// PixelQG server: static files, token-protected REST API and Server-Sent Events.
// Binds 127.0.0.1 only. See docs/CONTRACT.md section 3.
//
// Usage: node server/server.js [--port N] [--demo] [--no-observe] [--open]

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const { AgentManager, HqError, MODELS, PERMISSION_MODES } = require('./agents');
const { resolveClaude, getVersion } = require('./claude-bin');
const { DemoRunner } = require('./demo');
const { SessionWatcher } = require('./watcher');
const { TerminalManager } = require('./terminals');
const { Library } = require('./library');
const { acceptUpgrade, rejectUpgrade } = require('./ws');
const { LicenseManager, LicenseError } = require('./license');
const names = require('./names');

const VERSION = '1.0.0';
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4317;
const PORT_TRIES = 10;
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const MAX_BODY = 1024 * 1024;
const PING_MS = 15000;
const AGENT_THROTTLE_MS = 150;
const SSE_MAX_BUFFER = 8 * 1024 * 1024;
const WS_MAX_BUFFER = 8 * 1024 * 1024;
const WS_MAX_PAYLOAD = 1024 * 1024;
const UNLINK_FLUSH_MS = 1500;
const TERMINAL_ID_RE = /^t\d{1,9}$/;
const LIBRARY_ID_RE = /^[A-Za-z0-9._-]{1,120}$/;
const TOKEN_PLACEHOLDER = /__HQ_TOKEN__/g;
const LICENSE_WAIT_MS = 10000;
const LICENSE_REQUIRED = Object.freeze({ ok: false, error: 'Licence requise', code: 'license_required' });

const EFFORT_OPTIONS = Object.freeze([
  { value: '', label: 'Par défaut' },
  { value: 'low', label: 'Faible' },
  { value: 'medium', label: 'Moyen' },
  { value: 'high', label: 'Élevé' },
  { value: 'xhigh', label: 'Très élevé' },
  { value: 'max', label: 'Maximum' },
]);

const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
});

const HTML_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

// ------------------------------------------------------------------------------------------------
// CLI

/**
 * Parses command-line flags.
 * @returns {{port: number|null, demo: boolean, observe: boolean, open: boolean, help: boolean}}
 */
function parseArgs(argv) {
  const out = { port: null, demo: false, observe: true, open: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--demo') out.demo = true;
    else if (arg === '--no-observe') out.observe = false;
    else if (arg === '--open') out.open = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = arg === '--port' ? argv[++i] : arg.slice('--port='.length);
      out.port = parsePort(raw);
      if (out.port === null) throw new Error(`Port invalide : « ${raw === undefined ? '' : raw} » (attendu : un nombre entre 1 et 65535).`);
    } else {
      throw new Error(`Option inconnue : « ${arg} ». Options : --port N, --demo, --no-observe, --open.`);
    }
  }
  return out;
}

function parsePort(raw) {
  if (typeof raw !== 'string' || !/^\d{1,5}$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= 65535 ? n : null;
}

// ------------------------------------------------------------------------------------------------
// HTTP helpers

function setCommonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, status, body, extraHeaders) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    ...(extraHeaders || {}),
  });
  res.end(json);
}

function sendError(res, status, message, extraHeaders) {
  sendJson(res, status, { ok: false, error: message }, extraHeaders);
}

function sendText(res, status, text) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** Reads and parses a JSON body (≤ 1 MB). Empty bodies yield {}. */
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const lenHeader = req.headers['content-length'];
    const chunked = Boolean(req.headers['transfer-encoding']);
    const declared = lenHeader !== undefined ? Number(lenHeader) : 0;
    if (!chunked && (!declared || declared <= 0)) {
      req.resume();
      resolve({});
      return;
    }
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      reject(new HqError(415, 'Le corps de la requête doit être du JSON (Content-Type: application/json).'));
      return;
    }
    if (declared > MAX_BODY) {
      reject(new HqError(413, 'Requête trop volumineuse (1 Mo maximum).'));
      return;
    }
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(new HqError(413, 'Requête trop volumineuse (1 Mo maximum).'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HqError(400, 'JSON invalide dans le corps de la requête.'));
      }
    });
    req.on('error', () => {
      if (!failed) {
        failed = true;
        reject(new HqError(400, 'Lecture du corps de la requête impossible.'));
      }
    });
  });
}

function sameFile(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(child, parent) {
  const c = process.platform === 'win32' ? child.toLowerCase() : child;
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

// ------------------------------------------------------------------------------------------------
// Browser opening (--open)

function findEdge() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const root of roots) {
    const exe = path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

/** Opens the HQ page. The URL is built from the port only, never from user input. */
function openBrowser(port) {
  const url = `http://${HOST}:${Number(port)}/`;
  const run = (command, args, onFail, opts) => {
    let failed = false;
    const fail = () => {
      if (!failed) {
        failed = true;
        if (onFail) onFail();
      }
    };
    try {
      const child = childProcess.spawn(command, args, { stdio: 'ignore', ...(opts || {}) });
      child.on('error', fail);
      child.on('exit', (code) => {
        if (code) fail();
      });
      child.unref();
    } catch {
      fail();
    }
  };
  if (process.platform === 'win32') {
    const fallback = () => run('cmd', ['/c', 'start', '', url], null, { windowsHide: false });
    if (findEdge()) run('cmd', ['/c', 'start', '', 'msedge', `--app=${url}`], fallback, { windowsHide: false });
    else fallback();
  } else if (process.platform === 'darwin') {
    run('open', [url], null, { detached: true });
  } else {
    run('xdg-open', [url], null, { detached: true });
  }
  return url;
}

// ------------------------------------------------------------------------------------------------
// Server

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Starts the HQ server.
 * @param {object} [opts]
 * @param {number} [opts.port=4317] 0 = ephemeral port (tests)
 * @param {boolean} [opts.demo] start 4 demo agents
 * @param {boolean} [opts.observe=true] watch external sessions
 * @param {string} [opts.publicDir]
 * @param {object|null} [opts.claude] pre-resolved binary (skips resolution when provided)
 * @param {object} [opts.watcher] SessionWatcher options
 * @param {number} [opts.demoSpeed]
 * @param {string} [opts.token]
 * @param {boolean} [opts.skipVersion] do not run `claude --version`
 * @param {object} [opts.terminals] TerminalManager options (integrated terminal)
 * @param {object} [opts.library] Library options (home, gitBin, validate…); home defaults to
 *   env PIXELQG_HOME or ~/.pixelqg
 * @param {object} [opts.license] LicenseManager options; `{ bypass: true }` opens the gate for
 *   the test-suite (there is deliberately no env var or CLI flag for it)
 */
async function startServer(opts = {}) {
  const token = opts.token || crypto.randomBytes(24).toString('hex');
  const tokenDigest = crypto.createHash('sha256').update(token).digest();
  const publicDir = path.resolve(opts.publicDir || PUBLIC_DIR);
  const indexPath = path.join(publicDir, 'index.html');
  const warnings = [];
  const resolver = () => resolveClaude({
    onWarning: (w) => {
      if (!warnings.includes(w)) warnings.push(w);
    },
  });
  const claude = opts.claude !== undefined ? opts.claude : resolver();

  // Account licence (pixelqg-site/docs/ACCOUNTS.md §2): loads the local certificate (no network);
  // the online renewal starts once the server listens.
  const license = new LicenseManager(opts.license || {});
  const licenseReady = license.init().catch((err) => {
    console.error('[licence]', err && err.stack ? err.stack : err);
  });

  // Skills & agents library (docs/LIBRARY.md). Initialised in the background: the HTTP server
  // does not wait for git detection or wrapper rebuilds.
  const library = new Library({ claudeBin: claude, ...(opts.library || {}) });
  const libraryReady = library.init().catch((err) => {
    const w = `Bibliothèque de skills indisponible : ${err && err.message ? err.message : err}`;
    if (!warnings.includes(w)) warnings.push(w);
    console.error('[bibliothèque]', err && err.stack ? err.stack : err);
  });

  const manager = new AgentManager({
    claude,
    resolveClaude: opts.claude !== undefined && opts.claude !== null ? null : resolver,
    defaultCwd: os.homedir(),
    library,
  });
  const demo = new DemoRunner(manager, { speed: opts.demoSpeed || 1 });
  const watcher = new SessionWatcher(manager, opts.watcher || {});
  const terminals = new TerminalManager({ manager, defaultCwd: os.homedir(), library, ...(opts.terminals || {}) });
  const terminalsReady = terminals.init();

  const state = { port: 0, claudeVersion: null, allowedHosts: new Set(), allowedOrigins: new Set() };
  const clients = new Set();
  const throttle = new Map(); // agent id -> { last, timer }
  const sockets = new Map(); // terminal id -> Set<WebSocketConnection>

  function buildConfig() {
    return {
      version: VERSION,
      port: state.port,
      defaultCwd: os.homedir(),
      claudeFound: Boolean(manager.claude),
      claudePath: manager.claude ? manager.claude.path : null,
      claudeVersion: manager.claude ? state.claudeVersion : null,
      models: MODELS,
      permissionModes: PERMISSION_MODES,
      colors: names.COLORS,
      observe: watcher.enabled,
      demo: demo.active,
      efforts: EFFORT_OPTIONS,
      names: names.NAMES,
      nextName: manager.nextName(),
      nextColor: manager.nextColor(),
      platform: process.platform,
      terminal: terminals.config(),
      library: { gitFound: library.gitFound, pluginDir: library.pluginDir },
      license: license.state(),
    };
  }

  /** The only configuration a page without licence gets (no paths, no agent data). */
  function buildLockedConfig() {
    return { version: VERSION, port: state.port, platform: process.platform, license: license.state() };
  }

  function tokenOk(given) {
    if (typeof given !== 'string' || given.length === 0 || given.length > 512) return false;
    const digest = crypto.createHash('sha256').update(given).digest();
    return crypto.timingSafeEqual(digest, tokenDigest);
  }

  // ---------------------------------------------------------------- SSE

  function frame(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  function writeClient(client, text) {
    if (client.res.destroyed || client.res.writableEnded) {
      clients.delete(client);
      return;
    }
    client.res.write(text);
    if (client.res.writableLength > SSE_MAX_BUFFER) {
      // Slow consumer: drop it, it will reconnect and receive a fresh snapshot.
      clients.delete(client);
      client.res.destroy();
    }
  }

  function broadcast(event, data) {
    if (!clients.size) return;
    const text = frame(event, data);
    for (const client of clients) writeClient(client, text);
  }

  function flushAgent(id, st) {
    st.timer = null;
    st.last = Date.now();
    const agent = manager.get(id);
    if (agent) broadcast('agent', agent);
  }

  manager.on('agent', (agent) => {
    if (!clients.size) return;
    const id = agent.id;
    let st = throttle.get(id);
    if (!st) {
      st = { last: 0, timer: null };
      throttle.set(id, st);
    }
    if (st.timer) return; // a flush is already scheduled and will send the latest state
    // Never flush synchronously: one parsed event can change several fields in a row,
    // and clients must only ever see the coalesced, consistent result.
    const wait = Math.max(0, st.last + AGENT_THROTTLE_MS - Date.now());
    st.timer = setTimeout(() => flushAgent(id, st), wait);
  });
  manager.on('remove', ({ id }) => {
    const st = throttle.get(id);
    if (st && st.timer) clearTimeout(st.timer);
    throttle.delete(id);
    broadcast('remove', { id });
  });
  manager.on('log', (data) => broadcast('log', data));
  manager.on('tokens', (data) => broadcast('tokens', data));
  library.on('change', (lib) => broadcast('library', lib));
  manager.on('claude', (resolved) => {
    if (resolved && !library.claudeBin) library.claudeBin = resolved; // wrapper validation
    getVersion(resolved).then((v) => {
      state.claudeVersion = v;
    });
  });
  license.on('change', (st) => {
    if (st.licensed) {
      broadcast('license', st);
      return;
    }
    // Logout, revoked licence or expired certificate: close the live streams. The page notices,
    // asks GET /api/license and shows its login window; running agents are left alone.
    for (const client of clients) {
      try {
        client.res.end();
      } catch {
        /* already gone */
      }
    }
    clients.clear();
    for (const set of sockets.values()) for (const ws of set) ws.close(4402, 'Licence requise');
  });

  // ---------------------------------------------------------------- terminals (SSE + sockets)

  function socketSend(ws, message) {
    if (ws.bufferedAmount > WS_MAX_BUFFER) {
      // Slow consumer: drop it, it reconnects and gets the replay buffer.
      ws.terminate();
      return;
    }
    ws.send(JSON.stringify(message));
  }

  function socketBroadcast(id, message) {
    const set = sockets.get(id);
    if (!set || !set.size) return;
    for (const ws of set) socketSend(ws, message);
  }

  terminals.on('terminal', (terminal) => broadcast('terminal', terminal));
  terminals.on('terminal-remove', ({ id }) => {
    broadcast('terminal-remove', { id });
    const set = sockets.get(id);
    if (set) for (const ws of set) ws.close(1000, 'Terminal fermé');
    sockets.delete(id);
  });
  terminals.on('output', ({ id, data }) => socketBroadcast(id, { type: 'output', data }));
  terminals.on('exit', ({ id, code }) => socketBroadcast(id, { type: 'exit', code }));

  function attachSocket(id, ws) {
    let set = sockets.get(id);
    if (!set) {
      set = new Set();
      sockets.set(id, set);
    }
    set.add(ws);
    socketSend(ws, { type: 'replay', data: terminals.replay(id) });
    const terminal = terminals.get(id);
    if (terminal && terminal.status === 'exited') socketSend(ws, { type: 'exit', code: terminal.exitCode });
    ws.on('message', (data, isBinary) => {
      if (isBinary || !terminals.get(id)) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      try {
        if (msg.type === 'input' && typeof msg.data === 'string') terminals.write(id, msg.data);
        else if (msg.type === 'resize' && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) terminals.resize(id, msg.cols, msg.rows);
      } catch (err) {
        if (!(err instanceof HqError)) console.error('[terminal]', err && err.stack ? err.stack : err);
      }
    });
    ws.on('close', () => {
      set.delete(ws);
      if (!set.size && sockets.get(id) === set) sockets.delete(id);
    });
  }

  /** WebSocket upgrades: only /api/terminals/:id/socket, with the same guards as the REST API. */
  function onUpgrade(req, socket, head) {
    socket.on('error', () => {});
    const host = String(req.headers.host || '').toLowerCase();
    if (!state.allowedHosts.has(host)) {
      return rejectUpgrade(socket, 403, 'Hôte non autorisé : ouvre PixelQG via 127.0.0.1 ou localhost.');
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !state.allowedOrigins.has(String(origin).toLowerCase())) {
      return rejectUpgrade(socket, 403, 'Origine non autorisée.');
    }
    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      return rejectUpgrade(socket, 400, 'URL invalide.');
    }
    const m = /^\/api\/terminals\/([^/]+)\/socket$/.exec(url.pathname);
    if (!m) return rejectUpgrade(socket, 404, 'Route inconnue.');
    if (!tokenOk(url.searchParams.get('token')) && !tokenOk(req.headers['x-hq-token'])) {
      return rejectUpgrade(socket, 401, "Jeton d'accès manquant ou invalide. Recharge la page de PixelQG.");
    }
    if (!license.isLicensed()) return rejectUpgrade(socket, 402, 'Licence requise : connecte-toi à ton compte PixelQG.');
    if (!terminals.supported) return rejectUpgrade(socket, 501, terminals.reason || 'Le terminal intégré est indisponible.');
    let id;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      id = '';
    }
    if (!TERMINAL_ID_RE.test(id) || !terminals.get(id)) return rejectUpgrade(socket, 404, 'Terminal introuvable.');
    const ws = acceptUpgrade(req, socket, head, { maxPayload: WS_MAX_PAYLOAD });
    if (ws) attachSocket(id, ws);
  }

  const pingTimer = setInterval(() => {
    for (const client of clients) writeClient(client, ': ping\n\n');
  }, PING_MS);
  pingTimer.unref();

  function openEvents(req, res) {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const client = { res };
    clients.add(client);
    res.write('retry: 2000\n\n');
    res.write(frame('snapshot', { agents: manager.list(), config: buildConfig(), terminals: terminals.list(), library: library.get() }));
    const cleanup = () => clients.delete(client);
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  // ---------------------------------------------------------------- API

  /** Runs a Library call, turning its { status, message } errors into HqError (French messages). */
  async function libraryCall(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HqError) throw err;
      if (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600) {
        throw new HqError(err.status, err.message);
      }
      throw err;
    }
  }

  /** GET /api/license, POST /api/license/login | logout | refresh (open without a licence). */
  async function handleLicense(req, res, pathname) {
    const method = req.method;
    const notAllowed = (allow) => sendError(res, 405, 'Méthode non autorisée.', { Allow: allow });
    const sub = pathname === '/api/license' ? '' : pathname.slice('/api/license/'.length);
    try {
      if (sub === '') {
        if (method !== 'GET') return notAllowed('GET');
        // At startup an expired certificate may be renewing right now: wait for that first.
        if (!license.isLicensed()) await license.whenIdle(LICENSE_WAIT_MS);
        return sendJson(res, 200, { ok: true, license: license.state() });
      }
      if (sub === 'login') {
        if (method !== 'POST') return notAllowed('POST');
        const body = await readJsonBody(req);
        const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        const st = await license.login(b.email, b.password);
        return sendJson(res, 200, { ok: true, license: st });
      }
      if (sub === 'logout') {
        if (method !== 'POST') return notAllowed('POST');
        await readJsonBody(req);
        const out = await license.logout();
        return sendJson(res, 200, { ok: true, released: out.released, message: out.message, license: out.license });
      }
      if (sub === 'refresh') {
        if (method !== 'POST') return notAllowed('POST');
        await readJsonBody(req);
        const st = await license.refresh();
        return sendJson(res, 200, { ok: true, license: st });
      }
    } catch (err) {
      if (!(err instanceof LicenseError)) throw err;
      return sendJson(res, err.status, { ok: false, error: err.message, code: err.code, license: license.state() });
    }
    throw new HqError(404, 'Route inconnue.');
  }

  async function handleApi(req, res, url) {
    const pathname = url.pathname;
    let authorized = tokenOk(req.headers['x-hq-token']);
    if (!authorized && req.method === 'GET' && pathname === '/api/events') {
      authorized = tokenOk(url.searchParams.get('token'));
    }
    if (!authorized && req.method === 'POST') {
      // The `claude` shim of a terminal only holds that terminal's link token.
      const lm = /^\/api\/terminals\/(t\d{1,9})\/(link|unlink)$/.exec(pathname);
      if (lm) authorized = terminals.linkTokenOk(lm[1], req.headers['x-hq-token']);
    }
    if (!authorized) {
      sendError(res, 401, "Jeton d'accès manquant ou invalide. Recharge la page de PixelQG.");
      return;
    }

    const method = req.method;
    const notAllowed = (allow) => sendError(res, 405, 'Méthode non autorisée.', { Allow: allow });

    // Licence gate: only /api/license/* and a minimal /api/config answer without a valid certificate.
    if (pathname === '/api/license' || pathname.startsWith('/api/license/')) return handleLicense(req, res, pathname);
    if (!license.isLicensed()) {
      if (pathname === '/api/config' && method === 'GET') return sendJson(res, 200, { ok: true, config: buildLockedConfig() });
      req.resume();
      return sendJson(res, 402, LICENSE_REQUIRED);
    }

    if (pathname === '/api/events') {
      if (method !== 'GET') return notAllowed('GET');
      return openEvents(req, res);
    }
    if (pathname === '/api/config') {
      if (method !== 'GET') return notAllowed('GET');
      return sendJson(res, 200, { ok: true, config: buildConfig() });
    }
    if (pathname === '/api/agents') {
      if (method === 'GET') return sendJson(res, 200, { ok: true, agents: manager.list() });
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const agent = manager.createAgent(body);
        return sendJson(res, 201, { ok: true, agent });
      }
      return notAllowed('GET, POST');
    }
    if (pathname === '/api/demo') {
      if (method !== 'POST') return notAllowed('POST');
      const body = await readJsonBody(req);
      let count = 4;
      if (body && typeof body === 'object' && body.count !== undefined && body.count !== null) {
        if (!Number.isInteger(body.count) || body.count < 1 || body.count > 8) {
          throw new HqError(400, "Nombre d'agents de démonstration invalide (entre 1 et 8).");
        }
        count = body.count;
      }
      const agents = demo.start(count);
      if (!agents.length) {
        throw new HqError(409, `Nombre maximal d'agents de démonstration atteint (${demo.maxAgents}).`);
      }
      return sendJson(res, 200, { ok: true, agents });
    }
    if (pathname === '/api/demo/stop') {
      if (method !== 'POST') return notAllowed('POST');
      await readJsonBody(req);
      demo.stopAll();
      return sendJson(res, 200, { ok: true });
    }
    if (pathname === '/api/observe') {
      if (method !== 'POST') return notAllowed('POST');
      const body = await readJsonBody(req);
      if (!body || typeof body.enabled !== 'boolean') {
        throw new HqError(400, 'Le champ « enabled » doit être un booléen (true ou false).');
      }
      watcher.setEnabled(body.enabled);
      return sendJson(res, 200, { ok: true, config: buildConfig() });
    }

    if (pathname === '/api/library') {
      if (method !== 'GET') return notAllowed('GET');
      return sendJson(res, 200, { ok: true, library: library.get() });
    }
    if (pathname === '/api/library/repos') {
      if (method !== 'POST') return notAllowed('POST');
      const body = await readJsonBody(req);
      const url = body && typeof body === 'object' && !Array.isArray(body) ? body.url : undefined;
      const repo = await libraryCall(() => library.link(url));
      return sendJson(res, 202, { ok: true, repo });
    }
    const lm = /^\/api\/library\/repos\/([^/]+)(?:\/(update|toggle))?$/.exec(pathname);
    if (lm) {
      let id;
      try {
        id = decodeURIComponent(lm[1]);
      } catch {
        id = '';
      }
      if (!LIBRARY_ID_RE.test(id)) throw new HqError(404, 'Dépôt inconnu : il a peut-être déjà été retiré.');
      const action = lm[2] || null;
      if (action === 'update') {
        if (method !== 'POST') return notAllowed('POST');
        await readJsonBody(req);
        const repo = await libraryCall(() => library.update(id));
        return sendJson(res, 202, { ok: true, repo });
      }
      if (action === 'toggle') {
        if (method !== 'POST') return notAllowed('POST');
        const body = await readJsonBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          throw new HqError(400, 'Corps de requête invalide : un objet JSON est attendu.');
        }
        const repo = await libraryCall(() => library.toggle(id, { enabled: body.enabled, key: body.key }));
        return sendJson(res, 200, { ok: true, repo });
      }
      if (method === 'DELETE') {
        await libraryCall(() => library.remove(id));
        return sendJson(res, 200, { ok: true });
      }
      return notAllowed('DELETE');
    }

    if (pathname === '/api/terminals') {
      if (method === 'GET') return sendJson(res, 200, { ok: true, terminals: terminals.list() });
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const terminal = terminals.create(body);
        return sendJson(res, 201, { ok: true, terminal });
      }
      return notAllowed('GET, POST');
    }
    const tm = /^\/api\/terminals\/([^/]+)(?:\/(link|unlink|socket))?$/.exec(pathname);
    if (tm) {
      if (!terminals.supported) throw new HqError(501, terminals.reason || 'Le terminal intégré est indisponible.');
      let id;
      try {
        id = decodeURIComponent(tm[1]);
      } catch {
        id = '';
      }
      if (!TERMINAL_ID_RE.test(id) || !terminals.get(id)) throw new HqError(404, 'Terminal introuvable.');
      const action = tm[2] || null;
      if (action === 'link') {
        if (method !== 'POST') return notAllowed('POST');
        const body = await readJsonBody(req);
        const { agent, linkId } = terminals.link(id, body);
        return sendJson(res, 200, { ok: true, agent, linkId });
      }
      if (action === 'unlink') {
        if (method !== 'POST') return notAllowed('POST');
        const body = await readJsonBody(req);
        // Read the transcript's last lines while the link is still live, then close the session.
        await Promise.race([
          watcher.flushLinked().catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, UNLINK_FLUSH_MS).unref()),
        ]);
        terminals.unlink(id, body);
        return sendJson(res, 200, { ok: true });
      }
      if (action === 'socket') {
        return sendError(res, 426, 'Cette adresse attend une connexion WebSocket.', { Upgrade: 'websocket' });
      }
      if (method === 'GET') return sendJson(res, 200, { ok: true, terminal: terminals.get(id) });
      if (method === 'DELETE') {
        terminals.remove(id);
        return sendJson(res, 200, { ok: true });
      }
      return notAllowed('GET, DELETE');
    }

    const m = /^\/api\/agents\/([^/]+)(?:\/(logs|message|stop))?$/.exec(pathname);
    if (m) {
      let id;
      try {
        id = decodeURIComponent(m[1]);
      } catch {
        id = '';
      }
      if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new HqError(404, 'Agent introuvable.');
      const action = m[2] || null;
      if (action === 'logs') {
        if (method !== 'GET') return notAllowed('GET');
        const logs = manager.getLogs(id);
        if (!logs) throw new HqError(404, 'Agent introuvable.');
        return sendJson(res, 200, { ok: true, logs });
      }
      if (action === 'message') {
        if (method !== 'POST') return notAllowed('POST');
        const body = await readJsonBody(req);
        const agent = manager.sendMessage(id, body);
        return sendJson(res, 200, { ok: true, agent });
      }
      if (action === 'stop') {
        if (method !== 'POST') return notAllowed('POST');
        await readJsonBody(req);
        const agent = manager.stop(id);
        return sendJson(res, 200, { ok: true, agent });
      }
      if (method === 'GET') {
        const agent = manager.get(id);
        if (!agent) throw new HqError(404, 'Agent introuvable.');
        return sendJson(res, 200, { ok: true, agent });
      }
      if (method === 'DELETE') {
        manager.remove(id);
        return sendJson(res, 200, { ok: true });
      }
      return notAllowed('GET, DELETE');
    }
    throw new HqError(404, 'Route inconnue.');
  }

  // ---------------------------------------------------------------- static files

  async function serveIndex(req, res) {
    let html;
    try {
      html = await fsp.readFile(indexPath, 'utf8');
    } catch {
      return sendText(res, 404, "Interface introuvable : le fichier public/index.html est manquant.");
    }
    const body = Buffer.from(html.replace(TOKEN_PLACEHOLDER, token), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Content-Security-Policy': HTML_CSP,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendText(res, 405, 'Méthode non autorisée.');
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return sendText(res, 400, 'Chemin invalide.');
    }
    if (pathname.includes('\0')) return sendText(res, 400, 'Chemin invalide.');
    if (pathname === '/' || pathname === '') return serveIndex(req, res);

    const resolved = path.resolve(publicDir, '.' + path.sep + pathname.replace(/^[/\\]+/, ''));
    if (!isInside(resolved, publicDir) || resolved === publicDir) return sendText(res, 404, 'Fichier introuvable.');
    if (sameFile(resolved, indexPath)) return serveIndex(req, res);
    const type = MIME[path.extname(resolved).toLowerCase()];
    if (!type) return sendText(res, 404, 'Fichier introuvable.');

    let real;
    let st;
    try {
      real = await fsp.realpath(resolved);
      st = await fsp.stat(real);
    } catch {
      return sendText(res, 404, 'Fichier introuvable.');
    }
    let realPublic = publicDir;
    try {
      realPublic = await fsp.realpath(publicDir);
    } catch {
      /* keep the configured path */
    }
    if (!st.isFile() || !isInside(real, realPublic)) return sendText(res, 404, 'Fichier introuvable.');
    if (sameFile(real, indexPath)) return serveIndex(req, res);

    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(real);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ---------------------------------------------------------------- request entry point

  async function onRequest(req, res) {
    setCommonHeaders(res);
    const host = String(req.headers.host || '').toLowerCase();
    if (!state.allowedHosts.has(host)) {
      return sendError(res, 403, 'Hôte non autorisé : ouvre PixelQG via 127.0.0.1 ou localhost.', { Connection: 'close' });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !state.allowedOrigins.has(String(origin).toLowerCase())) {
      return sendError(res, 403, 'Origine non autorisée.', { Connection: 'close' });
    }
    let url;
    try {
      url = new URL(req.url, `http://${host}`);
    } catch {
      return sendError(res, 400, 'URL invalide.');
    }
    try {
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof HqError) {
        const close = err.status === 413 || err.status === 415;
        sendError(res, err.status, err.message, close ? { Connection: 'close' } : undefined);
        if (close) res.on('finish', () => req.destroy());
      } else {
        console.error('[serveur]', err && err.stack ? err.stack : err);
        sendError(res, 500, 'Erreur interne du serveur.');
      }
    }
  }

  const server = http.createServer((req, res) => {
    onRequest(req, res).catch((err) => {
      console.error('[serveur]', err && err.stack ? err.stack : err);
      try {
        sendError(res, 500, 'Erreur interne du serveur.');
      } catch {
        /* response already gone */
      }
    });
  });
  server.keepAliveTimeout = 5000;
  server.on('upgrade', (req, socket, head) => {
    try {
      onUpgrade(req, socket, head);
    } catch (err) {
      console.error('[websocket]', err && err.stack ? err.stack : err);
      rejectUpgrade(socket, 500, 'Erreur interne du serveur.');
    }
  });

  await licenseReady;

  // Port selection: the requested port, then up to 10 following ports if busy.
  const firstPort = opts.port === undefined || opts.port === null ? DEFAULT_PORT : Number(opts.port);
  const tries = firstPort === 0 ? 1 : PORT_TRIES + 1;
  let port = null;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    const candidate = firstPort === 0 ? 0 : firstPort + i;
    if (candidate > 65535) break;
    try {
      port = await listenOn(server, candidate, HOST);
      break;
    } catch (err) {
      lastErr = err;
      if (err.code !== 'EADDRINUSE' && err.code !== 'EACCES') break;
    }
  }
  if (port === null) {
    watcher.dispose();
    license.close();
    await libraryReady;
    await library.close();
    await terminalsReady;
    await terminals.shutdown();
    clearInterval(pingTimer);
    const last = Math.min(65535, firstPort + PORT_TRIES);
    const why = lastErr && (lastErr.code === 'EADDRINUSE' || lastErr.code === 'EACCES')
      ? `Aucun port libre entre ${firstPort} et ${last}.`
      : `Impossible de démarrer le serveur : ${lastErr ? lastErr.message : 'erreur inconnue'}.`;
    const e = new Error(why);
    e.code = lastErr ? lastErr.code : 'ELISTEN';
    throw e;
  }
  state.port = port;
  state.allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  state.allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  terminals.setEndpoint(`http://${HOST}:${port}`);
  await terminalsReady;
  for (const w of terminals.warnings) if (!warnings.includes(w)) warnings.push(w);

  if (!opts.skipVersion && manager.claude) state.claudeVersion = await getVersion(manager.claude);
  if (opts.observe !== false) watcher.start();
  if (opts.demo) demo.start(4);
  license.startAutoRefresh();

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      watcher.dispose();
      license.close();
      clearInterval(pingTimer);
      for (const st of throttle.values()) if (st.timer) clearTimeout(st.timer);
      throttle.clear();
      for (const client of clients) {
        try {
          client.res.end();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      for (const set of sockets.values()) for (const ws of set) ws.terminate();
      sockets.clear();
      await terminals.shutdown();
      await manager.stopAll();
      await library.close();
      await new Promise((resolve) => {
        server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    })();
    return closing;
  }

  return {
    server,
    port,
    url: `http://${HOST}:${port}/`,
    token,
    manager,
    demo,
    watcher,
    terminals,
    library,
    libraryReady,
    license,
    warnings,
    config: buildConfig,
    close,
  };
}

// ------------------------------------------------------------------------------------------------
// Entry point

function printBanner(app, args) {
  const cfg = app.config();
  const lines = [
    '',
    '  ╭───────────────────────────────────────────────╮',
    '  │   PixelQG est ouvert ! Le bureau t’attend.  │',
    '  ╰───────────────────────────────────────────────╯',
    '',
    `  →  Adresse : ${app.url}`,
    cfg.claudeFound
      ? `  ✓  Claude Code : ${cfg.claudeVersion || 'version inconnue'} (${cfg.claudePath})`
      : '  ⚠  Claude Code introuvable : installe-le ou définis la variable CLAUDE_BIN.',
    `  •  Sessions externes : ${cfg.observe ? 'observées (sessions Claude Code lancées ailleurs)' : 'ignorées (--no-observe)'}`,
    cfg.terminal.supported
      ? '  •  Terminal intégré : prêt (tape « claude » dedans, la session apparaît dans le bureau)'
      : `  •  Terminal intégré : indisponible (${cfg.terminal.reason})`,
  ];
  const lic = cfg.license;
  if (lic.devMode) lines.push('  •  Licence : mode développeur (comptes non configurés dans cloud-config.js)');
  else if (lic.licensed) lines.push(`  ✓  Licence : active sur ce PC${lic.offline ? ' (hors ligne)' : ''}`);
  else lines.push('  ⚠  Licence : ouvre l’adresse ci-dessus et connecte-toi à ton compte PixelQG');
  if (args.demo) lines.push('  •  Mode démo : 4 agents simulés (aucun jeton dépensé)');
  if (app.port !== (args.port || DEFAULT_PORT)) lines.push(`  ℹ  Le port demandé était occupé : utilisation du port ${app.port}.`);
  for (const w of app.warnings) lines.push(`  ⚠  ${w}`);
  lines.push('', '  Appuie sur Ctrl+C pour tout arrêter (les agents en cours seront stoppés).', '');
  console.log(lines.join('\n'));
}

async function main() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.error(`\n  PixelQG nécessite Node.js 20 ou plus récent (version actuelle : ${process.versions.node}).\n  Télécharge-le sur https://nodejs.org\n`);
    process.exit(1);
  }
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
  if (args.help) {
    console.log([
      '',
      '  PixelQG — ton bureau d’agents Claude Code',
      '',
      '  node server/server.js [options]',
      '    --port N       port d’écoute (défaut 4317, ou variable HQ_PORT)',
      '    --demo         lance 4 agents simulés (aucun jeton dépensé)',
      '    --no-observe   n’observe pas les sessions Claude Code lancées ailleurs',
      '    --open         ouvre le navigateur automatiquement',
      '',
    ].join('\n'));
    return;
  }
  let port = args.port;
  if (port === null && process.env.HQ_PORT) {
    port = parsePort(String(process.env.HQ_PORT));
    if (port === null) {
      console.error(`\n  Variable HQ_PORT invalide : « ${process.env.HQ_PORT} » (attendu : un nombre entre 1 et 65535).\n`);
      process.exit(1);
    }
  }
  if (port === null) port = DEFAULT_PORT;

  let app;
  try {
    app = await startServer({ port, demo: args.demo, observe: args.observe });
  } catch (err) {
    console.error(`\n  ✖  ${err.message}\n  Astuce : choisis un autre port avec --port N ou la variable HQ_PORT.\n`);
    process.exit(1);
  }
  printBanner(app, { ...args, port });
  if (args.open) openBrowser(app.port);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) {
      process.exit(1);
      return;
    }
    stopping = true;
    console.log('\n  Arrêt de PixelQG… les agents en cours sont stoppés.');
    const force = setTimeout(() => process.exit(0), 8000);
    force.unref();
    try {
      await app.close();
    } catch (err) {
      console.error('  Erreur pendant l’arrêt :', err && err.message ? err.message : err);
    }
    console.log('  À bientôt !\n');
    process.exit(0);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(sig, shutdown);
    } catch {
      /* signal not supported on this platform */
    }
  }
  process.on('exit', () => {
    app.terminals.killAllSync();
    app.manager.killAllSync();
  });
  process.on('uncaughtException', (err) => {
    console.error('[erreur inattendue]', err && err.stack ? err.stack : err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('[promesse rejetée]', err && err.stack ? err.stack : err);
  });
}

if (require.main === module) {
  main();
}

module.exports = { startServer, parseArgs, openBrowser, VERSION, DEFAULT_PORT };
