/*
 * PixelQG — boot, API client, SSE stream, agent store, achievements and wiring.
 *
 * main.js owns the single source of client truth (Maps of Agent and Terminal objects mirrored
 * from the server), talks to the local HTTP API with the per-launch token, keeps the SSE stream
 * alive with exponential backoff, and fans every change out to the game (window.HQGame), the HUD
 * (window.HQUI) and the integrated terminal (window.HQTerminal). It also accumulates the player
 * statistics (docs/GAME2.md §2) and unlocks the achievements of window.HQProgression.
 * Every HQGame / HQTerminal / HQProgression call is guarded: the page keeps working if the office,
 * the terminal or the progression module fails.
 */
(function () {
  'use strict';

  const ui = window.HQUI;
  if (!ui || typeof ui.init !== 'function') {
    console.error('[PixelQG] ui.js n\'est pas chargé : interface indisponible.');
    return;
  }

  // ------------------------------------------------------------------ constants

  const PLACEHOLDER = '__HQ_' + 'TOKEN__';
  const TOKEN = typeof window.HQ_TOKEN === 'string' ? window.HQ_TOKEN.trim() : '';
  const TOKEN_OK = TOKEN.length > 0 && TOKEN !== PLACEHOLDER;

  const LOG_CAP = 500;
  const REQUEST_TIMEOUT = 20000;
  const BACKOFF_BASE = 1000;
  const BACKOFF_MAX = 30000;
  const DEMO_COUNT = 4;
  const RUNNING = new Set(['starting', 'working']);
  const BASE_TITLE = 'PixelQG';

  // ------------------------------------------------------------------ state

  const store = new Map();        // id → Agent (latest full object from the server)
  const terminals = new Map();    // id → Terminal (integrated terminals, docs/TERMINAL.md)
  const logCache = new Map();     // id → LogEntry[] (last LOG_CAP, fed by SSE and by GET …/logs)
  let config = null;
  let termSupport = { supported: false, ready: false, reason: '' };
  let terminalsFetch = 0;         // increments per GET /api/terminals, to drop stale responses
  let selectedId = null;

  let source = null;              // current EventSource
  let reconnectTimer = 0;
  let attempt = 0;
  let sessionDead = false;        // token rejected: the server restarted with a new token
  let logRequest = 0;             // increments per logs fetch, to drop stale responses
  let statsQueued = false;
  let inGameSelect = false;       // guards HQGame.select → onSelect re-entrancy

  // ------------------------------------------------------------------ helpers

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  function enc(id) {
    return encodeURIComponent(String(id));
  }

  function validAgent(a) {
    return !!a && typeof a === 'object' && typeof a.id === 'string' && a.id.length > 0;
  }

  function validEntry(e) {
    return !!e && typeof e === 'object' && typeof e.type === 'string';
  }

  function nameOf(id) {
    const a = store.get(id);
    return a && a.name ? String(a.name) : 'l\'agent';
  }

  function truncate(s, max) {
    const t = String(s == null ? '' : s);
    return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t;
  }

  function parseEvent(ev) {
    try {
      return JSON.parse(ev.data);
    } catch (err) {
      console.warn('[PixelQG] événement SSE illisible ignoré.', err);
      return null;
    }
  }

  /** Calls window.HQGame[method] if it exists; never throws. */
  function gameCall(method, ...args) {
    const game = window.HQGame;
    if (!game || typeof game[method] !== 'function') return undefined;
    try {
      return game[method](...args);
    } catch (err) {
      console.error('[PixelQG] HQGame.' + method + ' a échoué.', err);
      return undefined;
    }
  }

  function gameSelect(id) {
    if (inGameSelect) return;
    inGameSelect = true;
    try {
      gameCall('select', id);
    } finally {
      inGameSelect = false;
    }
  }

  /** Calls window.HQTerminal[method] if it exists; never throws. */
  function termCall(method, ...args) {
    const term = window.HQTerminal;
    if (!term || typeof term[method] !== 'function') return undefined;
    try {
      return term[method](...args);
    } catch (err) {
      console.error('[PixelQG] HQTerminal.' + method + ' a échoué.', err);
      return undefined;
    }
  }

  function validTerminal(t) {
    return !!t && typeof t === 'object' && typeof t.id === 'string' && t.id.length > 0;
  }

  function terminalTitle(id) {
    const t = id ? terminals.get(id) : null;
    return t && t.title ? String(t.title) : 'son terminal';
  }

  // ------------------------------------------------------------------ API client

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  }

  function statusMessage(status) {
    switch (status) {
      case 0: return 'Serveur injoignable : PixelQG est-il toujours lancé ?';
      case 400: return 'Requête invalide.';
      case 401: return 'Accès refusé : recharge la page (le serveur a peut-être redémarré).';
      case 403: return 'Requête refusée par le serveur.';
      case 404: return 'Introuvable : cet agent n\'existe plus.';
      case 409: return 'Action impossible pour l\'instant : l\'agent est occupé.';
      case 413: return 'Contenu trop volumineux (1 Mo maximum).';
      case 415: return 'Format de requête non accepté.';
      case 501: return 'Fonction indisponible sur ce serveur PixelQG.';
      default:
        if (status >= 500) return 'Erreur interne du serveur (' + status + ').';
        return 'Erreur inattendue (' + status + ').';
    }
  }

  async function api(method, path, body) {
    if (!TOKEN_OK) {
      throw new ApiError('Jeton d\'accès manquant : ouvre PixelQG avec start.bat ou « npm start ».', 0);
    }
    const headers = { 'X-HQ-Token': TOKEN, Accept: 'application/json' };
    const init = { method, headers, cache: 'no-store', credentials: 'same-origin' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT) : 0;
    if (ctrl) init.signal = ctrl.signal;
    let res;
    let data = null;
    try {
      try {
        res = await fetch(path, init);
      } catch (err) {
        const aborted = err && err.name === 'AbortError';
        throw new ApiError(aborted ? 'Le serveur ne répond pas (délai dépassé).' : statusMessage(0), 0);
      }
      try {
        data = await res.json();
      } catch (_) {
        data = null;
      }
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) markSessionDead();
    if (!res.ok || !data || data.ok !== true) {
      const msg = data && typeof data.error === 'string' && data.error.trim() ? data.error.trim() : statusMessage(res.status);
      throw new ApiError(msg, res.status);
    }
    return data;
  }

  // ------------------------------------------------------------------ store

  function upsertLocal(agent, opts) {
    if (!validAgent(agent)) return;
    const prev = store.get(agent.id);
    store.set(agent.id, agent);
    trackArrival(agent, !!(opts && opts.snapshot));
    if (prev && !(opts && opts.snapshot)) trackTransition(prev, agent);
    gameCall('upsertAgent', agent);
    ui.agentChanged(agent);
    termCall('agentsChanged');
    if (!(opts && opts.quiet)) {
      if (prev) notifyTransition(prev, agent);
      else notifyArrival(agent);
    }
    scheduleStats();
  }

  function removeLocal(id) {
    if (!store.has(id)) {
      logCache.delete(id);
      return;
    }
    // Subagents leave with their parent.
    for (const a of Array.from(store.values())) {
      if (a.parentId === id && a.id !== id) removeLocal(a.id);
    }
    store.delete(id);
    logCache.delete(id);
    gameCall('removeAgent', id);
    ui.agentRemoved(id);
    termCall('agentsChanged');
    if (selectedId === id) select(null, 'remove');
    scheduleStats();
  }

  // ------------------------------------------------------------------ terminal store

  function upsertTerminal(t, opts) {
    if (!validTerminal(t)) return;
    if (!terminals.has(t.id)) trackTerminal(t.id, !!(opts && opts.snapshot));
    terminals.set(t.id, t);
    termCall('terminalChanged', t);
    ui.terminalsChanged();
  }

  function removeTerminal(id) {
    if (!terminals.has(id)) return;
    terminals.delete(id);
    termCall('terminalRemoved', id);
    ui.terminalsChanged();
  }

  function resetTerminals(list) {
    const next = Array.isArray(list) ? list.filter(validTerminal) : [];
    terminals.clear();
    for (const t of next) {
      trackTerminal(t.id, true);
      terminals.set(t.id, t);
    }
    termCall('terminalsReset');
    ui.terminalsChanged();
  }

  /** Fallback when the snapshot carries no `terminals` (older server or partial support). */
  async function loadTerminals() {
    if (!termSupport.supported) return;
    const req = ++terminalsFetch;
    try {
      const data = await api('GET', '/api/terminals');
      if (req !== terminalsFetch) return;
      resetTerminals(data.terminals);
    } catch (err) {
      if (req !== terminalsFetch) return;
      if (err.status !== 401 && err.status !== 404 && err.status !== 501) {
        ui.toast('Liste des terminaux indisponible : ' + err.message, 'err');
      }
    }
  }

  function applySnapshot(data) {
    if (!data || typeof data !== 'object') return;
    if (data.config) applyConfig(data.config);
    if (validLibrary(data.library)) applyLibrary(data.library, { quiet: true });
    else if (!library) loadLibrary();
    terminalsFetch++;
    if (Array.isArray(data.terminals)) resetTerminals(data.terminals);
    else if (termSupport.supported) loadTerminals();
    else resetTerminals([]);
    const agents = Array.isArray(data.agents) ? data.agents.filter(validAgent) : [];
    const ids = new Set(agents.map((a) => a.id));
    for (const id of Array.from(store.keys())) {
      if (!ids.has(id)) removeLocal(id);
    }
    for (const a of agents) upsertLocal(a, { quiet: true, snapshot: true });
    for (const id of Array.from(logCache.keys())) {
      if (!ids.has(id)) logCache.delete(id);
    }
    ui.agentsReset();
    // Logs may have been missed while disconnected: resync the open feed.
    if (selectedId) {
      if (store.has(selectedId)) loadLogs(selectedId);
      else select(null, 'remove');
    }
  }

  /** True while the user is looking at the terminal an agent runs in. */
  function watchingTerminal(agent) {
    if (!agent || !agent.terminalId || document.hidden) return false;
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
    return termCall('isShowing', agent.terminalId) === true;
  }

  /** A Claude Code session started in an HQ terminal joins the office. */
  function notifyArrival(agent) {
    if (agent.source !== 'terminal' || agent.kind === 'sub' || watchingTerminal(agent)) return;
    const name = agent.name ? String(agent.name) : 'Une session';
    ui.toast(name + ' rejoint le bureau depuis ' + terminalTitle(agent.terminalId) + '.', 'ok');
  }

  /** Interactive sessions: say when one waits for the user or stops on an error. */
  function notifyInteractive(prev, next) {
    const name = next.name ? String(next.name) : 'Ta session';
    // Only after a real turn (working → waiting), not when a fresh session first shows its prompt.
    if (next.status === 'waiting' && next.interactive && prev.status === 'working') {
      if (!watchingTerminal(next)) ui.toast(name + ' t\'attend dans ' + terminalTitle(next.terminalId) + '.', 'info');
    } else if (next.status === 'error' && prev.status !== 'error') {
      const why = next.error ? ' : ' + truncate(next.error, 160) : '.';
      ui.toast(name + ' s\'est arrêté sur une erreur' + why, 'err');
    }
  }

  /** Toasts when an agent the user launched finishes (demo / observed agents stay quiet). */
  function notifyTransition(prev, next) {
    if (next.kind === 'sub' || prev.status === next.status) return;
    if (next.source === 'terminal') {
      notifyInteractive(prev, next);
      return;
    }
    if (next.source !== 'spawned') return;
    const name = next.name ? String(next.name) : 'L\'agent';
    if (next.status === 'done' && RUNNING.has(prev.status)) {
      ui.toast(name + ' a terminé sa mission.', 'ok');
    } else if (next.status === 'error' && prev.status !== 'error') {
      const why = next.error ? ' : ' + truncate(next.error, 160) : '.';
      ui.toast(name + ' s\'est arrêté sur une erreur' + why, 'err');
    }
  }

  // ------------------------------------------------------------------ logs

  function logKey(e) {
    return num(e.t) + '|' + e.type + '|' + (e.tool || '') + '|' + (e.text || '');
  }

  /** Server history first, then live entries that arrived after it (deduplicated). */
  function mergeLogs(fetched, cached) {
    const keys = new Set(fetched.map(logKey));
    const lastT = fetched.length ? num(fetched[fetched.length - 1].t) : 0;
    const extras = cached.filter((e) => !keys.has(logKey(e)) && num(e.t) >= lastT);
    const merged = fetched.concat(extras);
    return merged.length > LOG_CAP ? merged.slice(merged.length - LOG_CAP) : merged;
  }

  function onLog(id, entry) {
    if (typeof id !== 'string' || !validEntry(entry)) return;
    let list = logCache.get(id);
    if (!list) {
      list = [];
      logCache.set(id, list);
    }
    list.push(entry);
    if (list.length > LOG_CAP) list.splice(0, list.length - LOG_CAP);
    gameCall('log', id, entry);
    if (!isDemo(id)) trackLog(entry);
    if (id === selectedId) ui.appendLog(id, entry);
  }

  async function loadLogs(id) {
    const req = ++logRequest;
    try {
      const data = await api('GET', '/api/agents/' + enc(id) + '/logs');
      if (req !== logRequest || selectedId !== id) return;
      const fetched = Array.isArray(data.logs) ? data.logs.filter(validEntry) : [];
      const merged = mergeLogs(fetched, logCache.get(id) || []);
      logCache.set(id, merged);
      ui.setLogs(id, merged);
    } catch (err) {
      if (req !== logRequest || selectedId !== id) return;
      ui.setLogs(id, logCache.get(id) || []);
      if (err.status !== 404 && err.status !== 401) {
        ui.toast('Journal de ' + nameOf(id) + ' indisponible : ' + err.message, 'err');
      }
    }
  }

  // ------------------------------------------------------------------ selection

  function select(id, origin) {
    const next = typeof id === 'string' && store.has(id) ? id : null;
    if (next === selectedId) {
      if (origin !== 'game') gameSelect(next);
      return;
    }
    selectedId = next;
    ui.select(next);
    gameSelect(next);
    if (next) {
      const cached = logCache.get(next) || [];
      ui.setLogs(next, cached, { loading: cached.length === 0 });
      loadLogs(next);
    } else {
      logRequest++;
    }
  }

  // ------------------------------------------------------------------ stats

  function computeStats(now) {
    let active = 0;
    let total = 0;
    let tokens = 0;
    let cost = 0;
    let timeMs = 0;
    let realActive = 0;
    let realTokens = 0;
    for (const a of store.values()) {
      total++;
      if (RUNNING.has(a.status)) active++;
      tokens += num(a.tokens && a.tokens.total);
      if (a.source !== 'demo') {
        if (RUNNING.has(a.status)) realActive++;
        realTokens += num(a.tokens && a.tokens.total);
      }
      if (a.kind !== 'sub') {
        // A root's cost already includes its subagents.
        cost += num(a.costUsd);
        const start = num(a.startedAt);
        if (start > 0) {
          const end = num(a.endedAt) > 0 ? num(a.endedAt) : now;
          timeMs += Math.max(0, end - start);
        }
      }
    }
    return { active, total, tokens, cost, timeMs, realActive, realTokens };
  }

  function updateStats(now) {
    statsQueued = false;
    const stats = computeStats(Number.isFinite(now) ? now : Date.now());
    ui.setStats(stats);
    // Demo agents are pretend work: they never count toward the player's stats and achievements.
    bumpMax('maxConcurrent', stats.realActive);
    bumpMax('totalTokens', stats.realTokens);
    const title = stats.active > 0 ? '(' + stats.active + ') ' + BASE_TITLE : BASE_TITLE;
    if (document.title !== title) document.title = title;
  }

  function scheduleStats() {
    if (statsQueued) return;
    statsQueued = true;
    setTimeout(() => updateStats(Date.now()), 60);
  }

  // ------------------------------------------------------------------ config

  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    config = cfg;
    ui.setConfig(cfg);
    const support = termCall('setConfig', cfg);
    termSupport = support && typeof support === 'object'
      ? support
      : { supported: false, ready: true, reason: 'Le module du terminal intégré n\'a pas pu être chargé. Recharge la page.' };
    ui.setTerminalSupport(termSupport);
    if (cfg.claudeFound === false) {
      ui.showBanner('claude', {
        kind: 'warn',
        title: 'Claude Code introuvable.',
        text: 'Impossible de lancer de vrais agents : installe Claude Code (npm install -g @anthropic-ai/claude-code) '
          + 'ou indique son chemin dans la variable d\'environnement CLAUDE_BIN, puis relance PixelQG. '
          + 'Le mode démo reste disponible.',
        actions: [{ label: 'Essayer le mode démo', primary: true, onClick: () => setDemo(true) }]
      });
    } else {
      ui.hideBanner('claude');
    }
  }

  async function loadConfig() {
    try {
      const data = await api('GET', '/api/config');
      applyConfig(data.config);
    } catch (err) {
      if (err.status !== 401) ui.toast('Configuration indisponible : ' + err.message, 'err');
    }
  }

  // ------------------------------------------------------------------ actions (HUD callbacks)

  /** Launch: resolves with the agent, rejects with a French message shown inline by the HUD. */
  async function launch(payload) {
    const data = await api('POST', '/api/agents', payload);
    const agent = data.agent;
    if (validAgent(agent)) {
      upsertLocal(agent, { quiet: true });
      select(agent.id, 'launch');
      ui.toast('Agent ' + (agent.name || agent.id) + ' lancé.', 'ok');
    } else {
      ui.toast('Agent lancé.', 'ok');
    }
    return agent;
  }

  async function stop(id) {
    const name = nameOf(id);
    try {
      const data = await api('POST', '/api/agents/' + enc(id) + '/stop', {});
      if (validAgent(data.agent)) upsertLocal(data.agent, { quiet: true });
      ui.toast(name + ' a été arrêté.', 'info');
      return true;
    } catch (err) {
      ui.toast('Impossible d\'arrêter ' + name + ' : ' + err.message, 'err');
      return false;
    }
  }

  async function sendMessage(id, prompt) {
    const name = nameOf(id);
    try {
      const data = await api('POST', '/api/agents/' + enc(id) + '/message', { prompt });
      if (validAgent(data.agent)) upsertLocal(data.agent, { quiet: true });
      ui.toast('Nouvelle consigne envoyée à ' + name + '.', 'ok');
      return true;
    } catch (err) {
      ui.toast('Message non envoyé à ' + name + ' : ' + err.message, 'err');
      return false;
    }
  }

  async function removeAgent(id) {
    const name = nameOf(id);
    try {
      await api('DELETE', '/api/agents/' + enc(id));
      removeLocal(id);
      ui.toast(name + ' a quitté le bureau.', 'info');
      return true;
    } catch (err) {
      if (err.status === 404) {
        removeLocal(id);
        return true;
      }
      ui.toast('Impossible de retirer ' + name + ' : ' + err.message, 'err');
      return false;
    }
  }

  async function setDemo(on) {
    try {
      if (on) {
        const data = await api('POST', '/api/demo', { count: DEMO_COUNT });
        const list = Array.isArray(data.agents) ? data.agents.filter(validAgent) : [];
        for (const a of list) upsertLocal(a, { quiet: true });
        const n = list.length || DEMO_COUNT;
        ui.toast('Mode démo : ' + n + (n > 1 ? ' agents simulés arrivent' : ' agent simulé arrive')
          + ' au bureau (aucun token dépensé).', 'ok');
      } else {
        await api('POST', '/api/demo/stop', {});
        for (const a of Array.from(store.values())) {
          if (a.source === 'demo') removeLocal(a.id);
        }
        ui.toast('Mode démo arrêté : les agents simulés quittent le bureau.', 'info');
      }
      return true;
    } catch (err) {
      ui.toast('Mode démo : ' + err.message, 'err');
      return false;
    }
  }

  /** Opens a terminal (optionally running `claude`); rejects with a French message shown in the toolbar. */
  async function createTerminal(payload) {
    if (!termSupport.supported) {
      throw new Error(termSupport.reason || 'Le terminal intégré n\'est pas disponible.');
    }
    const data = await api('POST', '/api/terminals', payload);
    const t = data.terminal;
    if (!validTerminal(t)) throw new Error('Réponse inattendue du serveur : terminal introuvable.');
    upsertTerminal(t);
    ui.openWindow('terminal', { focus: false });
    termCall('activate', t.id, { focus: true });
    return t;
  }

  async function closeTerminal(id) {
    const title = terminalTitle(id);
    try {
      await api('DELETE', '/api/terminals/' + enc(id));
      removeTerminal(id);
      return true;
    } catch (err) {
      if (err.status === 404) {
        removeTerminal(id);
        return true;
      }
      ui.toast('Impossible de fermer ' + title + ' : ' + err.message, 'err');
      return false;
    }
  }

  async function reopenTerminal(payload) {
    try {
      return await createTerminal(payload);
    } catch (err) {
      ui.toast('Nouveau terminal impossible : ' + err.message, 'err');
      return null;
    }
  }

  /** « Voir son terminal »: the Terminal window, that terminal active and focused. */
  function showTerminal(id) {
    if (!terminals.has(id)) {
      ui.toast('Ce terminal a été fermé.', 'info');
      return false;
    }
    ui.openWindow('terminal', { focus: false });
    return termCall('activate', id, { focus: true }) === true;
  }

  /** Game windows opened / closed: the terminal only renders (and fits xterm) while its window is open. */
  function onWindowsChange(state) {
    const s = state || {};
    termCall('setVisible', !!s.terminal);
    if (s.opened === 'terminal') setTimeout(() => termCall('focusActive'), 60);
  }

  async function setObserve(on) {
    const enabled = !!on;
    try {
      const data = await api('POST', '/api/observe', { enabled });
      if (data.config) applyConfig(data.config);
      else if (config) applyConfig(Object.assign({}, config, { observe: enabled }));
      ui.toast(enabled
        ? 'Sessions externes : PixelQG affiche aussi tes sessions Claude Code lancées ailleurs.'
        : 'Sessions externes : observation désactivée.', 'info');
      return true;
    } catch (err) {
      ui.toast('Sessions externes : ' + err.message, 'err');
      return false;
    }
  }

  // ------------------------------------------------------------------ library (linked GitHub repos)

  let library = null;
  const LIB_BUSY = new Set(['cloning', 'updating']);

  function validLibrary(lib) {
    return !!lib && typeof lib === 'object' && Array.isArray(lib.repos);
  }

  function libRepoName(r) {
    return r && r.owner && r.repo ? String(r.owner) + '/' + String(r.repo) : String((r && r.id) || 'Ce dépôt');
  }

  function libCounts(r) {
    const c = (r && r.counts) || {};
    const parts = [];
    const add = (n, one, many) => {
      const v = Math.max(0, Math.round(num(n)));
      if (v) parts.push(v + ' ' + (v > 1 ? many : one));
    };
    add(c.skills, 'skill', 'skills');
    add(c.agents, 'agent', 'agents');
    add(c.commands, 'commande', 'commandes');
    return parts.join(' · ');
  }

  /** New Library object: HUD + office shelves, plus a toast when a clone / update finishes. */
  function applyLibrary(lib, opts) {
    if (!validLibrary(lib)) return;
    const prev = new Map();
    if (library && !(opts && opts.quiet)) {
      for (const r of library.repos) if (r && r.id) prev.set(r.id, r.status);
    }
    library = lib;
    ui.setLibrary(lib);
    gameCall('setLibrary', lib);
    bumpMax('reposLinked', lib.repos.filter((r) => r && r.status === 'ready').length);
    for (const r of lib.repos) {
      if (!r || !r.id || !LIB_BUSY.has(prev.get(r.id))) continue;
      if (r.status === 'ready') {
        const counts = libCounts(r);
        ui.toast('Bibliothèque : ' + libRepoName(r) + ' est prêt' + (counts ? ' (' + counts + ').' : '.'), 'ok');
      } else if (r.status === 'error') {
        ui.toast('Bibliothèque : ' + libRepoName(r) + ' : ' + (r.error ? String(r.error) : 'échec.'), 'err');
      }
    }
  }

  let libraryLoading = false;
  async function loadLibrary() {
    if (libraryLoading) return;
    libraryLoading = true;
    try {
      const data = await api('GET', '/api/library');
      applyLibrary(data.library, { quiet: true });
    } catch (err) {
      if (err.status === 401) return;
      ui.setLibrary(null, {
        unavailable: err.status === 404 || err.status === 501
          ? 'Ce serveur PixelQG ne propose pas encore la bibliothèque : mets PixelQG à jour puis relance-le.'
          : 'Bibliothèque injoignable : ' + err.message
      });
    } finally {
      libraryLoading = false;
    }
  }

  /** Applies a repo returned by the API right away (the SSE « library » event follows with the full object). */
  function mergeRepo(repo) {
    if (!library || !repo || typeof repo.id !== 'string') return;
    const repos = library.repos.slice();
    const i = repos.findIndex((r) => r && r.id === repo.id);
    if (i >= 0) repos[i] = repo;
    else repos.push(repo);
    applyLibrary(Object.assign({}, library, { repos }), { quiet: true });
  }

  function dropRepo(id) {
    if (!library) return;
    applyLibrary(Object.assign({}, library, { repos: library.repos.filter((r) => r && r.id !== id) }), { quiet: true });
  }

  async function linkRepo(url) {
    const data = await api('POST', '/api/library/repos', { url });
    mergeRepo(data.repo);
    ui.toast('Bibliothèque : clonage de ' + libRepoName(data.repo) + '…', 'info');
    return data.repo;
  }

  async function updateRepo(id) {
    const data = await api('POST', '/api/library/repos/' + enc(id) + '/update', {});
    mergeRepo(data.repo);
    return true;
  }

  async function toggleRepo(id, body) {
    const data = await api('POST', '/api/library/repos/' + enc(id) + '/toggle', body);
    mergeRepo(data.repo);
    return true;
  }

  async function removeRepo(id) {
    const name = library ? libRepoName(library.repos.find((r) => r && r.id === id)) : 'Ce dépôt';
    try {
      await api('DELETE', '/api/library/repos/' + enc(id));
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    dropRepo(id);
    ui.toast('Bibliothèque : ' + name + ' a été retiré.', 'info');
    return true;
  }

  // ------------------------------------------------------------------ progression: player stats + achievements
  // Counters follow docs/GAME2.md §2 (stats object handed to HQProgression.ACHIEVEMENTS[].test). They only grow
  // from LIVE events (SSE agents / logs / tokens, terminals opened from this page); agents that were already in
  // the office when the page loaded were counted by an earlier page. Demo agents never count (pretend work).

  const STATS_KEY = 'pixelqg-app:stats';
  const ACH_KEY = 'pixelqg-app:achievements';
  const TEST_RE = /test|jest|vitest|pytest|mocha|spec|lint|tsc|build|compile/i;
  const GIT_RE = /\bgit\b|commit|push|pull|merge|rebase/i;
  const STAT_KEYS = ['totalTokens', 'agentsLaunched', 'toolsUsed', 'reads', 'searches', 'edits', 'writes', 'bashes', 'tests',
    'gits', 'webs', 'tasks', 'errors', 'done', 'subagents', 'terminalSessions', 'reposLinked', 'maxConcurrent'];
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = 0;
  const unlocked = new Map();      // achievement id → unlock time (ms)
  const seenAgents = new Set();    // agent ids already counted (or present before this page loaded)
  const seenTerminals = new Set();
  let saveTimer = 0;
  let evalTimer = 0;

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
      /* storage unavailable: progress lives for this page only */
    }
  }

  function loadProgress() {
    try {
      const raw = JSON.parse(storageGet(STATS_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        for (const k of STAT_KEYS) {
          const v = Number(raw[k]);
          if (Number.isFinite(v) && v > 0) stats[k] = Math.max(stats[k], Math.floor(v));
        }
      }
    } catch (_) {
      /* corrupted entry: start over */
    }
    try {
      const raw = JSON.parse(storageGet(ACH_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        for (const id of Object.keys(raw)) {
          const t = Number(raw[id]);
          unlocked.set(id, Number.isFinite(t) && t > 0 ? t : Date.now());
        }
      }
    } catch (_) {
      /* corrupted entry: start over */
    }
  }

  function saveProgress() {
    clearTimeout(saveTimer);
    saveTimer = 0;
    storageSet(STATS_KEY, JSON.stringify(stats));
  }

  function saveUnlocked() {
    const o = {};
    for (const [id, t] of unlocked) o[id] = t;
    storageSet(ACH_KEY, JSON.stringify(o));
  }

  function progressChanged() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveProgress, 1500);
    scheduleAchievements();
  }

  function bump(key, n) {
    const v = n === undefined ? 1 : Math.round(num(n));
    if (v <= 0) return;
    stats[key] = (stats[key] || 0) + v;
    progressChanged();
  }

  function bumpMax(key, value) {
    const v = Math.floor(num(value));
    if (v > (stats[key] || 0)) {
      stats[key] = v;
      progressChanged();
    }
  }

  function addTokens(delta) {
    bump('totalTokens', delta);
  }

  function isDemo(id) {
    const a = typeof id === 'string' ? store.get(id) : null;
    return !!(a && a.source === 'demo');
  }

  function trackArrival(agent, snapshot) {
    if (seenAgents.has(agent.id)) return;
    seenAgents.add(agent.id);
    if (snapshot || agent.source === 'demo') return;
    if (agent.kind === 'sub') bump('subagents');
    else if (agent.source !== 'observed') bump('agentsLaunched');
  }

  function trackTransition(prev, next) {
    if (prev.status === next.status || next.source === 'demo') return;
    if (next.status === 'error') bump('errors');
    else if (next.status === 'done' && RUNNING.has(prev.status)) bump('done');
  }

  function trackTerminal(id, snapshot) {
    if (seenTerminals.has(id)) return;
    seenTerminals.add(id);
    if (!snapshot) bump('terminalSessions');
  }

  function trackLog(entry) {
    if (!entry || entry.type !== 'tool') return;
    bump('toolsUsed');
    switch (entry.kind) {
      case 'read': bump('reads'); break;
      case 'search': bump('searches'); break;
      case 'edit': bump('edits'); break;
      case 'write': bump('writes'); break;
      case 'bash': {
        bump('bashes');
        const text = String(entry.text || '') + ' ' + String(entry.detail || '').slice(0, 300);
        if (TEST_RE.test(text)) bump('tests');
        if (GIT_RE.test(text)) bump('gits');
        break;
      }
      case 'web': bump('webs'); break;
      case 'task': bump('tasks'); break;
      default: break;
    }
  }

  function scheduleAchievements() {
    if (evalTimer) return;
    evalTimer = setTimeout(evaluateAchievements, 400);
  }

  function achievementDefs() {
    const P = window.HQProgression;
    return P && Array.isArray(P.ACHIEVEMENTS) ? P.ACHIEVEMENTS.filter((a) => a && typeof a.id === 'string') : null;
  }

  /** Runs every achievement test on a copy of the stats; new unlocks get a game toast (3 at most at once). */
  function evaluateAchievements() {
    clearTimeout(evalTimer);
    evalTimer = 0;
    const snap = Object.assign({}, stats);
    const defs = achievementDefs();
    if (!defs) {
      ui.setAchievements(null, snap);
      return;
    }
    const fresh = [];
    for (const a of defs) {
      if (unlocked.has(a.id) || typeof a.test !== 'function') continue;
      let ok = false;
      try {
        ok = !!a.test(snap);
      } catch (_) {
        ok = false;
      }
      if (ok) {
        unlocked.set(a.id, Date.now());
        fresh.push(a);
      }
    }
    if (fresh.length) {
      saveUnlocked();
      fresh.slice(0, 3).forEach((a, i) => {
        setTimeout(() => {
          ui.achievementToast(a);
          gameCall('playSound', 'achievement');
        }, i * 900);
      });
      if (fresh.length > 3) {
        ui.toast('… et ' + (fresh.length - 3) + ' autres succès débloqués : ouvre la fenêtre « Succès ».', 'ok');
      }
    }
    ui.setAchievements(defs.map((a) => ({
      id: a.id,
      icon: a.icon,
      title: a.title,
      description: a.description,
      unlocked: unlocked.has(a.id),
      at: unlocked.get(a.id) || 0
    })), snap);
  }

  // ------------------------------------------------------------------ game events (coins, level-ups, tour…)

  function onGameEvent(ev) {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'coin':
        ui.coinHit(num(ev.value));
        break;
      case 'levelup': {
        const a = typeof ev.id === 'string' ? store.get(ev.id) : null;
        if (!a && !ev.name) break;
        ui.levelToast({ name: a ? a.name : ev.name, level: ev.level, title: ev.title, color: a ? a.color : null });
        break;
      }
      case 'tour':
        ui.setTourState(!!ev.on);
        break;
      default:
        break;
    }
  }

  /** Minimap, coin target, events, rooms list: everything the HUD needs from the game once it runs. */
  function wireGame() {
    const game = window.HQGame;
    if (!game) return;
    const mm = document.getElementById('minimap');
    if (mm) gameCall('attachMinimap', mm);
    gameCall('setCoinTarget', () => ui.coinTarget());
    if (typeof game.onEvent === 'function') {
      try {
        game.onEvent(onGameEvent);
      } catch (err) {
        console.error('[PixelQG] HQGame.onEvent a échoué.', err);
      }
    }
    const rooms = gameCall('rooms');
    if (Array.isArray(rooms)) ui.setRooms(rooms);
    const size = gameCall('worldSize');
    if (size && size.w > 0 && size.h > 0) ui.setWorldSize(size.w, size.h);
    ui.reportInsets();
  }

  // ------------------------------------------------------------------ SSE

  function markSessionDead() {
    if (sessionDead) return;
    sessionDead = true;
    clearTimeout(reconnectTimer);
    if (source) {
      source.close();
      source = null;
    }
    ui.setConnection('offline', { dead: true });
    termCall('shutdown');
    ui.showBanner('session', {
      kind: 'err',
      title: 'Session expirée.',
      text: 'Le serveur PixelQG a redémarré et cette page n\'est plus autorisée. Recharge-la pour reprendre.',
      actions: [{ label: 'Recharger', primary: true, onClick: () => window.location.reload() }],
      dismissible: false
    });
  }

  /** After a stream failure, tell "server down" apart from "token rejected". */
  async function probeSession() {
    try {
      const res = await fetch('/api/config', { headers: { 'X-HQ-Token': TOKEN }, cache: 'no-store' });
      if (res.status === 401) markSessionDead();
    } catch (_) {
      /* server unreachable: keep retrying with backoff */
    }
  }

  function connect() {
    if (!TOKEN_OK || sessionDead) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    if (source) {
      source.close();
      source = null;
    }
    ui.setConnection('connecting');
    let es;
    try {
      es = new EventSource('/api/events?token=' + encodeURIComponent(TOKEN));
    } catch (err) {
      console.error('[PixelQG] EventSource indisponible.', err);
      scheduleReconnect();
      return;
    }
    source = es;
    const live = () => source === es;

    es.addEventListener('open', () => {
      if (!live()) return;
      attempt = 0;
      ui.setConnection('online');
    });
    es.addEventListener('snapshot', (ev) => {
      if (!live()) return;
      const data = parseEvent(ev);
      if (!data) return;
      attempt = 0;
      ui.setConnection('online');
      applySnapshot(data);
    });
    es.addEventListener('agent', (ev) => {
      if (!live()) return;
      const agent = parseEvent(ev);
      if (validAgent(agent)) upsertLocal(agent);
    });
    es.addEventListener('log', (ev) => {
      if (!live()) return;
      const data = parseEvent(ev);
      if (data && typeof data.id === 'string') onLog(data.id, data.entry);
    });
    es.addEventListener('remove', (ev) => {
      if (!live()) return;
      const data = parseEvent(ev);
      if (data && typeof data.id === 'string') removeLocal(data.id);
    });
    es.addEventListener('tokens', (ev) => {
      if (!live()) return;
      const data = parseEvent(ev);
      if (data && typeof data.id === 'string' && num(data.delta) > 0) {
        gameCall('tokens', data.id, num(data.delta));
        if (!isDemo(data.id)) addTokens(num(data.delta));
      }
    });
    es.addEventListener('terminal', (ev) => {
      if (!live()) return;
      const t = parseEvent(ev);
      if (validTerminal(t)) upsertTerminal(t, { live: true });
    });
    es.addEventListener('library', (ev) => {
      if (!live()) return;
      const lib = parseEvent(ev);
      if (validLibrary(lib)) applyLibrary(lib);
    });
    es.addEventListener('terminal-remove', (ev) => {
      if (!live()) return;
      const data = parseEvent(ev);
      if (data && typeof data.id === 'string') removeTerminal(data.id);
    });
    es.addEventListener('error', () => {
      if (!live()) return;
      es.close();
      source = null;
      scheduleReconnect();
      probeSession();
    });
  }

  function scheduleReconnect() {
    if (sessionDead) return;
    clearTimeout(reconnectTimer);
    attempt += 1;
    const delay = Math.min(BACKOFF_MAX, BACKOFF_BASE * Math.pow(2, Math.min(attempt - 1, 5))) + Math.floor(Math.random() * 400);
    ui.setConnection('offline', { retryIn: delay });
    reconnectTimer = setTimeout(connect, delay);
  }

  function reconnectNow() {
    if (!TOKEN_OK || sessionDead) return;
    termCall('reconnectNow');
    if (source) return;
    attempt = 0;
    connect();
  }

  // ------------------------------------------------------------------ keyboard & environment

  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      // Keys typed in a terminal belong to the shell / Claude Code (Escape interrupts it there).
      if (termCall('owns', e.target) === true) return;
      if (ui.handleEscape() || termCall('handleEscape') === true) {
        e.preventDefault();
        return;
      }
      if (selectedId) {
        e.preventDefault();
        select(null, 'key');
      }
    });
  }

  function bindReducedMotion() {
    let mq = null;
    try {
      mq = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    } catch (_) {
      mq = null;
    }
    const apply = () => gameCall('setReducedMotion', !!(mq && mq.matches));
    apply();
    if (mq) {
      if (typeof mq.addEventListener === 'function') mq.addEventListener('change', apply);
      else if (typeof mq.addListener === 'function') mq.addListener(apply);
    }
  }

  function bindEnvironment() {
    window.addEventListener('online', reconnectNow);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        reconnectNow();
        updateStats(Date.now());
      }
    });
    window.addEventListener('beforeunload', () => {
      if (source) source.close();
      saveProgress();
    });
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    ui.init({
      getAgents: () => store.values(),
      getAgent: (id) => store.get(id),
      onSelect: (id) => select(id, 'ui'),
      onLaunch: launch,
      onStop: stop,
      onMessage: sendMessage,
      onRemove: removeAgent,
      onToggleDemo: setDemo,
      onToggleObserve: setObserve,
      getTerminal: (id) => terminals.get(id),
      getTerminals: () => terminals.values(),
      onCreateTerminal: createTerminal,
      onShowTerminal: showTerminal,
      onWindowsChange,
      onToggleTour: (on) => {
        const res = gameCall('setTour', !!on);
        return typeof res === 'boolean' ? res : false;
      },
      onToggleSound: (on) => {
        const res = gameCall('setSound', !!on);
        return typeof res === 'boolean' ? res : false;
      },
      onFocusRoom: (id) => gameCall('focusRoom', id),
      onHoverAgent: (id) => gameCall('highlight', id),
      onInsets: (ins) => gameCall('setViewInsets', ins),
      onLibraryLink: linkRepo,
      onLibraryUpdate: updateRepo,
      onLibraryToggle: toggleRepo,
      onLibraryRemove: removeRepo
    });

    termCall('init', {
      token: TOKEN_OK ? TOKEN : '',
      getTerminals: () => terminals.values(),
      getTerminal: (id) => terminals.get(id),
      getAgent: (id) => store.get(id),
      drawAvatar: (canvas, color, opts) => ui.drawAvatar(canvas, color, opts),
      onSelectAgent: (id) => select(id, 'terminal'),
      onClose: closeTerminal,
      onReopen: reopenTerminal,
      toast: (msg, kind) => ui.toast(msg, kind)
    });
    if (!window.HQTerminal) {
      console.warn('[PixelQG] Le module du terminal intégré (HQTerminal) n\'est pas chargé.');
    }
    onWindowsChange(ui.windowsState());

    const canvas = document.getElementById('office');
    if (canvas) {
      gameCall('init', canvas, {
        onSelect: (id) => {
          if (inGameSelect) return;
          select(typeof id === 'string' ? id : null, 'game');
        },
        onHover: (id) => ui.setHover(typeof id === 'string' ? id : null)
      });
      wireGame();
    }
    if (!window.HQGame) {
      console.warn('[PixelQG] Le bureau (HQGame) n\'est pas chargé : seule la liste des agents est affichée.');
    }

    bindReducedMotion();
    bindKeys();
    bindEnvironment();
    loadProgress();
    updateStats(Date.now());
    evaluateAchievements();
    setInterval(() => {
      const now = Date.now();
      ui.tick(now);
      updateStats(now);
    }, 1000);

    if (!TOKEN_OK) {
      ui.setConnection('offline', { dead: true });
      ui.showBanner('token', {
        kind: 'err',
        title: 'Jeton d\'accès manquant.',
        text: 'Cette page doit être ouverte par le serveur PixelQG : lance start.bat (ou « npm start ») '
          + 'puis ouvre l\'adresse affichée, par exemple http://127.0.0.1:4317.',
        dismissible: false
      });
      return;
    }

    loadConfig();
    connect();
  }

  boot();
})();
