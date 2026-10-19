/*
 * PixelQG — integrated terminal sessions (window.HQTerminal).
 *
 * Renders the terminal tabs of the dock's « Terminal » panel and one xterm.js instance per
 * server-side terminal (cmd.exe behind the ConPTY bridge, see docs/TERMINAL.md). Each terminal
 * keeps its own WebSocket alive with exponential backoff: the first message is a replay of the
 * buffered output (the screen is reset, then the replay is written), then live output follows;
 * keystrokes go back as `input` messages and the PTY follows the visible size (FitAddon +
 * ResizeObserver, debounced `resize` messages).
 *
 * main.js owns the Terminal store (mirrored from SSE) and hands accessors and actions through
 * init(); ui.js owns the dock (tabs, toolbar) and tells this module when the panel is visible.
 *
 * Safety rule: every server string is written with textContent / setAttribute; nothing here parses
 * HTML. Terminal output only ever reaches xterm.js, which renders text cells, never markup.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ constants

  const SCROLLBACK = 5000;
  const FONT_FAMILY = '"JetBrains Mono", ui-monospace, Consolas, monospace';
  // Same fonts, different string: assigning it then FONT_FAMILY forces xterm to re-measure its cells.
  const FONT_FAMILY_ALT = '"JetBrains Mono", Consolas, ui-monospace, monospace';
  const FONT_SIZE = 13;
  const MIN_COLS = 20;
  const MAX_COLS = 400;
  const MIN_ROWS = 5;
  const MAX_ROWS = 200;
  const FIT_DELAY = 60;
  const RESIZE_DELAY = 140;
  const BACKOFF_BASE = 800;
  const BACKOFF_MAX = 15000;
  const EXITED_RETRIES = 3;
  const CONFIRM_TIMEOUT = 8000;
  const AVATARS_MAX = 3;
  const LINKS_MAX = 4;
  const INPUT_CHUNK = 16384;
  const FONT_WAIT = 2000;
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;
  const STORE_ACTIVE = 'pixelqg-app:term-active';
  const ALIVE = new Set(['starting', 'working', 'waiting']);
  const STATUS_SHORT = {
    starting: 'démarre', working: 'travaille', waiting: 'en attente',
    done: 'terminé', error: 'erreur', stopped: 'arrêté'
  };

  // ------------------------------------------------------------------ small helpers

  function str(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : String(v);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function intOr(v, lo, hi, fallback) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
  }

  function safeColor(c) {
    return typeof c === 'string' && HEX_RE.test(c) ? c : '#A0A7B8';
  }

  function domId(id) {
    return str(id).replace(/[^A-Za-z0-9_-]/g, '_');
  }

  function setText(node, value) {
    const v = str(value);
    if (node && node.textContent !== v) node.textContent = v;
  }

  function setAttr(node, name, value) {
    if (!node) return;
    if (value === null || value === undefined || value === false) {
      if (node.hasAttribute(name)) node.removeAttribute(name);
      return;
    }
    const v = value === true ? '' : String(value);
    if (node.getAttribute(name) !== v) node.setAttribute(name, v);
  }

  function setHidden(node, hidden) {
    if (node && node.hidden !== !!hidden) node.hidden = !!hidden;
  }

  function storageGet(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (_) {
      /* storage unavailable (private mode, blocked site data): the preference is simply not kept */
    }
  }

  /** Minimal DOM builder. Children may be nodes or strings (inserted as text). */
  function h(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const key of Object.keys(attrs)) {
        const v = attrs[key];
        if (v === null || v === undefined || v === false) continue;
        if (key === 'class') node.className = v;
        else node.setAttribute(key, v === true ? '' : String(v));
      }
    }
    if (children !== undefined && children !== null) {
      const list = Array.isArray(children) ? children : [children];
      for (const c of list) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c instanceof Node ? c : str(c));
      }
    }
    return node;
  }

  /** Splits a string into chunks without cutting a UTF-16 surrogate pair in half. */
  function chunks(text, size) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      let end = Math.min(text.length, i + size);
      if (end < text.length) {
        const code = text.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      }
      out.push(text.slice(i, end));
      i = end;
    }
    return out;
  }

  /** French "de" + name with elision: « de Nova », « d'Orion », « d'Écho ». */
  function ofName(name) {
    return (/^[aeiouyhàâäéèêëîïôöûüœæ]/i.test(name) ? 'd\'' : 'de ') + name;
  }

  function cssVar(name, fallback) {
    try {
      const v = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function withAlpha(hex, a) {
    const c = HEX_RE.test(hex) ? hex : '#D97757';
    const n = parseInt(c.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ------------------------------------------------------------------ module state

  const noop = () => undefined;
  const cb = {
    token: '',
    getTerminals: () => [],
    getTerminal: () => undefined,
    getAgent: () => undefined,
    drawAvatar: noop,
    onSelectAgent: noop,
    onClose: () => Promise.resolve(false),
    onReopen: () => Promise.resolve(null),
    toast: noop
  };

  let els = {};
  let initialized = false;
  let support = { supported: false, ready: false, reason: '' };
  let conpty = false;
  let visible = false;
  let activeId = null;
  let dead = false;
  let fontsReady = false;
  let measuredWithFont = false;
  let fitTimer = 0;
  let renderQueued = false;
  let confirmId = null;
  let confirmTimer = 0;
  let headSig = '';
  let theme = null;

  const recs = new Map();   // terminal id → session record (xterm + socket), see ensureRec()

  // ------------------------------------------------------------------ support / config

  function xtermLoaded() {
    return typeof window.Terminal === 'function'
      && !!window.FitAddon && typeof window.FitAddon.FitAddon === 'function';
  }

  /**
   * What the « Terminal » tab can do with this server. A server without the terminal feature (no
   * `config.terminal`) is treated as unsupported, so the page degrades gracefully.
   */
  function computeSupport(cfg) {
    if (!cfg || typeof cfg !== 'object') {
      return { supported: false, ready: false, reason: 'Connexion au serveur PixelQG…' };
    }
    const t = cfg.terminal;
    if (!t || typeof t !== 'object') {
      return {
        supported: false,
        ready: true,
        reason: 'Ce serveur PixelQG ne propose pas encore le terminal intégré. Mets PixelQG à jour, puis relance-le.'
      };
    }
    if (t.supported !== true) {
      return {
        supported: false,
        ready: true,
        reason: str(t.reason).trim() || 'Le terminal intégré n\'est pas disponible sur cet ordinateur (il demande Windows 10 version 1809 ou plus récent).'
      };
    }
    if (!xtermLoaded()) {
      return {
        supported: false,
        ready: true,
        reason: 'Le composant d\'affichage du terminal (xterm.js) n\'a pas pu être chargé. Recharge la page.'
      };
    }
    return { supported: true, ready: true, reason: null, shell: str(t.shell) || 'cmd.exe' };
  }

  function setConfig(cfg) {
    const next = computeSupport(cfg);
    const was = support.supported;
    support = next;
    // The bridge is ConPTY-based (Windows only): xterm then keeps ConPTY's own reflow on resize.
    conpty = next.supported && /(^|[\\/])(cmd|powershell|pwsh)(\.exe)?$/i.test(str(next.shell).trim());
    if (was && !next.supported) {
      for (const id of Array.from(recs.keys())) disposeRec(id);
      activeId = null;
    }
    if (next.supported) sync();
    scheduleRender();
    return next;
  }

  function buildTheme() {
    if (theme) return theme;
    const ink = cssVar('--ink', '#14151f');
    const accent = cssVar('--accent', '#D97757');
    theme = {
      background: ink,
      foreground: cssVar('--text', '#ece8f4'),
      cursor: accent,
      cursorAccent: ink,
      selectionBackground: withAlpha(accent, 0.38),
      selectionInactiveBackground: withAlpha(cssVar('--muted', '#9b9cb8'), 0.22),
      black: cssVar('--panel-2', '#262a3d'),
      red: cssVar('--err', '#e5534b'),
      green: cssVar('--ok', '#6cc28a'),
      yellow: cssVar('--warn', '#f2c14e'),
      blue: cssVar('--info', '#6aa9ff'),
      magenta: cssVar('--lavender', '#b48ee0'),
      cyan: cssVar('--teal', '#4fc1b9'),
      white: '#c9c6da',
      brightBlack: '#6c6e8c',
      brightRed: '#f2a19c',
      brightGreen: '#a9e2bb',
      brightYellow: '#f7d98a',
      brightBlue: '#9cc6ff',
      brightMagenta: '#d2b8f0',
      brightCyan: '#8ee0d9',
      brightWhite: '#ffffff'
    };
    return theme;
  }

  // ------------------------------------------------------------------ store access

  function validTerminal(t) {
    return !!t && typeof t === 'object' && typeof t.id === 'string' && t.id.length > 0;
  }

  function terminalOf(id) {
    if (!id) return undefined;
    try {
      const t = cb.getTerminal(id);
      return validTerminal(t) ? t : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function sortedTerminals() {
    let list = [];
    try {
      const it = cb.getTerminals();
      list = it ? Array.from(it).filter(validTerminal) : [];
    } catch (_) {
      list = [];
    }
    return list.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0)
      || a.id.localeCompare(b.id, 'fr', { numeric: true }));
  }

  function linkedAgents(t) {
    const ids = t && Array.isArray(t.agentIds) ? t.agentIds : [];
    const out = [];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      let a;
      try {
        a = cb.getAgent(id);
      } catch (_) {
        a = undefined;
      }
      if (a && typeof a.id === 'string') out.push(a);
    }
    return out;
  }

  function statusShort(a) {
    if (a.status === 'waiting' && a.interactive) return 't\'attend';
    return STATUS_SHORT[a.status] || '';
  }

  function isExited(rec, t) {
    return (t && t.status === 'exited') || rec.exitSeen;
  }

  // ------------------------------------------------------------------ fonts

  function fontAvailable() {
    try {
      return !!document.fonts && document.fonts.check(FONT_SIZE + 'px "JetBrains Mono"');
    } catch (_) {
      return false;
    }
  }

  /**
   * xterm measures its cell size when it opens: wait (briefly) for JetBrains Mono so the grid is
   * not measured with a fallback font. If the font only arrives later, re-measure every terminal.
   */
  function prepareFonts() {
    const fonts = document.fonts;
    if (!fonts || typeof fonts.load !== 'function') {
      fontsReady = true;
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      fontsReady = true;
      measuredWithFont = fontAvailable();
      openActive();
    };
    setTimeout(finish, FONT_WAIT);
    Promise.all([
      fonts.load('400 ' + FONT_SIZE + 'px "JetBrains Mono"'),
      fonts.load('700 ' + FONT_SIZE + 'px "JetBrains Mono"')
    ]).then(finish, finish);
    if (typeof fonts.addEventListener === 'function') {
      fonts.addEventListener('loadingdone', () => {
        if (!fontsReady || measuredWithFont || !fontAvailable()) return;
        measuredWithFont = true;
        for (const rec of recs.values()) {
          if (!rec.opened) continue;
          try {
            rec.term.options.fontFamily = FONT_FAMILY_ALT;
            rec.term.options.fontFamily = FONT_FAMILY;
          } catch (_) {
            /* re-measure is best effort */
          }
        }
        scheduleFit();
      });
    }
  }

  // ------------------------------------------------------------------ session records

  /**
   * One record per terminal: the xterm instance (created at once so output can be written before
   * it is shown), its host element, and the WebSocket state.
   */
  function ensureRec(t) {
    const existing = recs.get(t.id);
    if (existing) return existing;
    const hostId = 'term-host-' + domId(t.id);
    const host = h('div', { class: 'term-host', id: hostId, role: 'tabpanel' });
    const options = {
      cols: intOr(t.cols, MIN_COLS, MAX_COLS, 120),
      rows: intOr(t.rows, MIN_ROWS, MAX_ROWS, 30),
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: SCROLLBACK,
      fontFamily: FONT_FAMILY,
      fontSize: FONT_SIZE,
      lineHeight: 1.1,
      fontWeight: '400',
      fontWeightBold: '700',
      theme: buildTheme(),
      allowProposedApi: false,
      convertEol: false,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      scrollOnUserInput: true,
      smoothScrollDuration: 0
    };
    if (conpty) options.windowsPty = { backend: 'conpty' };

    let term;
    let fit;
    try {
      term = new window.Terminal(options);
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
    } catch (err) {
      console.error('[PixelQG] Impossible de créer le terminal ' + t.id + '.', err);
      return null;
    }

    const rec = {
      id: t.id,
      term,
      fit,
      host,
      tab: null,
      opened: false,
      fitted: false,
      pendingFocus: false,
      ws: null,
      wsState: 'idle',        // idle | connecting | open | offline (retry scheduled) | closed (final)
      attempt: 0,
      retryTimer: 0,
      retryAt: 0,
      resizeTimer: 0,
      sentCols: 0,
      sentRows: 0,
      replayed: false,
      replaying: false,
      exitSeen: false,
      exitCode: null,
      exitTries: 0,
      exitShown: false,
      oscTitle: '',
      disposed: false
    };

    term.onData((data) => sendInput(rec, data));
    term.onResize(() => queueResizeSend(rec));
    term.onTitleChange((title) => {
      rec.oscTitle = str(title).slice(0, 200);
      scheduleRender();
    });
    term.attachCustomKeyEventHandler((e) => onTermKey(rec, e));

    els.viewport.appendChild(host);
    recs.set(t.id, rec);
    if (t.status === 'exited') applyExited(rec);
    connect(rec);
    return rec;
  }

  function disposeRec(id) {
    const rec = recs.get(id);
    if (!rec) return;
    rec.disposed = true;
    clearTimeout(rec.retryTimer);
    clearTimeout(rec.resizeTimer);
    if (rec.ws) {
      const ws = rec.ws;
      rec.ws = null;
      try {
        ws.close(1000);
      } catch (_) {
        /* already closing */
      }
    }
    try {
      rec.term.dispose();
    } catch (_) {
      /* xterm teardown is best effort */
    }
    rec.host.remove();
    if (rec.tab) rec.tab.wrap.remove();
    recs.delete(id);
  }

  function applyExited(rec) {
    try {
      rec.term.options.cursorBlink = false;
      rec.term.options.disableStdin = true;
    } catch (_) {
      /* options are cosmetic here */
    }
  }

  /** Reconciles session records with the store (creates missing ones, drops the stale ones). */
  function sync() {
    if (!initialized || !support.supported) return;
    const list = sortedTerminals();
    const ids = new Set(list.map((t) => t.id));
    for (const id of Array.from(recs.keys())) {
      if (!ids.has(id)) disposeRec(id);
    }
    for (const t of list) {
      const rec = ensureRec(t);
      if (rec && t.status === 'exited') applyExited(rec);
    }
    if (!activeId || !recs.has(activeId)) pickActive(list);
    scheduleRender();
  }

  function pickActive(list) {
    const terms = list || sortedTerminals();
    const stored = storageGet(STORE_ACTIVE);
    let next = null;
    if (stored && recs.has(stored)) next = stored;
    if (!next) {
      const running = terms.filter((t) => t.status === 'running' && recs.has(t.id));
      const pool = running.length ? running : terms.filter((t) => recs.has(t.id));
      next = pool.length ? pool[pool.length - 1].id : null;
    }
    if (next) activate(next, { remember: false });
    else activeId = null;
  }

  // ------------------------------------------------------------------ keyboard inside xterm

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).catch(() => {
        cb.toast('Copie impossible : le navigateur a refusé l\'accès au presse-papiers.', 'warn');
      });
    }
  }

  /**
   * Windows Terminal conventions: Ctrl+C copies when text is selected (otherwise it interrupts),
   * Ctrl+Shift+C / Ctrl+Insert copy, Ctrl+V / Ctrl+Shift+V / Shift+Insert paste. Returning false
   * tells xterm to leave the key alone so the browser performs the native copy / paste, which xterm
   * itself forwards (bracketed paste included).
   */
  function onTermKey(rec, e) {
    if (e.type !== 'keydown') return true;
    const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
    const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (ctrl && (key === 'c' || key === 'insert')) {
      const selection = rec.term.hasSelection() ? rec.term.getSelection() : '';
      if (selection) {
        const api = !!(navigator.clipboard && typeof navigator.clipboard.writeText === 'function');
        if (api) {
          e.preventDefault();
          copyText(selection);
        }
        // Without the async clipboard API the native copy event runs and xterm fills the clipboard.
        setTimeout(() => {
          if (!rec.disposed) rec.term.clearSelection();
        }, 0);
        return false;
      }
      if (e.shiftKey || key === 'insert') {
        e.preventDefault();
        return false;
      }
      return true;
    }
    if (ctrl && key === 'v') return false;
    if (e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && key === 'insert') return false;
    return true;
  }

  // ------------------------------------------------------------------ WebSocket

  function wsUrl(id) {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + window.location.host + '/api/terminals/' + encodeURIComponent(id)
      + '/socket?token=' + encodeURIComponent(cb.token);
  }

  function connect(rec) {
    if (rec.disposed || dead || !support.supported || !cb.token || rec.ws) return;
    clearTimeout(rec.retryTimer);
    rec.retryTimer = 0;
    let ws;
    try {
      ws = new WebSocket(wsUrl(rec.id));
    } catch (err) {
      console.warn('[PixelQG] Connexion au terminal ' + rec.id + ' impossible.', err);
      rec.wsState = 'offline';
      scheduleRetry(rec);
      scheduleRender();
      return;
    }
    rec.ws = ws;
    rec.wsState = 'connecting';
    scheduleRender();
    ws.addEventListener('open', () => {
      if (rec.ws !== ws) return;
      rec.wsState = 'open';
      rec.sentCols = 0;
      rec.sentRows = 0;
      sendResize(rec);
      scheduleRender();
    });
    ws.addEventListener('message', (ev) => {
      if (rec.ws === ws) onMessage(rec, ev.data);
    });
    ws.addEventListener('close', () => {
      if (rec.ws !== ws) return;
      rec.ws = null;
      rec.wsState = 'offline';
      if (!rec.disposed) afterClose(rec);
      scheduleRender();
    });
    // 'error' is always followed by 'close', which handles the retry.
  }

  function afterClose(rec) {
    const t = terminalOf(rec.id);
    if (!t || dead || !support.supported) {
      rec.wsState = 'closed';
      return;
    }
    if (isExited(rec, t)) {
      // An exited terminal sends nothing new: only retry until its replay has been received once.
      if (rec.replayed || rec.exitTries >= EXITED_RETRIES) {
        rec.wsState = 'closed';
        return;
      }
      rec.exitTries += 1;
    }
    scheduleRetry(rec);
  }

  function scheduleRetry(rec) {
    clearTimeout(rec.retryTimer);
    const delay = Math.min(BACKOFF_MAX, BACKOFF_BASE * Math.pow(2, Math.min(rec.attempt, 5)))
      + Math.floor(Math.random() * 300);
    rec.attempt += 1;
    rec.retryAt = Date.now() + delay;
    rec.retryTimer = setTimeout(() => {
      rec.retryTimer = 0;
      connect(rec);
    }, delay);
  }

  function onMessage(rec, raw) {
    if (typeof raw !== 'string') return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'replay') {
      rec.attempt = 0;
      rec.replayed = true;
      rec.exitShown = false;
      // The replay may contain old terminal queries (cursor position, colours…): xterm would answer
      // them again, so its answers are dropped until the replay has been processed.
      rec.replaying = true;
      rec.term.reset();
      if (isExited(rec, terminalOf(rec.id))) applyExited(rec);
      const data = typeof msg.data === 'string' ? msg.data : '';
      rec.term.write(data, () => {
        rec.replaying = false;
      });
      scheduleRender();
    } else if (msg.type === 'output') {
      if (typeof msg.data === 'string' && msg.data) rec.term.write(msg.data);
    } else if (msg.type === 'exit') {
      const code = Number(msg.code);
      rec.exitSeen = true;
      rec.exitCode = msg.code !== null && msg.code !== undefined && Number.isFinite(code) ? code : null;
      if (!rec.exitShown) {
        rec.exitShown = true;
        const suffix = rec.exitCode === null ? '' : ' (code ' + rec.exitCode + ')';
        rec.term.write('\r\n\x1b[0m\x1b[2m[Terminal arrêté' + suffix + ']\x1b[0m\r\n\x1b[?25l');
      }
      applyExited(rec);
      scheduleRender();
    }
  }

  function sendJson(rec, payload) {
    if (!rec.ws || rec.wsState !== 'open') return false;
    try {
      rec.ws.send(JSON.stringify(payload));
      return true;
    } catch (_) {
      return false;
    }
  }

  function sendInput(rec, data) {
    if (!data || rec.replaying || rec.disposed) return;
    if (isExited(rec, terminalOf(rec.id))) return;
    if (!rec.ws || rec.wsState !== 'open') return;
    for (const part of chunks(data, INPUT_CHUNK)) {
      if (!sendJson(rec, { type: 'input', data: part })) break;
    }
  }

  function queueResizeSend(rec) {
    clearTimeout(rec.resizeTimer);
    rec.resizeTimer = setTimeout(() => {
      rec.resizeTimer = 0;
      sendResize(rec);
    }, RESIZE_DELAY);
  }

  function sendResize(rec) {
    if (!rec.fitted || rec.disposed || isExited(rec, terminalOf(rec.id))) return;
    const cols = rec.term.cols;
    const rows = rec.term.rows;
    if (cols === rec.sentCols && rows === rec.sentRows) return;
    if (sendJson(rec, { type: 'resize', cols, rows })) {
      rec.sentCols = cols;
      rec.sentRows = rows;
    }
  }

  // ------------------------------------------------------------------ open / fit / focus

  function ensureOpened(rec) {
    if (!rec || rec.disposed) return false;
    if (rec.opened) return true;
    if (!fontsReady || !visible || !rec.host.isConnected) return false;
    if (rec.host.clientWidth === 0 || rec.host.clientHeight === 0) return false;
    try {
      rec.term.open(rec.host);
    } catch (err) {
      console.error('[PixelQG] Affichage du terminal ' + rec.id + ' impossible.', err);
      return false;
    }
    rec.opened = true;
    attachCanvasRenderer(rec);
    fitRec(rec);
    if (rec.pendingFocus) {
      rec.pendingFocus = false;
      focusRec(rec);
    }
    return true;
  }

  /**
   * The canvas renderer draws box-drawing and block characters itself (xterm `customGlyphs`), so the
   * frames of Claude Code's interface join up perfectly; the web font (Google Fonts subsets) has no
   * such glyphs and the DOM renderer would borrow narrower ones from a fallback font. Without the
   * addon, or if it fails, xterm keeps its DOM renderer.
   */
  function attachCanvasRenderer(rec) {
    const addon = window.CanvasAddon;
    if (!addon || typeof addon.CanvasAddon !== 'function') return;
    try {
      rec.term.loadAddon(new addon.CanvasAddon());
    } catch (err) {
      console.warn('[PixelQG] Rendu canvas indisponible pour le terminal ' + rec.id + ', rendu DOM utilisé.', err);
    }
  }

  function openActive() {
    const rec = activeId ? recs.get(activeId) : null;
    if (rec) ensureOpened(rec);
    // Retried after layout settles (the panel may have just been made visible).
    scheduleFit();
  }

  /** Fits the xterm grid to its host (clamped to what the PTY bridge accepts). */
  function fitRec(rec) {
    if (!rec || !rec.opened || rec.disposed) return;
    if (rec.host.clientWidth < 40 || rec.host.clientHeight < 30) return;
    let dims = null;
    try {
      dims = rec.fit.proposeDimensions();
    } catch (_) {
      dims = null;
    }
    if (!dims || !(dims.cols > 0) || !(dims.rows > 0)) return;
    const cols = clamp(dims.cols, MIN_COLS, MAX_COLS);
    const rows = clamp(dims.rows, MIN_ROWS, MAX_ROWS);
    if (cols !== rec.term.cols || rows !== rec.term.rows) {
      try {
        rec.term.resize(cols, rows);
      } catch (_) {
        return;
      }
    }
    const first = !rec.fitted;
    rec.fitted = true;
    if (first) sendResize(rec);
  }

  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      fitTimer = 0;
      const rec = activeId ? recs.get(activeId) : null;
      if (!rec) return;
      if (!rec.opened) ensureOpened(rec);
      else fitRec(rec);
    }, FIT_DELAY);
  }

  function focusRec(rec) {
    if (!rec || rec.disposed) return;
    if (!rec.opened && !ensureOpened(rec)) {
      rec.pendingFocus = true;
      return;
    }
    try {
      rec.term.focus();
    } catch (_) {
      /* focus is best effort */
    }
  }

  // ------------------------------------------------------------------ activation

  /** Shows terminal `id` in the panel. opts: { focus?: boolean, remember?: boolean }. */
  function activate(id, opts) {
    const o = opts || {};
    const rec = typeof id === 'string' ? recs.get(id) : null;
    if (!rec) return false;
    if (activeId !== id) {
      activeId = id;
      headSig = '';
      if (o.remember !== false) storageSet(STORE_ACTIVE, id);
    }
    for (const r of recs.values()) r.host.classList.toggle('is-active', r.id === id);
    renderNow();
    if (!ensureOpened(rec) || rec.fitted) scheduleFit();
    if (o.focus) focusRec(rec);
    return true;
  }

  function onTabKey(e, id) {
    const order = sortedTerminals().map((t) => t.id).filter((x) => recs.has(x));
    const idx = order.indexOf(id);
    let next = null;
    if (e.key === 'ArrowRight') next = order[(idx + 1) % order.length];
    else if (e.key === 'ArrowLeft') next = order[(idx - 1 + order.length) % order.length];
    else if (e.key === 'Home') next = order[0];
    else if (e.key === 'End') next = order[order.length - 1];
    else if (e.key === 'Delete') {
      e.preventDefault();
      requestClose(id);
      return;
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      focusRec(recs.get(id));
      return;
    }
    if (next) {
      e.preventDefault();
      activate(next);
      const rec = recs.get(next);
      if (rec && rec.tab) rec.tab.btn.focus();
    }
  }

  // ------------------------------------------------------------------ close (two-step confirm)

  function busy(btn, fn) {
    if (!btn || btn.getAttribute('aria-busy') === 'true') return Promise.resolve(false);
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-disabled', 'true');
    let p;
    try {
      p = Promise.resolve(fn());
    } catch (err) {
      p = Promise.reject(err);
    }
    return p.catch((err) => {
      cb.toast(err && err.message ? err.message : 'Une erreur inconnue est survenue.', 'err');
      return false;
    }).finally(() => {
      btn.removeAttribute('aria-busy');
      btn.removeAttribute('aria-disabled');
    });
  }

  function requestClose(id) {
    const t = terminalOf(id);
    if (!t) {
      terminalRemoved(id);
      return;
    }
    if (t.status !== 'running') {
      closeConfirm(false);
      const rec = recs.get(id);
      busy(rec && rec.tab ? rec.tab.close : els.dismiss, () => cb.onClose(id));
      return;
    }
    openConfirm(id);
  }

  function openConfirm(id) {
    const t = terminalOf(id);
    if (!t) return;
    confirmId = id;
    const name = str(t.title) || 'ce terminal';
    const alive = linkedAgents(t).filter((a) => ALIVE.has(a.status));
    let q = 'Fermer « ' + name + ' » ? Le shell sera arrêté';
    if (alive.length === 1) q += ', ainsi que la session Claude Code ' + ofName(str(alive[0].name) || 'ton agent');
    else if (alive.length > 1) q += ', ainsi que ses ' + alive.length + ' sessions Claude Code';
    setText(els.confirmQ, q + '.');
    setHidden(els.confirm, false);
    try {
      els.confirmNo.focus({ preventScroll: true });
    } catch (_) {
      els.confirmNo.focus();
    }
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => closeConfirm(false), CONFIRM_TIMEOUT);
  }

  function closeConfirm(restoreFocus) {
    clearTimeout(confirmTimer);
    const wasOpen = !els.confirm.hidden;
    const hadFocus = els.confirm.contains(document.activeElement);
    const id = confirmId;
    confirmId = null;
    setHidden(els.confirm, true);
    if (wasOpen && (restoreFocus || hadFocus)) {
      const rec = id ? recs.get(id) : null;
      if (rec && rec.tab) rec.tab.btn.focus();
      else focusRec(recs.get(activeId));
    }
    return wasOpen;
  }

  // ------------------------------------------------------------------ rendering

  function dotState(rec, t) {
    if (isExited(rec, t)) return 'exited';
    if (rec.wsState === 'open') return 'live';
    if (rec.wsState === 'connecting' || rec.wsState === 'idle') return 'connecting';
    return 'offline';
  }

  function stateText(rec, t) {
    if (isExited(rec, t)) {
      const code = t && t.exitCode !== null && t.exitCode !== undefined ? t.exitCode : rec.exitCode;
      return code === null || code === undefined ? 'arrêté' : 'arrêté (code ' + code + ')';
    }
    if (rec.wsState === 'open') return 'en cours';
    if (rec.wsState === 'connecting' || rec.wsState === 'idle') return rec.attempt > 0 ? 'reconnexion…' : 'connexion…';
    return 'hors ligne';
  }

  function createTab(rec) {
    const tabId = 'term-tab-' + domId(rec.id);
    const dot = h('span', { class: 'term-dot', 'aria-hidden': 'true' });
    const title = h('span', { class: 'term-tab-title' });
    const avatars = h('span', { class: 'term-avatars', 'aria-hidden': 'true', hidden: true });
    const btn = h('button', {
      type: 'button', class: 'term-tab-main', role: 'tab', id: tabId,
      'aria-controls': rec.host.id, 'aria-selected': 'false', tabindex: '-1'
    }, [dot, title, avatars]);
    const close = h('button', { type: 'button', class: 'term-tab-close' }, '×');
    const wrap = h('div', { class: 'term-tab', role: 'presentation' }, [btn, close]);
    btn.addEventListener('click', () => activate(rec.id, { focus: true }));
    btn.addEventListener('keydown', (e) => onTabKey(e, rec.id));
    btn.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        requestClose(rec.id);
      }
    });
    close.addEventListener('click', () => requestClose(rec.id));
    rec.host.setAttribute('aria-labelledby', tabId);
    return { wrap, btn, dot, title, avatars, close, sig: '' };
  }

  function updateTab(rec, t) {
    const tab = rec.tab;
    const active = rec.id === activeId;
    tab.wrap.classList.toggle('is-active', active);
    setAttr(tab.btn, 'aria-selected', active ? 'true' : 'false');
    setAttr(tab.btn, 'tabindex', active ? '0' : '-1');
    const name = str(t.title) || 'Terminal';
    setText(tab.title, name);
    const state = dotState(rec, t);
    if (tab.dot.dataset.state !== state) tab.dot.dataset.state = state;

    const linked = linkedAgents(t);
    const shown = linked.slice(-AVATARS_MAX);
    const sig = shown.map((a) => a.id + ':' + safeColor(a.color) + ':' + str(a.status)).join('|') + '#' + linked.length;
    if (sig !== tab.sig) {
      tab.sig = sig;
      const nodes = shown.map((a) => {
        const c = h('canvas', { 'aria-hidden': 'true' });
        cb.drawAvatar(c, safeColor(a.color), { size: 16, status: str(a.status) || 'working', frame: 0 });
        return c;
      });
      if (linked.length > shown.length) nodes.push(h('span', { class: 'term-avatars-more' }, '+' + (linked.length - shown.length)));
      tab.avatars.replaceChildren(...nodes);
      setHidden(tab.avatars, nodes.length === 0);
    }

    const st = stateText(rec, t);
    const names = linked.map((a) => str(a.name) || a.id);
    let label = name + ', ' + st;
    if (names.length === 1) label += ', session liée : ' + names[0];
    else if (names.length > 1) label += ', ' + names.length + ' sessions liées : ' + names.join(', ');
    setAttr(tab.btn, 'aria-label', label);
    setAttr(tab.btn, 'title', [name + ' · ' + st, str(t.cwd), rec.oscTitle, names.length ? 'Sessions : ' + names.join(', ') : '']
      .filter(Boolean).join('\n'));
    setAttr(tab.close, 'aria-label', 'Fermer ' + name);
    setAttr(tab.close, 'title', 'Fermer ' + name);
  }

  function renderTabs() {
    const list = sortedTerminals();
    let prev = null;
    for (const t of list) {
      const rec = recs.get(t.id);
      if (!rec) continue;
      if (!rec.tab) rec.tab = createTab(rec);
      updateTab(rec, t);
      const expected = prev ? prev.nextSibling : els.tabs.firstChild;
      if (rec.tab.wrap !== expected) els.tabs.insertBefore(rec.tab.wrap, expected);
      prev = rec.tab.wrap;
    }
  }

  function renderHead() {
    const t = terminalOf(activeId);
    const rec = activeId ? recs.get(activeId) : null;
    if (!t || !rec) {
      setHidden(els.head, true);
      setHidden(els.ended, true);
      return;
    }
    setHidden(els.head, false);
    const cwd = str(t.cwd);
    setText(els.cwd, cwd);
    setAttr(els.cwd, 'title', cwd || null);

    let state = '';
    let kind = '';
    const exited = isExited(rec, t);
    if (!exited) {
      if (rec.wsState === 'connecting' || rec.wsState === 'idle') state = rec.attempt > 0 ? 'Reconnexion…' : 'Connexion…';
      else if (rec.wsState === 'offline') {
        const secs = Math.max(1, Math.round((rec.retryAt - Date.now()) / 1000));
        state = rec.retryTimer ? 'Hors ligne · nouvel essai dans ' + secs + ' s' : 'Hors ligne';
        kind = 'err';
      }
    }
    setText(els.state, state);
    setHidden(els.state, !state);
    if (els.state.dataset.kind !== kind) els.state.dataset.kind = kind;

    const linked = linkedAgents(t).slice(-LINKS_MAX);
    const sig = t.id + (exited ? '|x' : '|r') + '\u0003'
      + linked.map((a) => [a.id, a.name, a.color, a.status, a.interactive ? 1 : 0].join('\u0001')).join('\u0002');
    if (sig !== headSig) {
      headSig = sig;
      if (!linked.length) {
        els.links.replaceChildren(h('span', { class: 'term-links-hint' },
          exited ? 'Aucune session Claude Code n\'a été lancée ici.' : 'Tape claude ici : la session apparaîtra au bureau.'));
      } else {
        els.links.replaceChildren(...linked.map((a) => {
          const name = str(a.name) || a.id;
          const color = safeColor(a.color);
          const status = str(a.status) || 'working';
          const short = statusShort(a);
          const avatar = h('canvas', { 'aria-hidden': 'true' });
          cb.drawAvatar(avatar, color, { size: 18, status, frame: 0 });
          const btn = h('button', { type: 'button', class: 'term-agent', title: 'Afficher la fiche de ' + name + ' (' + short + ')' }, [
            avatar,
            h('span', { class: 'term-agent-name' }, name),
            h('span', { class: 'term-agent-state' }, short)
          ]);
          btn.style.setProperty('--agent', color);
          btn.dataset.status = status;
          btn.dataset.asks = status === 'waiting' && a.interactive ? 'true' : 'false';
          btn.addEventListener('click', () => cb.onSelectAgent(a.id));
          return btn;
        }));
      }
    }

    setHidden(els.ended, !exited);
    if (exited) {
      const code = t.exitCode !== null && t.exitCode !== undefined ? t.exitCode : rec.exitCode;
      setText(els.endedText, code === null || code === undefined
        ? 'Ce terminal est arrêté.'
        : 'Ce terminal est arrêté (code ' + code + ').');
    }
  }

  function renderNow() {
    renderQueued = false;
    if (!initialized) return;
    renderTabs();
    renderHead();
    setHidden(els.empty, recs.size > 0 || !support.supported);
    if (confirmId && !recs.has(confirmId)) closeConfirm(false);
  }

  function scheduleRender() {
    if (renderQueued || !initialized) return;
    renderQueued = true;
    const run = () => {
      if (renderQueued) renderNow();
    };
    if (document.hidden) setTimeout(run, 250);
    else requestAnimationFrame(run);
  }

  // ------------------------------------------------------------------ store notifications (main.js)

  function terminalChanged(t) {
    if (!initialized || !validTerminal(t)) return;
    if (!support.supported) {
      scheduleRender();
      return;
    }
    const rec = ensureRec(t);
    if (!rec) return;
    if (t.status === 'exited') {
      applyExited(rec);
      // The socket may be down (server restart): one more connection fetches the final replay.
      if (!rec.ws && !rec.replayed && !rec.retryTimer && rec.wsState !== 'closed') connect(rec);
    }
    if (!activeId || !recs.has(activeId)) activate(t.id, { remember: false });
    scheduleRender();
  }

  function terminalRemoved(id) {
    if (!initialized) return;
    const wasActive = activeId === id;
    // Tab order before the removal (the store may already have dropped `id`).
    const order = Array.from(els.tabs.children)
      .map((node) => {
        for (const r of recs.values()) if (r.tab && r.tab.wrap === node) return r.id;
        return null;
      })
      .filter(Boolean);
    const idx = order.indexOf(id);
    disposeRec(id);
    if (confirmId === id) closeConfirm(false);
    if (wasActive) {
      activeId = null;
      headSig = '';
      const rest = order.filter((x) => x !== id && recs.has(x));
      const next = rest.length ? rest[Math.min(Math.max(0, idx), rest.length - 1)] : null;
      if (next) activate(next);
    }
    scheduleRender();
  }

  function terminalsReset() {
    sync();
    scheduleRender();
  }

  function agentsChanged() {
    scheduleRender();
  }

  // ------------------------------------------------------------------ host integration

  /** ui.js reports whether the « Terminal » panel is on screen (tab selected, dock expanded). */
  function setVisible(on) {
    const next = !!on;
    if (next === visible) return;
    visible = next;
    if (visible) {
      openActive();
      scheduleRender();
    }
  }

  /** True when terminal `id` is the one on screen right now. */
  function isShowing(id) {
    return visible && !document.hidden && activeId === id && recs.has(id);
  }

  /** True for events coming from inside a terminal (keys there belong to the shell, not the app). */
  function owns(target) {
    return !!(target && els.viewport && target instanceof Node && els.viewport.contains(target));
  }

  function handleEscape() {
    if (!els.confirm.hidden) {
      closeConfirm(true);
      return true;
    }
    return false;
  }

  function focusActive() {
    focusRec(activeId ? recs.get(activeId) : null);
  }

  /** The page lost its authorisation (server restarted): stop every socket for good. */
  function shutdown() {
    dead = true;
    for (const rec of recs.values()) {
      clearTimeout(rec.retryTimer);
      rec.retryTimer = 0;
      if (rec.ws) {
        const ws = rec.ws;
        rec.ws = null;
        try {
          ws.close(1000);
        } catch (_) {
          /* already closing */
        }
      }
      rec.wsState = 'closed';
    }
    scheduleRender();
  }

  /** The network is back: retry every waiting socket right away. */
  function reconnectNow() {
    if (dead) return;
    for (const rec of recs.values()) {
      if (!rec.ws && rec.retryTimer) {
        clearTimeout(rec.retryTimer);
        rec.retryTimer = 0;
        rec.attempt = 0;
        connect(rec);
      }
    }
  }

  function collectElements() {
    const byId = (id) => {
      const node = document.getElementById(id);
      if (!node) {
        console.warn('[HQTerminal] élément #' + id + ' introuvable dans la page.');
        return document.createElement('div');
      }
      return node;
    };
    els = {
      tabs: byId('term-tabs'),
      viewport: byId('term-viewport'),
      head: byId('term-head'),
      cwd: byId('term-cwd'),
      state: byId('term-state'),
      links: byId('term-links'),
      ended: byId('term-ended'),
      endedText: byId('term-ended-text'),
      reopen: byId('term-reopen'),
      dismiss: byId('term-dismiss'),
      empty: byId('term-empty'),
      confirm: byId('term-confirm'),
      confirmQ: byId('term-confirm-q'),
      confirmYes: byId('term-confirm-yes'),
      confirmNo: byId('term-confirm-no')
    };
  }

  function bind() {
    els.confirmNo.addEventListener('click', () => closeConfirm(true));
    els.confirmYes.addEventListener('click', () => {
      const id = confirmId;
      if (!id) return;
      clearTimeout(confirmTimer);
      busy(els.confirmYes, () => cb.onClose(id)).then((ok) => {
        if (confirmId === id) closeConfirm(ok === false);
      });
    });
    els.confirm.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeConfirm(true);
      }
    });
    els.dismiss.addEventListener('click', () => {
      if (activeId) busy(els.dismiss, () => cb.onClose(activeId));
    });
    els.reopen.addEventListener('click', () => {
      const t = terminalOf(activeId);
      if (!t) return;
      const payload = {};
      if (t.cwd) payload.cwd = str(t.cwd);
      if (t.name) payload.name = str(t.name);
      if (t.color && HEX_RE.test(t.color)) payload.color = t.color;
      busy(els.reopen, () => cb.onReopen(payload));
    });
    if (typeof window.ResizeObserver === 'function') {
      const ro = new window.ResizeObserver(() => scheduleFit());
      ro.observe(els.viewport);
    } else {
      window.addEventListener('resize', scheduleFit);
    }
    // Keep the offline countdown in the head strip fresh.
    setInterval(() => {
      const rec = activeId ? recs.get(activeId) : null;
      if (rec && rec.wsState === 'offline' && rec.retryTimer && visible) renderHead();
    }, 1000);
  }

  function init(options) {
    if (initialized) return;
    const o = options || {};
    for (const key of Object.keys(cb)) {
      if (key === 'token') {
        if (typeof o.token === 'string') cb.token = o.token;
      } else if (typeof o[key] === 'function') {
        cb[key] = o[key];
      }
    }
    collectElements();
    bind();
    prepareFonts();
    initialized = true;
    renderNow();
  }

  window.HQTerminal = {
    init,
    computeSupport,
    setConfig,
    terminalChanged,
    terminalRemoved,
    terminalsReset,
    agentsChanged,
    activate,
    focusActive,
    setVisible,
    isShowing,
    owns,
    handleEscape,
    shutdown,
    reconnectNow,
    activeId: () => activeId
  };
})();
