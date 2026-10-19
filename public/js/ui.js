/*
 * PixelQG — game HUD (window.HQUI).
 *
 * The office canvas fills the window; this module renders everything that floats above it:
 * the « ressources » bar (tokens counter hit by the flying coins, cost, agents, time, connection,
 * Claude Code version), the icon toolbar, the « Tes pix » party bar, the minimap frame, the character
 * sheet of the selected agent (stats, journal, actions), the draggable game windows (Nouveau pix,
 * Terminal, Bibliothèque, Succès), achievements, game toasts, banners and plain toasts.
 * main.js owns the agent store, the API client and the SSE connection; it hands this module read
 * accessors and action callbacks through init().
 *
 * Safety rule: every string coming from the server is written with textContent or as an
 * attribute value through createElement/setAttribute. Nothing here parses HTML.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ constants

  const NAME_POOL = ['Nova', 'Pixel', 'Biscotte', 'Orion', 'Luna', 'Zéphyr', 'Praline', 'Cosmo', 'Mochi', 'Atlas',
    'Noisette', 'Kiwi', 'Comète', 'Sirius', 'Galette', 'Écho', 'Pistache', 'Nimbus', 'Caramel', 'Vega', 'Myrtille',
    'Quartz', 'Sésame', 'Lyra'];

  const DEFAULT_COLORS = ['#FF8A5B', '#5BA4E6', '#7BC67E', '#B48EE0', '#F2C14E', '#E0709B', '#4FC1B9', '#E8955A',
    '#8E9BF0', '#C9D86B', '#F07C6C', '#A0A7B8'];

  const COLOR_NAMES = {
    '#FF8A5B': 'Corail', '#5BA4E6': 'Bleu ciel', '#7BC67E': 'Vert tendre', '#B48EE0': 'Lavande',
    '#F2C14E': 'Moutarde', '#E0709B': 'Rose', '#4FC1B9': 'Turquoise', '#E8955A': 'Abricot',
    '#8E9BF0': 'Pervenche', '#C9D86B': 'Anis', '#F07C6C': 'Corail', '#A0A7B8': 'Gris perle'
  };

  const DEFAULT_MODELS = [
    { value: '', label: 'Par défaut' },
    { value: 'haiku', label: 'Haiku (rapide, économique)' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'opus', label: 'Opus' },
    { value: 'fable', label: 'Fable (le plus puissant)' }
  ];

  const DEFAULT_PERMISSION_MODES = [
    { value: 'default', label: 'Prudent — lecture seule, refuse les modifications' },
    { value: 'acceptEdits', label: 'Modifications de fichiers autorisées' },
    { value: 'auto', label: 'Auto' },
    { value: 'plan', label: 'Plan — réfléchit sans agir' },
    { value: 'bypassPermissions', label: 'Tout autoriser (dangereux)', danger: true }
  ];

  const EFFORTS = [
    { value: '', label: 'Par défaut' },
    { value: 'low', label: 'Faible' },
    { value: 'medium', label: 'Moyen' },
    { value: 'high', label: 'Élevé' },
    { value: 'xhigh', label: 'Très élevé' },
    { value: 'max', label: 'Maximum' }
  ];

  const STATUS_LABEL = {
    starting: 'Démarre', working: 'Travaille', waiting: 'En attente',
    done: 'Terminé', error: 'Erreur', stopped: 'Arrêté'
  };

  const SOURCE_LABEL = { observed: 'Externe', terminal: 'Terminal' };
  const SOURCE_TITLE = {
    observed: 'Session Claude Code lancée en dehors de PixelQG (observation seule)',
    terminal: 'Session Claude Code interactive lancée dans un terminal de PixelQG'
  };
  const SOURCE_CLASSES = new Set(['observed', 'terminal']);

  const LOG_TYPE_LABEL = {
    user: 'Consigne', text: 'Message', thinking: 'Réflexion', tool: 'Outil',
    tool_result: "Résultat d'outil", result: 'Fin du tour', error: 'Erreur', system: 'Système'
  };

  const KIND_LABEL = {
    think: 'Réflexion', read: 'Lecture', search: 'Recherche', edit: 'Modification', write: 'Écriture',
    bash: 'Commande', web: 'Web', task: 'Délégation', todo: 'Organisation', tool: 'Outil', talk: 'Réponse',
    idle: 'Pause', done: 'Terminé', error: 'Erreur'
  };

  const RUNNING = new Set(['starting', 'working']);
  const ENDED = new Set(['done', 'error', 'stopped']);
  const TOAST_KINDS = new Set(['ok', 'err', 'warn', 'info']);

  const LOG_CAP = 500;
  const MAX_PROMPT = 100000;
  const MAX_TOASTS = 4;
  const CONFIRM_TIMEOUT = 6000;
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;
  const NAME_RE = /^[\p{L}\p{N} _.-]+$/u;
  const ABS_PATH_RE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\|\/)/;


  const STORE_KEYS = {
    cwd: 'pixelqg-app:cwd',
    profile: 'pixelqg-app:profile',
    termProfile: 'pixelqg-app:term-profile',
    winsOpen: 'pixelqg-app:wins-open',
    winPrefix: 'pixelqg-app:win:',
    minimap: 'pixelqg-app:minimap'
  };
  const WIN_NAMES = ['agent', 'terminal', 'library', 'achievements'];
  const WIN_DEFS = {
    agent: { id: 'win-agent', btn: 'tb-agent', resizable: false },
    terminal: { id: 'win-term', btn: 'tb-term', resizable: true },
    library: { id: 'win-lib', btn: 'tb-lib', resizable: false },
    achievements: { id: 'win-ach', btn: 'tb-ach', resizable: false }
  };
  const NARROW_QUERY = '(max-width: 899.98px)';

  // Level thresholds and titles (docs/GAME2.md §2): used when progression.js is not loaded.
  const LEVEL_FLOORS = [0, 10000, 50000, 150000, 400000, 1000000, 2500000, 6000000, 15000000, 40000000];
  const LEVEL_TITLES = ['Stagiaire', 'Junior', 'Confirmé', 'Senior', 'Expert', 'Architecte', 'Maestro', 'Légende', 'Mythe', 'Oracle'];

  // ------------------------------------------------------------------ formatting

  const nfInt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
  const nfOne = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nfCost2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nfCost4 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const clockFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });

  function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /** Integer with French grouping: 12 345. */
  function fmtInt(n) {
    return nfInt.format(Math.round(toNum(n)));
  }

  /** Compact token count: 842 · 1,2 k · 3,4 M. */
  function fmtTokens(n) {
    const v = Math.max(0, toNum(n));
    if (v < 1000) return nfInt.format(Math.round(v));
    if (v < 999950) return nfOne.format(v / 1e3) + '\u00a0k';
    return nfOne.format(v / 1e6) + '\u00a0M';
  }

  /** Cost in dollars: $0,0184 below one dollar, $12,34 above. null → em dash. */
  function fmtCost(usd) {
    if (usd === null || usd === undefined || usd === '') return '—';
    const v = Number(usd);
    if (!Number.isFinite(v)) return '—';
    return '$' + (Math.abs(v) >= 1 ? nfCost2 : nfCost4).format(v);
  }

  /** Duration: mm:ss, or h:mm:ss from one hour. */
  function fmtDuration(ms) {
    let s = Math.max(0, Math.floor(toNum(ms) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    s %= 60;
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? h + ':' + p(m) + ':' + p(s) : p(m) + ':' + p(s);
  }

  /** Wall-clock time HH:MM:SS. */
  function fmtClock(t) {
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return '--:--:--';
    return clockFmt.format(new Date(n));
  }

  /** Start/end line for the drawer: "14:03:22 → 14:09:41" (with the day when not today). */
  function fmtSpan(start, end) {
    const s = Number(start);
    if (!Number.isFinite(s) || s <= 0) return '—';
    const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
    const now = Date.now();
    let out = (sameDay(s, now) ? '' : dayFmt.format(new Date(s)) + ' ') + fmtClock(s);
    const e = Number(end);
    out += Number.isFinite(e) && e > 0 ? ' → ' + (sameDay(e, s) ? '' : dayFmt.format(new Date(e)) + ' ') + fmtClock(e) : ' → en cours';
    return out;
  }

  // ------------------------------------------------------------------ small helpers

  function str(v) {
    if (v === null || v === undefined) return '';
    return typeof v === 'string' ? v : String(v);
  }

  function truncate(s, max) {
    const t = str(s);
    return t.length > max ? t.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : t;
  }

  function safeColor(c) {
    return typeof c === 'string' && HEX_RE.test(c) ? c : '#A0A7B8';
  }

  function knownStatus(a) {
    return a && STATUS_LABEL[a.status] ? a.status : 'stopped';
  }

  function isRunning(a) {
    return RUNNING.has(a && a.status);
  }

  function isEnded(a) {
    return ENDED.has(a && a.status);
  }

  /** Interactive terminal session waiting for the user's next message. */
  function asksUser(a) {
    return !!a && a.interactive === true && a.status === 'waiting';
  }

  /** Status word for pills: « T'attend » for an interactive session waiting for the user. */
  function statusLabel(a) {
    return asksUser(a) ? 'T\'attend' : STATUS_LABEL[knownStatus(a)];
  }

  function pillClass(a) {
    return 'pill pill--' + knownStatus(a) + (asksUser(a) ? ' pill--asks' : '');
  }

  /** The claude process of an interactive session is alive while it waits for the user. */
  function canStop(a) {
    return a.canControl !== false && (isRunning(a) || asksUser(a));
  }

  function hasCost(a) {
    return !!a && a.costUsd !== null && a.costUsd !== undefined && a.costUsd !== '' && Number.isFinite(Number(a.costUsd));
  }

  function shortModel(m) {
    const s = str(m).trim();
    return s ? s.replace(/^claude-/, '') : '';
  }

  /** "anthropics-skills:code-reviewer" → "code-reviewer" (empty when the agent has no library profile). */
  function profileShort(p) {
    const s = str(p).trim();
    if (!s) return '';
    const i = s.lastIndexOf(':');
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function shortTool(name) {
    const s = str(name);
    if (s.startsWith('mcp__')) {
      const parts = s.split('__').filter(Boolean);
      return parts.length ? parts[parts.length - 1] : s;
    }
    return s;
  }

  function activityText(a) {
    const label = a && a.activity && a.activity.label;
    return label ? str(label) : (statusLabel(a) || '');
  }

  function elapsedMs(a, now) {
    const start = Number(a && a.startedAt);
    if (!Number.isFinite(start) || start <= 0) return 0;
    const end = Number(a.endedAt);
    return Math.max(0, (Number.isFinite(end) && end > 0 ? end : now) - start);
  }

  function tokensOf(a) {
    const t = (a && a.tokens) || {};
    const input = toNum(t.input);
    const output = toNum(t.output);
    const cacheRead = toNum(t.cacheRead);
    const cacheWrite = toNum(t.cacheWrite);
    const total = toNum(t.total) || input + output + cacheRead + cacheWrite;
    return { input, output, cacheRead, cacheWrite, total };
  }

  function errMsg(err) {
    if (!err) return 'Une erreur inconnue est survenue.';
    if (typeof err === 'string') return err;
    return str(err.message) || 'Une erreur inconnue est survenue.';
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
        else if (key === 'text') node.textContent = str(v);
        else if (key.startsWith('on') && typeof v === 'function') node.addEventListener(key.slice(2), v);
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

  function prefersReducedMotion() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (_) {
      return false;
    }
  }

  // ------------------------------------------------------------------ pixel icons (8×8 grids)
  // '#' is drawn in currentColor; the other letters use ICON_PALETTE (multi-colour icons such as the coin).

  const ICON_PALETTE = {
    x: '#5a3c12', o: '#f2c14e', d: '#c8962e', '*': '#ffe89a',
    r: '#e5534b', w: '#f5ecd7', g: '#6cc28a', b: '#6aa9ff'
  };

  const ICON_MAPS = {
    think: ['..####..', '.#....#.', '.#....#.', '.#....#.', '..#..#..', '...##...', '..####..', '...##...'],
    read: ['........', '##....##', '#.#..#.#', '#..##..#', '#..##..#', '#..##..#', '.##..##.', '........'],
    search: ['.####...', '#....#..', '#....#..', '#....#..', '.####...', '....##..', '.....##.', '......##'],
    edit: ['......##', '.....###', '....###.', '...###..', '..###...', '.###....', '##......', '#.......'],
    write: ['.####...', '.#..##..', '.#...#..', '.#.###..', '.#...#..', '.#.###..', '.#...#..', '.#####..'],
    bash: ['########', '#......#', '#.#....#', '#..#...#', '#.#.##.#', '#......#', '########', '........'],
    web: ['..####..', '.#.##.#.', '#..##..#', '########', '#..##..#', '.#.##.#.', '..####..', '........'],
    task: ['.##..##.', '.##..##.', '........', '###..###', '###..###', '###..###', '........', '........'],
    todo: ['##.#####', '##......', '........', '##.#####', '##......', '........', '##.#####', '##......'],
    tool: ['.....##.', '....#..#', '....#.#.', '...###..', '..###...', '.###....', '###.....', '##......'],
    talk: ['########', '#......#', '#.####.#', '#......#', '########', '.##.....', '.#......', '........'],
    idle: ['..###...', '.##.....', '##......', '##......', '##......', '.##...#.', '..####..', '........'],
    done: ['........', '.......#', '......##', '#....##.', '##..##..', '.####...', '..##....', '........'],
    error: ['...##...', '...##...', '...##...', '...##...', '...##...', '........', '...##...', '...##...'],
    user: ['..####..', '..####..', '..####..', '........', '.######.', '########', '########', '........'],
    result: ['#.......', '#####...', '######..', '#####...', '#.......', '#.......', '#.......', '#.......'],
    'return': ['#.......', '#.......', '#....#..', '#.....#.', '########', '......#.', '.....#..', '........'],
    system: ['...##...', '.#.##.#.', '..####..', '###..###', '###..###', '..####..', '.#.##.#.', '...##...'],
    clock: ['.######.', '#......#', '#..#...#', '#..#...#', '#..###.#', '#......#', '#......#', '.######.'],
    tokens: ['........', '.######.', '........', '.######.', '........', '.######.', '........', '........'],
    // HUD
    agent: ['...##...', '....#...', '########', '#.#..#.#', '#.#..#.#', '########', '..####..', '..#..#..'],
    books: ['........', '#.##.#..', '#.##.##.', '#.##.##.', '#.##..##', '#.##..##', '########', '........'],
    trophy: ['########', '#.####.#', '.######.', '..####..', '...##...', '...##...', '..####..', '.######.'],
    eye: ['........', '..####..', '.#....#.', '#..##..#', '#..##..#', '.#....#.', '..####..', '........'],
    camera: ['........', '..##....', '########', '#..##..#', '#.#..#.#', '#..##..#', '########', '........'],
    sound: ['...#....', '..##..#.', '####...#', '####.#.#', '####.#.#', '####...#', '..##..#.', '...#....'],
    mute: ['...#....', '..##....', '####.#.#', '####..#.', '####..#.', '####.#.#', '..##....', '...#....'],
    fullscreen: ['###..###', '#......#', '#......#', '........', '........', '#......#', '#......#', '###..###'],
    cost: ['...##...', '.######.', '##.##...', '.######.', '...##.##', '.######.', '...##...', '........'],
    hourglass: ['########', '.#....#.', '..#..#..', '...##...', '...##...', '..#..#..', '.#.##.#.', '########'],
    scroll: ['.######.', '#.....#.', '.#.##.#.', '.#....#.', '.#.###.#', '.#.....#', '.######.', '........'],
    coin: ['..xxxx..', '.xo**ox.', 'xo*oooox', 'xo*oxodx', 'xooxoodx', 'xooooddx', '.xoddox.', '..xxxx..'],
    star: ['...##...', '...##...', '########', '.######.', '..####..', '.##..##.', '##....##', '........'],
    letter: ['........', '########', '##....##', '#.#..#.#', '#..##..#', '#......#', '########', '........'],
    heart: ['........', '.##..##.', '########', '########', '.######.', '..####..', '...##...', '........'],
    bolt: ['....##..', '...##...', '..##....', '.######.', '....##..', '...##...', '..##....', '.##.....'],
    flame: ['...#....', '..##....', '..###.#.', '.######.', '########', '###..###', '.##..##.', '..####..'],
    crown: ['........', '#..##..#', '##.##.##', '########', '########', '##.##.##', '########', '........'],
    lock: ['..####..', '.#....#.', '.#....#.', '########', '###..###', '###..###', '########', '........']
  };
  // Names used by the achievements (progression.js) that map onto existing drawings.
  const ICON_ALIAS = {
    lightbulb: 'think', bulb: 'think', book: 'read', wrench: 'tool', terminal: 'bash', globe: 'web',
    mail: 'letter', envelope: 'letter', check: 'done', team: 'agent', robot: 'agent', bot: 'agent', cup: 'trophy',
    magnifier: 'search', pencil: 'edit', paper: 'write', gear: 'system', sparkle: 'star'
  };

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const iconPaths = new Map();

  function iconKey(name) {
    if (ICON_MAPS[name]) return name;
    if (ICON_ALIAS[name] && ICON_MAPS[ICON_ALIAS[name]]) return ICON_ALIAS[name];
    return 'tool';
  }

  /** Converts pixel rows into one SVG path per colour: [{ fill, d }]. */
  function rowsToPaths(rows, palette) {
    const groups = new Map();
    rows.forEach((row, y) => {
      const line = String(row);
      let x = 0;
      while (x < line.length) {
        const c = line[x];
        if (c === '.' || c === ' ') { x++; continue; }
        let w = 1;
        while (line[x + w] === c) w++;
        const fill = c === '#' ? 'currentColor' : (palette && palette[c]) || ICON_PALETTE[c] || 'currentColor';
        groups.set(fill, (groups.get(fill) || '') + 'M' + x + ' ' + y + 'h' + w + 'v1h-' + w + 'z');
        x += w;
      }
    });
    return Array.from(groups, ([fill, d]) => ({ fill, d }));
  }

  function svgFromRows(rows, palette, cls) {
    const width = rows.reduce((m, r) => Math.max(m, String(r).length), 1);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + rows.length);
    svg.setAttribute('class', cls || 'px-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('shape-rendering', 'crispEdges');
    for (const p of rowsToPaths(rows, palette)) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', p.d);
      path.setAttribute('fill', p.fill);
      svg.appendChild(path);
    }
    return svg;
  }

  function icon(name) {
    const key = iconKey(name);
    let paths = iconPaths.get(key);
    if (!paths) {
      paths = rowsToPaths(ICON_MAPS[key]);
      iconPaths.set(key, paths);
    }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 8 8');
    svg.setAttribute('class', 'px-icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.setAttribute('shape-rendering', 'crispEdges');
    for (const p of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', p.d);
      path.setAttribute('fill', p.fill);
      svg.appendChild(path);
    }
    return svg;
  }

  /**
   * Achievement icon: the shared HQProgression.ICONS entry when it is a drawable we understand
   * (pixel rows, { rows, palette }, a canvas, or a draw function), else our own pixel map.
   */
  function achievementIcon(name) {
    const P = window.HQProgression;
    const src = P && P.ICONS && typeof name === 'string' ? P.ICONS[name] : null;
    try {
      if (Array.isArray(src) && src.length && src.every((r) => typeof r === 'string')) {
        return svgFromRows(src, P.ICON_PALETTE || null, 'px-icon px-icon--ach');
      }
      if (src && typeof src === 'object' && Array.isArray(src.rows)) {
        return svgFromRows(src.rows, src.palette || src.colors || P.ICON_PALETTE || null, 'px-icon px-icon--ach');
      }
      if (src && (typeof src === 'function' || (typeof HTMLCanvasElement !== 'undefined' && src instanceof HTMLCanvasElement))) {
        const c = document.createElement('canvas');
        c.width = 32; c.height = 32;
        c.className = 'px-icon px-icon--ach';
        c.setAttribute('aria-hidden', 'true');
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = false;
        if (typeof src === 'function') src(g, 0, 0, 4);
        else g.drawImage(src, 0, 0, 32, 32);
        const px = g.getImageData(0, 0, 32, 32).data;
        for (let i = 3; i < px.length; i += 4) if (px[i] > 0) return c;
      }
    } catch (_) {
      /* unknown icon format: fall back to the HUD drawing */
    }
    const svg = icon(name);
    svg.classList.add('px-icon--ach');
    return svg;
  }

  /** Fills every static `[data-icon]` placeholder of the page with its pixel icon. */
  function paintStaticIcons(root) {
    for (const node of (root || document).querySelectorAll('[data-icon]')) {
      if (node.querySelector('svg')) continue;
      node.appendChild(icon(node.getAttribute('data-icon')));
    }
  }

  function setIcon(node, name) {
    if (!node || node.getAttribute('data-icon') === name) return;
    node.setAttribute('data-icon', name);
    node.replaceChildren(icon(name));
  }

  function logIconName(type, kind) {
    switch (type) {
      case 'tool': return KIND_LABEL[kind] ? kind : 'tool';
      case 'text': return 'talk';
      case 'thinking': return 'think';
      case 'tool_result': return 'return';
      case 'result': return 'result';
      case 'error': return 'error';
      case 'user': return 'user';
      default: return 'system';
    }
  }

  // ------------------------------------------------------------------ levels

  /** { level, title, progress (0..1), floor, next } from HQProgression, or the local copy of its table. */
  function levelOf(tokens) {
    const P = window.HQProgression;
    if (P && typeof P.level === 'function') {
      try {
        const l = P.level(tokens);
        if (l && Number.isFinite(Number(l.level))) {
          return {
            level: Math.max(1, Math.round(Number(l.level))),
            title: str(l.title) || LEVEL_TITLES[Math.min(LEVEL_TITLES.length, Math.max(1, Number(l.level))) - 1] || '',
            progress: Math.max(0, Math.min(1, toNum(l.progress))),
            floor: toNum(l.floor),
            next: l.next === null || l.next === undefined ? null : toNum(l.next)
          };
        }
      } catch (_) {
        /* fall back to the local table */
      }
    }
    const t = Math.max(0, toNum(tokens));
    let i = 0;
    while (i + 1 < LEVEL_FLOORS.length && t >= LEVEL_FLOORS[i + 1]) i++;
    const floor = LEVEL_FLOORS[i];
    const next = i + 1 < LEVEL_FLOORS.length ? LEVEL_FLOORS[i + 1] : null;
    return { level: i + 1, title: LEVEL_TITLES[i], progress: next ? (t - floor) / (next - floor) : 1, floor, next };
  }

  // ------------------------------------------------------------------ avatars

  function shade(hex, amount) {
    const c = safeColor(hex);
    const n = parseInt(c.slice(1), 16);
    let r = (n >> 16) & 255;
    let g = (n >> 8) & 255;
    let b = n & 255;
    const target = amount >= 0 ? 255 : 0;
    const k = Math.abs(amount);
    r = Math.round(r + (target - r) * k);
    g = Math.round(g + (target - g) * k);
    b = Math.round(b + (target - b) * k);
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  /** PixelQG robot map for the stand-in avatar (A antenna, G stalk, K ink, C casing, H highlight,
   *  S screen, E eye, D body, L chest light). */
  const FALLBACK_BOT = [
    '.....AA.....', '......G.....', '..KKKKKKKK..', '.KCHHCCCCCK.', '.KCSSSSSSCK.',
    '.KCSESSESCK.', '.KCSESSESCK.', '.KCSSSSSSCK.', '.KCCCCCCCCK.', '..KKKKKKKK..',
    '...KDDDDK...', '..KDDLLDDK..', '..KDDDDDDK..', '...KK..KK...', '...KK..KK...'
  ];

  /** Local stand-in used only when HQGame.drawAvatar is missing or throws. */
  function fallbackAvatar(canvas, color, opts) {
    const size = Math.max(8, Math.round(toNum(opts && opts.size) || 48));
    const frame = toNum(opts && opts.frame) % 2;
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    const px = size * dpr;
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== px) canvas.height = px;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    ctx.imageSmoothingEnabled = false;
    const u = px / 16;
    const bob = frame ? 1 : 0;
    const rect = (x, y, w, hgt, fill) => {
      ctx.fillStyle = fill;
      ctx.fillRect(Math.round(x * u), Math.round(y * u), Math.ceil(w * u), Math.ceil(hgt * u));
    };
    const base = safeColor(color);
    const pal = {
      A: '#ffc84a', G: '#8790b0', K: '#0a0b16', C: base, H: shade(base, 0.45), S: '#141a33', E: '#a6fff2',
      D: shade(base, -0.32), L: shade(base, 0.7)
    };
    rect(3, 15, 10, 1, 'rgba(0,0,0,0.35)');
    // The PixelQG robot, centred on the 16 x 16 grid; the head and body bob, the legs stay planted.
    FALLBACK_BOT.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] !== '.') rect(x + 2, y + (y < 13 ? bob : 0), 1, 1, pal[row[x]]);
      }
    });
  }

  function drawAvatar(canvas, color, opts) {
    if (!canvas) return;
    const game = window.HQGame;
    if (game && typeof game.drawAvatar === 'function') {
      try {
        if (game.drawAvatar(canvas, safeColor(color), opts) !== false) return;
      } catch (err) {
        console.warn('[HQUI] HQGame.drawAvatar a échoué, dessin de secours utilisé.', err);
      }
    }
    fallbackAvatar(canvas, color, opts);
  }

  // ------------------------------------------------------------------ module state

  const noop = () => undefined;
  let cb = {
    getAgents: () => [],
    getAgent: () => undefined,
    onSelect: noop,
    onLaunch: () => Promise.reject(new Error('Lancement indisponible.')),
    onStop: () => Promise.resolve(false),
    onMessage: () => Promise.resolve(false),
    onRemove: () => Promise.resolve(false),
    onToggleObserve: () => Promise.resolve(false),
    onToggleTour: () => false,
    onToggleSound: () => false,
    onFocusRoom: noop,
    onHoverAgent: noop,
    onInsets: noop,
    getTerminal: () => undefined,
    getTerminals: () => [],
    onCreateTerminal: () => Promise.reject(new Error('Terminal indisponible.')),
    onShowTerminal: () => false,
    onWindowsChange: noop,
    onLibraryLink: () => Promise.reject(new Error('Bibliothèque indisponible.')),
    onLibraryUpdate: () => Promise.reject(new Error('Bibliothèque indisponible.')),
    onLibraryToggle: () => Promise.reject(new Error('Bibliothèque indisponible.')),
    onLibraryRemove: () => Promise.reject(new Error('Bibliothèque indisponible.'))
  };

  let els = {};
  let initialized = false;
  let config = null;
  let termSupport = { supported: false, ready: false, reason: '' };
  let termCreating = false;
  let selectedId = null;
  let hoverId = null;
  let renderQueued = false;
  let avatarFrame = 0;
  let launching = false;
  let tourOn = false;
  let soundOn = false;

  const members = new Map();     // id → party member record (see createMember)
  const drafts = new Map();      // id → unsent follow-up text
  const banners = new Map();     // key → banner element
  const wins = {};               // window name → record (see setupWindows)
  let zTop = 40;
  let narrowMq = null;

  const drawer = {
    id: null,
    tab: 'info',
    stick: true,
    unseen: 0,
    pendingBelow: 0,
    avatarKey: '',
    subsSig: '',
    confirmTimer: 0,
    copyTimer: 0,
    loading: false
  };

  function agentsList() {
    try {
      const it = cb.getAgents();
      return it ? Array.from(it).filter((a) => a && typeof a.id === 'string') : [];
    } catch (_) {
      return [];
    }
  }

  function agentById(id) {
    if (!id) return undefined;
    try {
      return cb.getAgent(id) || undefined;
    } catch (_) {
      return undefined;
    }
  }

  /** The terminal an interactive agent was started in (undefined once that terminal is closed). */
  function terminalOfAgent(a) {
    if (!a || typeof a.terminalId !== 'string' || !a.terminalId) return undefined;
    try {
      const t = cb.getTerminal(a.terminalId);
      return t && typeof t.id === 'string' ? t : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function sourceTitle(a) {
    const base = (a && SOURCE_TITLE[a.source]) || null;
    if (base && a.source === 'terminal') {
      const t = terminalOfAgent(a);
      if (t && t.title) return base + ' (' + str(t.title) + ')';
    }
    return base;
  }

  function isNarrow() {
    if (narrowMq) return !!narrowMq.matches;
    // Before setupWindows() (e.g. bindMinimap at start-up): ask the media query directly.
    try {
      return !!(window.matchMedia && window.matchMedia(NARROW_QUERY).matches);
    } catch (_) {
      return false;
    }
  }

  // ------------------------------------------------------------------ element lookup

  function byId(id) {
    const node = document.getElementById(id);
    if (!node) {
      console.warn('[HQUI] élément #' + id + ' introuvable dans la page.');
      return document.createElement('div');
    }
    return node;
  }

  function collectElements() {
    els = {
      app: byId('app'),
      hudTop: byId('hud-top'),
      resBar: byId('res-bar'),
      toolbar: byId('toolbar'),
      coinTarget: byId('coin-target'),
      resCoins: byId('res-coins'),
      statActive: byId('stat-active'),
      statTokens: byId('stat-tokens'),
      statCost: byId('stat-cost'),
      statTime: byId('stat-time'),
      btnObserve: byId('btn-observe'),
      tbTour: byId('tb-tour'),
      tbSound: byId('tb-sound'),
      tbFull: byId('tb-full'),
      tbTerm: byId('tb-term'),
      tbLib: byId('tb-lib'),
      tbAch: byId('tb-ach'),
      tbAchCount: byId('tb-ach-count'),
      version: byId('claude-version'),
      conn: byId('conn'),
      connLabel: byId('conn-label'),
      banners: byId('banners'),
      stageEmpty: byId('stage-empty'),
      stageWrite: byId('stage-write'),
      stageTerm: byId('stage-term'),
      emptyAvatar: byId('empty-avatar'),
      hudBottom: byId('hud-bottom'),
      minimapPanel: byId('minimap-panel'),
      minimap: byId('minimap'),
      mmToggle: byId('mm-toggle'),
      mmRooms: byId('mm-rooms'),
      party: byId('party'),
      partyList: byId('party-list'),
      partyEmpty: byId('party-empty'),
      rosterCount: byId('roster-count'),
      winTerm: byId('win-term'),
      dockTermCount: byId('dock-term-count'),
      dockLibCount: byId('dock-lib-count'),
      libPanel: byId('lib-panel'),
      libNogit: byId('lib-nogit'),
      libForm: byId('lib-form'),
      fldLibUrl: byId('fld-lib-url'),
      libUrl: byId('lib-url'),
      libSubmit: byId('lib-submit'),
      libSuggest: byId('lib-suggest'),
      libError: byId('lib-error'),
      libNote: byId('lib-note'),
      libList: byId('lib-list'),
      libEmpty: byId('lib-empty'),
      libEmptyTitle: byId('lib-empty-title'),
      libEmptyText: byId('lib-empty-text'),
      profile: byId('f-profile'),
      profileDesc: byId('f-profile-desc'),
      tProfile: byId('t-profile'),
      termPanel: byId('term-panel'),
      termUnsupported: byId('term-unsupported'),
      termUnsupportedTitle: byId('term-unsupported-title'),
      termUnsupportedReason: byId('term-unsupported-reason'),
      termMain: byId('term-main'),
      termTools: byId('term-tools'),
      fldTCwd: byId('fld-t-cwd'),
      tCwd: byId('t-cwd'),
      fldTName: byId('fld-t-name'),
      tName: byId('t-name'),
      tColors: byId('t-colors'),
      tNew: byId('t-new'),
      tClaude: byId('t-claude'),
      tError: byId('t-error'),
      tEmptyNew: byId('t-empty-new'),
      tEmptyClaude: byId('t-empty-claude'),
      form: byId('launch-form'),
      fldPrompt: byId('fld-prompt'),
      prompt: byId('f-prompt'),
      promptErr: byId('f-prompt-err'),
      fldName: byId('fld-name'),
      name: byId('f-name'),
      nameErr: byId('f-name-err'),
      model: byId('f-model'),
      effort: byId('f-effort'),
      perm: byId('f-perm'),
      permWarn: byId('f-perm-warn'),
      colors: byId('f-colors'),
      fldCwd: byId('fld-cwd'),
      cwd: byId('f-cwd'),
      cwdErr: byId('f-cwd-err'),
      formErr: byId('f-error'),
      formNote: byId('f-note'),
      submit: byId('f-submit'),
      submitLabel: byId('f-submit-label'),
      achCount: byId('ach-count'),
      achFill: byId('ach-fill'),
      achStats: byId('ach-stats'),
      achList: byId('ach-list'),
      achEmpty: byId('ach-empty'),
      drawer: byId('drawer'),
      dAvatar: byId('d-avatar'),
      dLevel: byId('d-level'),
      dLevelTitle: byId('d-level-title'),
      dXp: byId('d-xp'),
      dXpFill: byId('d-xp-fill'),
      dXpText: byId('d-xp-text'),
      dName: byId('d-name'),
      dChips: byId('d-chips'),
      dClose: byId('d-close'),
      dPill: byId('d-pill'),
      dPillLabel: byId('d-pill-label'),
      dActivity: byId('d-activity'),
      dTimerTop: byId('d-timer-top'),
      tabInfo: byId('tab-info'),
      tabLog: byId('tab-log'),
      logBadge: byId('log-badge'),
      panelInfo: byId('panel-info'),
      panelLog: byId('panel-log'),
      dTimer: byId('d-timer'),
      dCost: byId('d-cost'),
      dTools: byId('d-tools'),
      dTurns: byId('d-turns'),
      dModel: byId('d-model'),
      dParentRow: byId('d-parent-row'),
      dParent: byId('d-parent'),
      dCwd: byId('d-cwd'),
      dSession: byId('d-session'),
      dCopy: byId('d-copy'),
      dTimes: byId('d-times'),
      dTokTotal: byId('d-tok-total'),
      dTokbar: byId('d-tokbar'),
      dSegIn: byId('d-seg-in'),
      dSegOut: byId('d-seg-out'),
      dSegCr: byId('d-seg-cr'),
      dSegCw: byId('d-seg-cw'),
      dTokIn: byId('d-tok-in'),
      dTokOut: byId('d-tok-out'),
      dTokCr: byId('d-tok-cr'),
      dTokCw: byId('d-tok-cw'),
      dErrorBlock: byId('d-error-block'),
      dError: byId('d-error'),
      dResultBlock: byId('d-result-block'),
      dResult: byId('d-result'),
      dLastBlock: byId('d-last-block'),
      dLast: byId('d-last'),
      dPromptBlock: byId('d-prompt-block'),
      dPrompt: byId('d-prompt'),
      dSubsBlock: byId('d-subs-block'),
      dSubsCount: byId('d-subs-count'),
      dSubs: byId('d-subs'),
      dLogEmpty: byId('d-log-empty'),
      dLog: byId('d-log'),
      dLogJump: byId('d-log-jump'),
      dFollowup: byId('d-followup'),
      dFollowupText: byId('d-followup-text'),
      dFollowupErr: byId('d-followup-err'),
      dSend: byId('d-send'),
      dNote: byId('d-note'),
      dStop: byId('d-stop'),
      dTerm: byId('d-term'),
      dRemove: byId('d-remove'),
      dRemoveConfirm: byId('d-remove-confirm'),
      dRemoveQ: byId('d-remove-q'),
      dRemoveYes: byId('d-remove-yes'),
      dRemoveNo: byId('d-remove-no'),
      toasts: byId('toasts')
    };
  }

  // ------------------------------------------------------------------ busy buttons

  function isBusy(btn) {
    return btn.getAttribute('aria-busy') === 'true';
  }

  /**
   * Runs an async action while marking the button busy (aria-disabled keeps keyboard focus).
   * Resolves with the action's value; rejections are turned into an error toast.
   */
  function runBusy(btn, fn, busyLabel) {
    if (isBusy(btn)) return Promise.resolve(false);
    const labelNode = busyLabel ? btn.querySelector('[data-label]') || btn : null;
    const previous = labelNode ? labelNode.textContent : '';
    btn.setAttribute('aria-busy', 'true');
    btn.setAttribute('aria-disabled', 'true');
    if (labelNode) labelNode.textContent = busyLabel;
    let p;
    try {
      p = Promise.resolve(fn());
    } catch (err) {
      p = Promise.reject(err);
    }
    return p.catch((err) => {
      toast(errMsg(err), 'err');
      return false;
    }).finally(() => {
      btn.removeAttribute('aria-busy');
      btn.removeAttribute('aria-disabled');
      if (labelNode && labelNode.textContent === busyLabel) labelNode.textContent = previous;
    });
  }

  // ------------------------------------------------------------------ ressources bar + toolbar

  function fullscreenOn() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function updateFullscreenButton() {
    const on = fullscreenOn();
    setAttr(els.tbFull, 'aria-pressed', on ? 'true' : 'false');
    setAttr(els.tbFull, 'data-tip', on ? 'Quitter le plein écran' : 'Plein écran');
    setAttr(els.tbFull, 'aria-label', on ? 'Quitter le plein écran' : 'Plein écran');
  }

  function toggleFullscreen() {
    try {
      if (fullscreenOn()) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) Promise.resolve(exit.call(document)).catch(() => {});
      } else {
        const root = document.documentElement;
        const req = root.requestFullscreen || root.webkitRequestFullscreen;
        if (req) Promise.resolve(req.call(root)).catch(() => toast('Le plein écran n\'est pas disponible ici.', 'info'));
      }
    } catch (_) {
      toast('Le plein écran n\'est pas disponible ici.', 'info');
    }
  }

  /** Visite guidée state (the game stops it by itself on user input). */
  function setTourState(on) {
    tourOn = !!on;
    setAttr(els.tbTour, 'aria-pressed', tourOn ? 'true' : 'false');
    setAttr(els.tbTour, 'data-tip', tourOn ? 'Visite guidée en cours : clique ou bouge le bureau pour l\'arrêter' : 'Visite guidée : la caméra passe de pix en pix');
  }

  function setSoundState(on) {
    soundOn = !!on;
    setAttr(els.tbSound, 'aria-pressed', soundOn ? 'true' : 'false');
    setAttr(els.tbSound, 'data-tip', soundOn ? 'Son 8-bit activé' : 'Son 8-bit (coupé par défaut)');
    setIcon(els.tbSound.querySelector('.tb-ico'), soundOn ? 'sound' : 'mute');
  }

  function bindToolbar() {
    for (const btn of els.toolbar.querySelectorAll('[data-win-btn]')) {
      btn.addEventListener('click', () => toggleWindow(btn.getAttribute('data-win-btn')));
    }
    els.btnObserve.addEventListener('click', () => {
      const current = !!(config && config.observe);
      runBusy(els.btnObserve, () => cb.onToggleObserve(!current));
    });
    els.tbTour.addEventListener('click', () => {
      let res = false;
      try { res = cb.onToggleTour(!tourOn); } catch (_) { res = false; }
      setTourState(typeof res === 'boolean' ? res : !tourOn);
    });
    els.tbSound.addEventListener('click', () => {
      let res = false;
      try { res = cb.onToggleSound(!soundOn); } catch (_) { res = false; }
      const next = typeof res === 'boolean' ? res : !soundOn;
      if (!soundOn && !next) toast('Le son n\'est pas disponible dans ce navigateur.', 'info');
      setSoundState(next);
    });
    const canFull = !!(document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen);
    setHidden(els.tbFull, !canFull);
    els.tbFull.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);
    updateFullscreenButton();
    setTourState(false);
    setSoundState(false);

    // Toolbar keyboard: arrows move between buttons.
    els.toolbar.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const list = Array.from(els.toolbar.querySelectorAll('button')).filter((b) => !b.hidden);
      const i = list.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      let n = e.key === 'ArrowLeft' ? i - 1 : e.key === 'ArrowRight' ? i + 1 : e.key === 'Home' ? 0 : list.length - 1;
      n = (n + list.length) % list.length;
      list[n].focus();
    });
  }

  // ---- animated tokens counter (the flying coins land on it)

  const counter = { target: 0, shown: 0, known: false, lastHit: 0, timer: 0, anim: 0 };

  function paintCounter() {
    setText(els.statTokens, fmtTokens(counter.shown));
  }

  function scheduleCatchUp() {
    clearTimeout(counter.timer);
    counter.timer = setTimeout(catchUp, 1400);
  }

  /** No coin arrived for a while: glide the counter to the real total. */
  function catchUp() {
    if (counter.shown >= counter.target) return;
    cancelAnimationFrame(counter.anim);
    const from = counter.shown;
    const to = counter.target;
    if (prefersReducedMotion() || document.hidden) {
      counter.shown = to;
      paintCounter();
      return;
    }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 650);
      counter.shown = Math.round(from + (counter.target - from) * (1 - Math.pow(1 - k, 3)));
      paintCounter();
      if (k < 1 && counter.shown < counter.target) counter.anim = requestAnimationFrame(step);
    };
    counter.anim = requestAnimationFrame(step);
  }

  function setTokenTarget(total) {
    const v = Math.max(0, Math.round(toNum(total)));
    counter.target = v;
    if (!counter.known) {
      counter.known = true;
      counter.shown = v;
    } else if (counter.shown > v) {
      counter.shown = v;          // agents removed: drop at once
    } else if (counter.shown < v) {
      scheduleCatchUp();
    }
    paintCounter();
  }

  /** A coin flown by the game reached the counter. */
  function coinHit(value) {
    const v = Math.max(0, toNum(value));
    if (v > 0) counter.shown = Math.min(counter.target, counter.shown + v);
    paintCounter();
    if (counter.shown < counter.target) scheduleCatchUp();
    const node = els.resCoins;
    if (node && !prefersReducedMotion()) {
      node.classList.remove('is-hit');
      void node.offsetWidth;   // restart the bump animation
      node.classList.add('is-hit');
    }
  }

  /** Client coordinates of the coin icon of the counter (where the game flies coins to). */
  function coinTarget() {
    const node = els.coinTarget;
    if (!node || !node.isConnected) return null;
    const r = node.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function setStats(stats) {
    const s = stats || {};
    const active = Math.max(0, Math.round(toNum(s.active)));
    const total = Math.max(0, Math.round(toNum(s.total)));
    setText(els.statActive, fmtInt(active) + ' / ' + fmtInt(total));
    setAttr(els.statActive.parentNode, 'title', fmtInt(active) + ' pix au travail sur ' + fmtInt(total));
    setTokenTarget(s.tokens);
    setAttr(els.resCoins, 'title', 'Tokens totaux : ' + fmtInt(s.tokens) + ' (entrée, sortie et cache)');
    setText(els.statCost, fmtCost(toNum(s.cost)));
    setAttr(els.statCost.parentNode, 'title', 'Coût cumulé des pix principaux (sous-pix inclus)');
    setText(els.statTime, fmtDuration(s.timeMs));
    setAttr(els.statTime.parentNode, 'title', 'Temps cumulé : somme des durées de travail des pix principaux');
  }

  function setConnection(state, info) {
    const st = state === 'online' || state === 'offline' ? state : 'connecting';
    els.conn.dataset.state = st;
    let label = 'Connexion…';
    if (st === 'online') label = 'Connecté';
    else if (st === 'offline') {
      const d = info || {};
      if (d.dead) label = 'Déconnecté';
      else if (toNum(d.retryIn) > 0) label = 'Hors ligne · nouvel essai dans ' + Math.max(1, Math.round(toNum(d.retryIn) / 1000)) + ' s';
      else label = 'Hors ligne';
    }
    setText(els.connLabel, label);
    setAttr(els.conn, 'title', st === 'online' ? 'Flux temps réel actif' : label);
  }

  function updateVersion() {
    const found = !config || config.claudeFound !== false;
    els.version.classList.toggle('is-missing', !found);
    if (!config) {
      setText(els.version, 'Claude Code…');
      setAttr(els.version, 'title', null);
      return;
    }
    if (!found) {
      setText(els.version, 'Claude Code introuvable');
      setAttr(els.version, 'title', 'Aucun exécutable « claude » trouvé : installe Claude Code ou indique son chemin dans la variable CLAUDE_BIN.');
      return;
    }
    const raw = str(config.claudeVersion).trim();
    const num = raw.replace(/\s*\(Claude Code\)\s*$/i, '');
    setText(els.version, num ? 'Claude Code ' + num : 'Claude Code');
    setAttr(els.version, 'title', config.claudePath ? 'Exécutable : ' + str(config.claudePath) : null);
  }

  // ------------------------------------------------------------------ minimap frame + camera insets

  function applyMinimapOpen(open) {
    els.minimapPanel.dataset.open = open ? 'true' : 'false';
    setHidden(byIdQuiet('mm-body'), !open);
    setAttr(els.mmToggle, 'aria-expanded', open ? 'true' : 'false');
    const label = open ? 'Masquer le plan' : 'Afficher le plan';
    setAttr(els.mmToggle, 'aria-label', label);
    setAttr(els.mmToggle, 'title', label);
    scheduleInsets();
  }

  function byIdQuiet(id) {
    return document.getElementById(id) || document.createElement('div');
  }

  function bindMinimap() {
    const stored = storageGet(STORE_KEYS.minimap);
    applyMinimapOpen(stored === null ? !isNarrow() : stored === '1');
    els.mmToggle.addEventListener('click', () => {
      const open = els.minimapPanel.dataset.open !== 'true';
      storageSet(STORE_KEYS.minimap, open ? '1' : '0');
      applyMinimapOpen(open);
    });
    els.mmRooms.addEventListener('change', () => {
      const id = els.mmRooms.value;
      if (id) {
        try { cb.onFocusRoom(id); } catch (_) { /* camera only */ }
      }
      els.mmRooms.value = '';
    });
    setRooms([]);
  }

  /** Rooms of the office for the « Aller à… » list: [{ id, label }]. */
  function setRooms(list) {
    const rooms = (Array.isArray(list) ? list : []).filter((r) => r && typeof r.id === 'string' && r.id);
    const sig = rooms.map((r) => r.id + ':' + str(r.label)).join('|');
    if (els.mmRooms.dataset.sig === sig) return;
    els.mmRooms.dataset.sig = sig;
    const nodes = [h('option', { value: '' }, 'Aller à…')];
    for (const r of rooms) nodes.push(h('option', { value: r.id, title: str(r.blurb) || null }, str(r.label) || r.id));
    els.mmRooms.replaceChildren(...nodes);
    els.mmRooms.value = '';
    setHidden(els.mmRooms, rooms.length === 0);
  }

  /** Office pixel size: the minimap keeps the same aspect ratio. */
  let worldW = 1024, worldH = 640;
  function setWorldSize(w, hgt) {
    const W = toNum(w), H = toNum(hgt);
    if (W > 0 && H > 0) {
      els.minimap.style.aspectRatio = W + ' / ' + H;
      worldW = W; worldH = H;
      scheduleInsets();
    }
  }

  let insetsQueued = false;
  let lastInsets = '';
  let lastHudTop = -1;
  let lastHudBottom = -1;
  function scheduleInsets() {
    if (insetsQueued || !initialized) return;
    insetsQueued = true;
    requestAnimationFrame(() => {
      insetsQueued = false;
      reportInsets();
    });
  }

  /** Screen margins covered by the HUD, so the camera centres the office in the free area. */
  function reportInsets() {
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (!vw || !vh) return;
    let top = 0;
    for (const node of [els.resBar, els.toolbar]) {
      if (!node || node.hidden) continue;
      const r = node.getBoundingClientRect();
      if (r.height > 0 && r.top < vh / 3) top = Math.max(top, r.bottom);
    }
    let bottomEdge = vh;
    const pr = els.party.getBoundingClientRect();
    if (pr.height > 0) bottomEdge = Math.min(bottomEdge, pr.top);
    let right = 0;
    if (!els.drawer.hidden) {
      const dr = els.drawer.getBoundingClientRect();
      if (isNarrow()) bottomEdge = Math.min(bottomEdge, dr.top);
      else if (dr.width > 0) right = Math.max(0, vw - dr.left);
    }
    // The open minimap sticks up above the team bar: keep the office clear of it, either by moving the free
    // area right of it or by raising the bottom edge, whichever leaves the office bigger at fit zoom.
    let left = 0;
    const mp = els.minimapPanel;
    if (mp && !mp.hidden) {
      const r = mp.getBoundingClientRect();
      if (isNarrow()) {
        // Phones: the minimap is stacked above the team bar.
        if (r.height > 0 && r.top < bottomEdge) bottomEdge = Math.min(bottomEdge, r.top);
      } else if (r.height > 0 && r.width > 0 && r.top < bottomEdge - 8) {
        const fit = (l, b) => Math.min((vw - l - right) / (worldW + 16), (vh - top - b) / (worldH + 16));
        const byLeft = fit(r.right + 6, vh - bottomEdge);
        const byBottom = fit(0, vh - r.top + 4);
        if (byLeft >= byBottom) left = r.right + 6;
        else bottomEdge = Math.min(bottomEdge, r.top);
      }
    }
    const hudTop = Math.round(top);
    if (hudTop !== lastHudTop) {
      lastHudTop = hudTop;
      document.documentElement.style.setProperty('--hud-top', hudTop + 'px');
    }
    const ins = { top: Math.round(top + 4), right: Math.round(right + (right ? 6 : 0)), bottom: Math.round(Math.max(0, vh - bottomEdge) + 4), left: Math.round(left) };
    const hudBottom = Math.round(Math.max(0, vh - (pr.height > 0 ? pr.top : vh)));
    if (hudBottom !== lastHudBottom) {
      lastHudBottom = hudBottom;
      document.documentElement.style.setProperty('--hud-bottom', hudBottom + 'px');
    }
    // Keep at least a small strip of office visible (bottom sheets cover most of a phone screen).
    const minFree = 90;
    if (vh - ins.top - ins.bottom < minFree) ins.bottom = Math.max(0, Math.round(vh - ins.top - minFree));
    const sig = ins.top + ',' + ins.right + ',' + ins.bottom + ',' + ins.left;
    if (sig === lastInsets) return;
    lastInsets = sig;
    try { cb.onInsets(ins); } catch (_) { /* camera only */ }
  }

  // ------------------------------------------------------------------ config

  function optionList(list, fallback) {
    const src = Array.isArray(list) && list.length ? list : fallback;
    return src.filter((o) => o && typeof o.value === 'string').map((o) => ({
      value: o.value,
      label: str(o.label) || o.value || 'Par défaut',
      danger: !!o.danger
    }));
  }

  function fillSelect(select, options, preferred) {
    const sig = JSON.stringify(options);
    const current = select.value;
    if (select.dataset.sig !== sig) {
      select.dataset.sig = sig;
      select.replaceChildren(...options.map((o) => {
        const opt = h('option', { value: o.value }, o.label);
        if (o.danger) opt.dataset.danger = '1';
        return opt;
      }));
    }
    const values = options.map((o) => o.value);
    if (current !== '' && values.includes(current)) select.value = current;
    else if (values.includes(current) && select.dataset.touched === '1') select.value = current;
    else if (values.includes(preferred)) select.value = preferred;
    else if (options.length) select.value = options[0].value;
  }

  /** Colour radio group (« A » = automatic, then the palette) inside `container`. */
  function buildSwatches(container, colors, radioName) {
    const list = (Array.isArray(colors) ? colors : []).filter((c) => typeof c === 'string' && HEX_RE.test(c));
    const palette = list.length ? list : DEFAULT_COLORS;
    const sig = palette.join(',');
    if (container.dataset.sig === sig) return;
    const checked = container.querySelector('input:checked');
    const previous = checked ? checked.value : 'auto';
    container.dataset.sig = sig;
    const nodes = [];
    nodes.push(h('label', { class: 'swatch swatch--auto', title: 'Couleur automatique' }, [
      h('input', { type: 'radio', name: radioName, value: 'auto' }),
      h('span', { class: 'swatch-chip', 'aria-hidden': 'true' }, 'A'),
      h('span', { class: 'sr-only' }, 'Automatique')
    ]));
    for (const c of palette) {
      const upper = c.toUpperCase();
      const label = COLOR_NAMES[upper] || 'Couleur ' + upper;
      const chip = h('span', { class: 'swatch-chip', 'aria-hidden': 'true' });
      chip.style.setProperty('--c', c);
      nodes.push(h('label', { class: 'swatch', title: label }, [
        h('input', { type: 'radio', name: radioName, value: c }),
        chip,
        h('span', { class: 'sr-only' }, label)
      ]));
    }
    container.replaceChildren(...nodes);
    const inputs = Array.from(container.querySelectorAll('input'));
    const keep = inputs.find((i) => i.value === previous) || inputs[0];
    if (keep) keep.checked = true;
  }

  function selectedColor(container) {
    const checked = (container || els.colors).querySelector('input:checked');
    return checked && checked.value !== 'auto' && HEX_RE.test(checked.value) ? checked.value : null;
  }

  function resetColor(container) {
    const auto = (container || els.colors).querySelector('input[value="auto"]');
    if (auto) auto.checked = true;
  }

  function permOptions() {
    return optionList(config && config.permissionModes, DEFAULT_PERMISSION_MODES);
  }

  function updatePermWarning() {
    const opt = permOptions().find((o) => o.value === els.perm.value);
    if (opt && opt.danger) {
      setText(els.permWarn, 'Attention : avec « ' + opt.label + ' », le pix peut exécuter n\'importe quelle commande et modifier ou supprimer tes fichiers sans rien demander. À réserver à un dossier de test.');
      setHidden(els.permWarn, false);
    } else {
      setHidden(els.permWarn, true);
    }
  }

  function setConfig(cfg) {
    config = cfg && typeof cfg === 'object' ? cfg : {};
    fillSelect(els.model, optionList(config.models, DEFAULT_MODELS), '');
    fillSelect(els.perm, permOptions(), 'default');
    fillSelect(els.effort, EFFORTS, '');
    buildSwatches(els.colors, config.colors, 'hq-color');
    buildSwatches(els.tColors, config.colors, 'hq-term-color');
    updatePermWarning();

    // Working directory (shared by the launcher and the terminal toolbar): remembered value first,
    // then the server default.
    if (!els.cwd.value.trim()) {
      const remembered = storageGet(STORE_KEYS.cwd);
      const def = str(config.defaultCwd);
      els.cwd.value = remembered && remembered.trim() ? remembered : def;
    }
    if (!els.tCwd.value.trim()) els.tCwd.value = els.cwd.value;
    if (config.defaultCwd) {
      els.cwd.placeholder = str(config.defaultCwd);
      els.tCwd.placeholder = str(config.defaultCwd);
    }

    setAttr(els.btnObserve, 'aria-pressed', config.observe ? 'true' : 'false');
    updateVersion();
    updateLaunchAvailability();
    updateTerminalTools();
    if (initialized) renderLibrary();
  }

  function launchAllowed() {
    return !config || config.claudeFound !== false;
  }

  function updateLaunchAvailability() {
    const allowed = launchAllowed();
    if (!allowed) {
      setText(els.formNote, 'Claude Code est introuvable sur cet ordinateur : impossible de lancer un pix.');
      setHidden(els.formNote, false);
      setAttr(els.submit, 'aria-disabled', 'true');
    } else {
      setHidden(els.formNote, true);
      if (!launching) setAttr(els.submit, 'aria-disabled', null);
    }
  }

  // ------------------------------------------------------------------ launcher

  function nextFreeName() {
    const used = new Set(agentsList().map((a) => str(a.name).toLowerCase()));
    for (let round = 1; round < 100; round++) {
      for (const n of NAME_POOL) {
        const candidate = round === 1 ? n : n + ' ' + round;
        if (!used.has(candidate.toLowerCase())) return candidate;
      }
    }
    return NAME_POOL[0];
  }

  function setFieldError(field, errNode, message) {
    field.classList.toggle('has-error', !!message);
    setText(errNode, message || '');
    setHidden(errNode, !message);
    const input = field.querySelector('input, textarea, select');
    if (input) setAttr(input, 'aria-invalid', message ? 'true' : null);
  }

  function setFormError(message) {
    setText(els.formErr, message || '');
    setHidden(els.formErr, !message);
  }

  function validateName(value) {
    const v = value.trim();
    if (!v) return '';
    if (v.length > 24) return 'Le nom doit faire 24 caractères maximum.';
    if (v.startsWith('-')) return 'Le nom ne doit pas commencer par un tiret.';
    if (!NAME_RE.test(v)) return 'Le nom ne peut contenir que des lettres, des chiffres, des espaces, des points, des tirets et des soulignés.';
    return '';
  }

  function validateCwd(value) {
    const v = value.trim();
    if (!v) return '';
    if (!ABS_PATH_RE.test(v)) return 'Indique un chemin absolu, par exemple C:\\Users\\toi\\projet.';
    return '';
  }

  function collectLaunch() {
    const prompt = els.prompt.value;
    const name = els.name.value.trim();
    const cwd = els.cwd.value.trim();
    const errors = {};
    if (!prompt.trim()) errors.prompt = 'Décris la mission du pix avant de le lancer.';
    else if (prompt.length > MAX_PROMPT) errors.prompt = 'La mission est trop longue (' + fmtInt(MAX_PROMPT) + ' caractères maximum, actuellement ' + fmtInt(prompt.length) + ').';
    const nameErr = validateName(name);
    if (nameErr) errors.name = nameErr;
    const cwdErr = validateCwd(cwd);
    if (cwdErr) errors.cwd = cwdErr;

    const payload = {
      prompt: prompt.trim(),
      model: els.model.value,
      permissionMode: els.perm.value || 'default',
      effort: els.effort.value
    };
    if (name) payload.name = name;
    const color = selectedColor();
    if (color) payload.color = color;
    if (cwd) payload.cwd = cwd;
    const profile = selectedProfile(els.profile);
    if (profile) payload.profile = profile;
    return { payload, errors };
  }

  function showLaunchErrors(errors) {
    setFieldError(els.fldPrompt, els.promptErr, errors.prompt);
    setFieldError(els.fldName, els.nameErr, errors.name);
    setFieldError(els.fldCwd, els.cwdErr, errors.cwd);
  }

  function setLaunching(on) {
    launching = on;
    setAttr(els.submit, 'aria-busy', on ? 'true' : null);
    setText(els.submitLabel, on ? 'Lancement…' : 'Lancer le pix');
    if (on) setAttr(els.submit, 'aria-disabled', 'true');
    else updateLaunchAvailability();
  }

  function submitLaunch() {
    if (launching) return;
    if (!launchAllowed()) {
      // The visible note under the prompt already explains why; just make sure it is seen.
      setFormError('');
      setHidden(els.formNote, false);
      return;
    }
    const { payload, errors } = collectLaunch();
    showLaunchErrors(errors);
    setFormError('');
    const firstInvalid = errors.prompt ? els.prompt : errors.name ? els.name : errors.cwd ? els.cwd : null;
    if (firstInvalid) {
      showDockTab('agent');
      firstInvalid.focus();
      return;
    }
    setLaunching(true);
    let p;
    try {
      p = Promise.resolve(cb.onLaunch(payload));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(() => {
      els.prompt.value = '';
      els.name.value = '';
      resetColor();
      if (payload.cwd) storageSet(STORE_KEYS.cwd, payload.cwd);
      showLaunchErrors({});
      updateNamePlaceholder();
    }).catch((err) => {
      setFormError(errMsg(err));
    }).finally(() => {
      setLaunching(false);
    });
  }

  function updateNamePlaceholder() {
    const next = nextFreeName();
    if (els.name.placeholder !== next) els.name.placeholder = next;
  }

  // ------------------------------------------------------------------ game windows (Nouveau pix, Terminal, Bibliothèque, Succès)
  // Draggable by the title bar, closable, brought to the front on focus, positions remembered.
  // Below 900 px they turn into bottom sheets (CSS) and only one is open at a time.

  function winRec(name) {
    return wins[name] || null;
  }

  function isOpen(name) {
    const w = winRec(name);
    return !!(w && w.open);
  }

  function windowsState(opened) {
    const s = { opened: opened || null };
    for (const n of WIN_NAMES) s[n] = isOpen(n);
    return s;
  }

  /** Compatibility with the old dock API: the « terminal tab » is visible when its window is open. */
  function dockState() {
    return { tab: isOpen('terminal') ? 'terminal' : 'agent', collapsed: !isOpen('terminal'), tall: false };
  }

  function notifyWindows(opened) {
    storageSet(STORE_KEYS.winsOpen, JSON.stringify(WIN_NAMES.filter(isOpen)));
    try {
      cb.onWindowsChange(windowsState(opened));
    } catch (err) {
      console.error('[HQUI] onWindowsChange a échoué.', err);
    }
  }

  function viewport() {
    return { w: Math.max(320, window.innerWidth || 1024), h: Math.max(320, window.innerHeight || 768) };
  }

  function defaultGeom(name) {
    const v = viewport();
    const top = Math.max(64, (lastHudTop > 0 ? lastHudTop : 60) + 12);
    // A window opening while the character sheet is shown starts left of it (the sheet stays readable).
    if (!isNarrow() && els.drawer && !els.drawer.hidden) {
      const dl = els.drawer.getBoundingClientRect().left;
      if (dl > 560) v.w = Math.round(dl - 4);
    }
    switch (name) {
      case 'terminal': {
        const w = Math.min(1000, v.w - 48);
        return { x: Math.round((v.w - w) / 2), y: top, w, h: Math.max(300, Math.min(580, v.h - top - 150)) };
      }
      case 'library': {
        const w = Math.min(720, v.w - 48);
        return { x: Math.max(16, v.w - w - 24), y: top, w, h: 0 };
      }
      case 'achievements': {
        const w = Math.min(600, v.w - 48);
        return { x: Math.round((v.w - w) / 2), y: top + 14, w, h: 0 };
      }
      default: {
        const w = Math.min(660, v.w - 32);
        return { x: 16, y: top, w, h: 0 };
      }
    }
  }

  function loadGeom(name) {
    try {
      const raw = storageGet(STORE_KEYS.winPrefix + name);
      if (!raw) return null;
      const g = JSON.parse(raw);
      if (!g || typeof g !== 'object') return null;
      const out = { x: toNum(g.x), y: toNum(g.y), w: toNum(g.w), h: toNum(g.h) };
      return out.w > 0 ? out : null;
    } catch (_) {
      return null;
    }
  }

  function saveGeom(rec) {
    rec.placed = true;
    storageSet(STORE_KEYS.winPrefix + rec.name, JSON.stringify({ x: Math.round(rec.x), y: Math.round(rec.y), w: Math.round(rec.w), h: Math.round(rec.h) }));
  }

  /** Keeps the window inside the viewport (its title bar always reachable). */
  function clampGeom(rec) {
    const v = viewport();
    rec.w = Math.max(320, Math.min(rec.w, v.w - 16));
    if (rec.resizable) rec.h = Math.max(260, Math.min(rec.h || 480, v.h - 16));
    rec.x = Math.max(8, Math.min(rec.x, v.w - rec.w - 8));
    rec.y = Math.max(8, Math.min(rec.y, v.h - 64));
    if (rec.resizable && rec.y + rec.h > v.h - 8) rec.y = Math.max(8, v.h - 8 - rec.h);
  }

  function applyGeom(rec) {
    const el = rec.el;
    if (isNarrow()) {
      el.style.left = el.style.top = el.style.width = el.style.height = el.style.maxHeight = '';
      return;
    }
    clampGeom(rec);
    el.style.left = Math.round(rec.x) + 'px';
    el.style.top = Math.round(rec.y) + 'px';
    el.style.width = Math.round(rec.w) + 'px';
    if (rec.resizable) {
      el.style.height = Math.round(rec.h) + 'px';
      el.style.maxHeight = '';
    } else {
      el.style.height = '';
      el.style.maxHeight = Math.max(220, viewport().h - Math.round(rec.y) - 12) + 'px';
    }
  }

  function focusWindow(name) {
    const rec = winRec(name);
    if (!rec) return;
    if (rec.el.style.zIndex !== String(zTop)) {
      zTop += 1;
      if (zTop > 60) {
        // Keep windows under the toasts (z 70): renumber them in their current stacking order.
        const order = WIN_NAMES.map((n) => wins[n]).filter((r) => r && r !== rec)
          .sort((a, b) => (Number(a.el.style.zIndex) || 0) - (Number(b.el.style.zIndex) || 0));
        zTop = 41;
        for (const r of order) r.el.style.zIndex = String(zTop++);
      }
      rec.el.style.zIndex = String(zTop);
    }
    for (const n of WIN_NAMES) {
      const r = wins[n];
      if (r) r.el.classList.toggle('is-front', r === rec);
    }
  }

  function focusInside(rec) {
    let target = null;
    if (rec.name === 'agent') target = els.prompt;
    else if (rec.name === 'library') target = !els.libForm.hidden ? els.libUrl : null;
    if (!target) target = rec.el.querySelector('.win-close');
    try {
      if (target) target.focus({ preventScroll: true });
    } catch (_) {
      /* focus is best effort */
    }
  }

  /** Opens a game window. opts: { focus?: boolean (default true), quiet?: boolean }. */
  function openWindow(name, opts) {
    const rec = winRec(name);
    if (!rec) return false;
    const o = opts || {};
    if (isNarrow()) {
      for (const n of WIN_NAMES) if (n !== name && isOpen(n)) closeWindow(n, { quiet: true, keepFocus: true });
    }
    const wasOpen = rec.open;
    if (!wasOpen && !rec.placed && !isNarrow()) {
      const g = defaultGeom(name);
      rec.x = g.x; rec.y = g.y; rec.w = g.w;
      if (rec.resizable && g.h) rec.h = g.h;
    }
    rec.open = true;
    setHidden(rec.el, false);
    applyGeom(rec);
    focusWindow(name);
    setAttr(rec.btn, 'aria-pressed', 'true');
    if (o.focus !== false) focusInside(rec);
    if (!wasOpen || !o.quiet) notifyWindows(o.focus === false ? null : name);
    if (name === 'achievements') renderAchievements();
    return true;
  }

  function closeWindow(name, opts) {
    const rec = winRec(name);
    if (!rec || !rec.open) return false;
    const o = opts || {};
    const hadFocus = rec.el.contains(document.activeElement);
    rec.open = false;
    setHidden(rec.el, true);
    setAttr(rec.btn, 'aria-pressed', 'false');
    if (hadFocus && !o.keepFocus) {
      try { rec.btn.focus({ preventScroll: true }); } catch (_) { /* best effort */ }
    }
    notifyWindows(null);
    return true;
  }

  function toggleWindow(name) {
    const rec = winRec(name);
    if (!rec) return;
    if (rec.open && rec.el.classList.contains('is-front')) closeWindow(name);
    else openWindow(name);
  }

  /** Old dock API: « agent » / « terminal » / « library » → the matching window. */
  function showDockTab(tab, opts) {
    const name = tab === 'terminal' || tab === 'library' || tab === 'achievements' ? tab : 'agent';
    openWindow(name, { focus: !!(opts && opts.focusTab) || name === 'agent' });
  }

  function startDrag(rec, e) {
    if (isNarrow() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.target.closest('button, a, input, select, textarea, label')) return;
    e.preventDefault();
    focusWindow(rec.name);
    const head = e.currentTarget;
    const sx = e.clientX, sy = e.clientY, x0 = rec.x, y0 = rec.y;
    rec.el.classList.add('is-dragging');
    try { head.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const move = (ev) => {
      rec.x = x0 + ev.clientX - sx;
      rec.y = y0 + ev.clientY - sy;
      applyGeom(rec);
    };
    const up = (ev) => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      try { head.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
      rec.el.classList.remove('is-dragging');
      saveGeom(rec);
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  }

  function startResize(rec, e) {
    if (isNarrow() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    e.preventDefault();
    e.stopPropagation();
    focusWindow(rec.name);
    const grip = e.currentTarget;
    const sx = e.clientX, sy = e.clientY, w0 = rec.w, h0 = rec.h || rec.el.offsetHeight;
    rec.el.classList.add('is-resizing');
    try { grip.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const move = (ev) => {
      rec.w = w0 + ev.clientX - sx;
      rec.h = h0 + ev.clientY - sy;
      applyGeom(rec);
    };
    const up = (ev) => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      try { grip.releasePointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
      rec.el.classList.remove('is-resizing');
      saveGeom(rec);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  function setupWindows() {
    try {
      narrowMq = window.matchMedia ? window.matchMedia(NARROW_QUERY) : null;
    } catch (_) {
      narrowMq = null;
    }
    for (const name of WIN_NAMES) {
      const def = WIN_DEFS[name];
      const el = byId(def.id);
      const btn = byId(def.btn);
      const saved = loadGeom(name);
      const g = saved || defaultGeom(name);
      // placed: the user moved / resized it once (saved). Until then the default spot is recomputed at each opening.
      const rec = { name, el, btn, open: false, placed: !!saved, resizable: def.resizable, x: g.x, y: g.y, w: g.w, h: g.h || 0 };
      if (rec.resizable && !rec.h) rec.h = defaultGeom(name).h;
      wins[name] = rec;
      const head = el.querySelector('[data-drag]');
      if (head) head.addEventListener('pointerdown', (e) => startDrag(rec, e));
      const grip = el.querySelector('[data-resize]');
      if (grip) grip.addEventListener('pointerdown', (e) => startResize(rec, e));
      for (const close of el.querySelectorAll('[data-close]')) close.addEventListener('click', () => closeWindow(name));
      el.addEventListener('pointerdown', () => focusWindow(name), true);
      el.addEventListener('focusin', () => focusWindow(name));
    }
    window.addEventListener('resize', () => {
      for (const name of WIN_NAMES) if (isOpen(name)) applyGeom(wins[name]);
      scheduleInsets();
    });
    const onMode = () => {
      const open = WIN_NAMES.filter(isOpen);
      if (isNarrow() && open.length > 1) {
        for (const n of open.slice(0, -1)) closeWindow(n, { quiet: true, keepFocus: true });
      }
      for (const name of WIN_NAMES) if (isOpen(name)) applyGeom(wins[name]);
      scheduleInsets();
    };
    if (narrowMq) {
      if (typeof narrowMq.addEventListener === 'function') narrowMq.addEventListener('change', onMode);
      else if (typeof narrowMq.addListener === 'function') narrowMq.addListener(onMode);
    }
    // Windows that were open last time come back (without stealing the focus).
    let reopen = [];
    try {
      const raw = JSON.parse(storageGet(STORE_KEYS.winsOpen) || '[]');
      reopen = Array.isArray(raw) ? raw.filter((n) => WIN_NAMES.includes(n)) : [];
    } catch (_) {
      reopen = [];
    }
    if (isNarrow()) reopen = reopen.slice(-1);
    for (const n of reopen) openWindow(n, { focus: false, quiet: true });
  }

  function focusLauncher() {
    openWindow('agent', { focus: false });
    try {
      els.prompt.focus({ preventScroll: true });
    } catch (_) {
      els.prompt.focus();
    }
  }

  // ------------------------------------------------------------------ launcher form bindings

  function bindLauncher() {
    els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitLaunch();
    });
    els.form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitLaunch();
      }
    });
    els.prompt.addEventListener('input', () => {
      if (els.fldPrompt.classList.contains('has-error') && els.prompt.value.trim()) setFieldError(els.fldPrompt, els.promptErr, '');
      setFormError('');
    });
    els.name.addEventListener('input', () => {
      setFieldError(els.fldName, els.nameErr, validateName(els.name.value));
    });
    els.cwd.addEventListener('input', () => {
      if (els.tCwd.value !== els.cwd.value) els.tCwd.value = els.cwd.value;
      if (els.fldCwd.classList.contains('has-error')) setFieldError(els.fldCwd, els.cwdErr, validateCwd(els.cwd.value));
    });
    els.cwd.addEventListener('change', () => {
      const v = els.cwd.value.trim();
      const err = validateCwd(v);
      setFieldError(els.fldCwd, els.cwdErr, err);
      if (v && !err) storageSet(STORE_KEYS.cwd, v);
    });
    els.perm.addEventListener('change', () => {
      els.perm.dataset.touched = '1';
      updatePermWarning();
    });
    els.model.addEventListener('change', () => { els.model.dataset.touched = '1'; });
    els.effort.addEventListener('change', () => { els.effort.dataset.touched = '1'; });

    els.stageWrite.addEventListener('click', focusLauncher);
    els.stageTerm.addEventListener('click', () => openWindow('terminal'));

    const skip = document.querySelector('.skip-link');
    if (skip) {
      skip.addEventListener('click', (e) => {
        e.preventDefault();
        focusLauncher();
      });
    }
  }

  // ------------------------------------------------------------------ terminal toolbar

  function setTermError(message, field) {
    setText(els.tError, message || '');
    setHidden(els.tError, !message);
    for (const f of [els.fldTCwd, els.fldTName]) {
      const bad = !!message && f === field;
      f.classList.toggle('has-error', bad);
      const input = f.querySelector('input');
      if (input) setAttr(input, 'aria-invalid', bad ? 'true' : null);
    }
  }

  function terminalsList() {
    try {
      const it = cb.getTerminals();
      return it ? Array.from(it).filter((t) => t && typeof t.id === 'string') : [];
    } catch (_) {
      return [];
    }
  }

  function updateTerminalTools() {
    const claudeMissing = !!config && config.claudeFound === false;
    for (const btn of [els.tClaude, els.tEmptyClaude]) {
      if (!termCreating) setAttr(btn, 'aria-disabled', claudeMissing ? 'true' : null);
      setAttr(btn, 'title', claudeMissing
        ? 'Claude Code est introuvable sur cet ordinateur : ouvre un terminal simple à la place.'
        : 'Ouvrir un terminal et y lancer Claude Code');
    }
  }

  /** Shows the terminal tools, or the French reason why the integrated terminal is unavailable. */
  function setTerminalSupport(s) {
    termSupport = s && typeof s === 'object' ? s : { supported: false, ready: false, reason: '' };
    const ok = termSupport.supported === true;
    els.winTerm.dataset.term = ok ? 'on' : 'off';
    setHidden(els.termMain, !ok);
    setHidden(els.termUnsupported, ok);
    if (!ok) {
      els.termUnsupported.dataset.state = termSupport.ready ? 'unsupported' : 'loading';
      setText(els.termUnsupportedTitle, termSupport.ready ? 'Terminal intégré indisponible' : 'Terminal intégré');
      setText(els.termUnsupportedReason, str(termSupport.reason) || 'Connexion au serveur PixelQG…');
    }
    setAttr(els.tbTerm, 'data-tip', ok ? 'Terminal : tape claude pour lancer une session liée au bureau' : 'Terminal');
    terminalsChanged();
  }

  function collectTerminal(launchClaude) {
    const cwd = els.tCwd.value.trim();
    const name = els.tName.value.trim();
    const cwdErr = validateCwd(cwd);
    if (cwdErr) return { error: cwdErr, field: els.fldTCwd };
    const nameErr = validateName(name);
    if (nameErr) return { error: nameErr, field: els.fldTName };
    const payload = { launchClaude: !!launchClaude };
    if (cwd) payload.cwd = cwd;
    if (name) payload.name = name;
    const color = selectedColor(els.tColors);
    if (color) payload.color = color;
    const profile = selectedProfile(els.tProfile);
    if (profile) payload.profile = profile;
    return { payload };
  }

  function submitTerminal(launchClaude, btn) {
    if (termCreating || termSupport.supported !== true) return;
    if (launchClaude && config && config.claudeFound === false) {
      setTermError('Claude Code est introuvable sur cet ordinateur : ouvre un « Nouveau terminal » et installe-le, ou indique son chemin dans CLAUDE_BIN.');
      return;
    }
    const { payload, error, field } = collectTerminal(launchClaude);
    if (error) {
      setTermError(error, field);
      const input = field && field.querySelector('input');
      if (input) input.focus();
      return;
    }
    setTermError('');
    termCreating = true;
    const label = btn.querySelector('[data-label]') || btn;
    const previous = label.textContent;
    label.textContent = launchClaude ? 'Lancement…' : 'Ouverture…';
    const buttons = [els.tNew, els.tClaude, els.tEmptyNew, els.tEmptyClaude];
    for (const b of buttons) setAttr(b, 'aria-disabled', 'true');
    setAttr(btn, 'aria-busy', 'true');
    let p;
    try {
      p = Promise.resolve(cb.onCreateTerminal(payload));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(() => {
      els.tName.value = '';
      resetColor(els.tColors);
      if (payload.cwd) storageSet(STORE_KEYS.cwd, payload.cwd);
    }).catch((err) => {
      setTermError(errMsg(err));
    }).finally(() => {
      termCreating = false;
      label.textContent = previous;
      setAttr(btn, 'aria-busy', null);
      for (const b of buttons) setAttr(b, 'aria-disabled', null);
      updateTerminalTools();
    });
  }

  function bindTerminalTools() {
    els.termTools.addEventListener('submit', (e) => {
      e.preventDefault();
      submitTerminal(true, els.tClaude);
    });
    els.tNew.addEventListener('click', () => submitTerminal(false, els.tNew));
    els.tEmptyClaude.addEventListener('click', () => submitTerminal(true, els.tEmptyClaude));
    els.tEmptyNew.addEventListener('click', () => submitTerminal(false, els.tEmptyNew));
    els.tCwd.addEventListener('input', () => {
      if (els.cwd.value !== els.tCwd.value) els.cwd.value = els.tCwd.value;
      if (els.fldTCwd.classList.contains('has-error')) setTermError(validateCwd(els.tCwd.value), els.fldTCwd);
      if (els.fldCwd.classList.contains('has-error')) setFieldError(els.fldCwd, els.cwdErr, validateCwd(els.cwd.value));
    });
    els.tCwd.addEventListener('change', () => {
      const v = els.tCwd.value.trim();
      const err = validateCwd(v);
      setTermError(err, els.fldTCwd);
      if (v && !err) storageSet(STORE_KEYS.cwd, v);
    });
    els.tName.addEventListener('input', () => {
      const err = validateName(els.tName.value);
      if (err || els.fldTName.classList.contains('has-error')) setTermError(err, els.fldTName);
    });
  }

  /** Terminal list changed (main.js): dock badge + the drawer's « Voir son terminal » button. */
  function terminalsChanged() {
    if (!initialized) return;
    const running = termSupport.supported ? terminalsList().filter((t) => t.status === 'running').length : 0;
    setText(els.dockTermCount, String(running));
    setHidden(els.dockTermCount, running === 0);
    setAttr(els.dockTermCount, 'aria-label', running ? (running > 1 ? running + ' terminaux ouverts' : '1 terminal ouvert') : null);
    scheduleRender();
  }

  // ------------------------------------------------------------------ library (linked GitHub repos) + profiles

  const LIB_SUGGESTIONS = ['anthropics/skills', 'wshobson/agents', 'VoltAgent/awesome-claude-code-subagents'];
  const LIB_STATUS_LABEL = { cloning: 'Clonage…', updating: 'Mise à jour…', ready: 'Prêt', error: 'Erreur' };
  const LIB_TYPES = [
    { type: 'skill', label: 'Skills' },
    { type: 'agent', label: 'Agents' },
    { type: 'command', label: 'Commandes' }
  ];
  const LIB_INPUT_RE = /^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/|git@github\.com:)?[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}(?:\.git)?(?:\/\S*)?$/;
  const LIB_INVALID = 'Lien GitHub invalide. Exemple : anthropics/skills ou https://github.com/anthropics/skills';

  let library = null;            // Library object from the server (null until known)
  let libUnavailable = '';       // French reason when this server has no library
  let libLinking = false;
  let libEmptyDefault = '';
  const libCards = new Map();    // repo id → card record (see createLibCard)
  const profilePrefs = {};       // store key → chosen profile value ('' = Claude Code standard)
  profilePrefs[STORE_KEYS.profile] = storageGet(STORE_KEYS.profile) || '';
  profilePrefs[STORE_KEYS.termProfile] = storageGet(STORE_KEYS.termProfile) || '';

  function libRepos() {
    return library && Array.isArray(library.repos) ? library.repos.filter((r) => r && typeof r.id === 'string' && r.id) : [];
  }

  function libRepoById(id) {
    return libRepos().find((r) => r.id === id);
  }

  function libProfiles() {
    return library && Array.isArray(library.profiles)
      ? library.profiles.filter((p) => p && typeof p.value === 'string' && p.value)
      : [];
  }

  function gitFound() {
    if (library && typeof library.gitFound === 'boolean') return library.gitFound;
    const c = config && config.library;
    return !(c && c.gitFound === false);
  }

  function repoName(r) {
    const owner = str(r && r.owner);
    const name = str(r && r.repo);
    return owner && name ? owner + '/' + name : str(r && r.id);
  }

  function repoUrl(r) {
    const u = str(r && r.url);
    if (/^https:\/\/github\.com\//i.test(u)) return u;
    const owner = str(r && r.owner);
    const name = str(r && r.repo);
    return owner && name ? 'https://github.com/' + encodeURIComponent(owner) + '/' + encodeURIComponent(name) : null;
  }

  function plural(n, one, many) {
    return fmtInt(n) + ' ' + (n > 1 ? many : one);
  }

  /** « 17 skills · 3 agents · 2 commandes » (« 12/17 skills » when some are switched off). */
  function libCountsText(r) {
    const c = (r && r.counts) || {};
    const parts = [];
    const add = (total, enabled, one, many) => {
      const t = Math.max(0, Math.round(toNum(total)));
      if (!t) return;
      const partial = enabled !== undefined && enabled !== null && Math.round(toNum(enabled)) < t;
      parts.push(partial ? fmtInt(Math.max(0, Math.round(toNum(enabled)))) + '/' + plural(t, one, many) : plural(t, one, many));
    };
    add(c.skills, c.enabledSkills, 'skill', 'skills');
    add(c.agents, c.enabledAgents, 'agent', 'agents');
    add(c.commands, c.enabledCommands, 'commande', 'commandes');
    return parts.join(' · ');
  }

  function fmtWhen(v) {
    const d = new Date(typeof v === 'number' ? v : str(v));
    const t = d.getTime();
    if (!Number.isFinite(t) || t <= 0) return '';
    return 'le ' + dayFmt.format(d) + ' à ' + clockFmt.format(d).slice(0, 5);
  }

  // ---- « Profil » selects (launcher + terminal toolbar)

  /** The chosen library agent, or '' for « Claude Code standard » (also when it no longer exists). */
  function selectedProfile(select) {
    const v = select && select.value;
    return v && libProfiles().some((p) => p.value === v) ? v : '';
  }

  function fillProfileSelect(select, storeKey) {
    const profiles = libProfiles();
    const sig = JSON.stringify(profiles.map((p) => [p.value, p.label, p.repo, p.description]));
    if (select.dataset.sig !== sig) {
      select.dataset.sig = sig;
      const nodes = [h('option', { value: '' }, 'Claude Code standard')];
      const groups = new Map();
      for (const p of profiles) {
        const key = str(p.repo) || 'Bibliothèque';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(p);
      }
      for (const [repo, list] of groups) {
        const og = h('optgroup', { label: repo });
        for (const p of list) {
          og.append(h('option', { value: p.value, title: str(p.description) || null }, str(p.label) || profileShort(p.value)));
        }
        nodes.push(og);
      }
      select.replaceChildren(...nodes);
    }
    const wanted = profilePrefs[storeKey] || '';
    const next = profiles.some((p) => p.value === wanted) ? wanted : '';
    if (select.value !== next) select.value = next;
    const cur = profiles.find((p) => p.value === next) || null;
    setAttr(select, 'title', cur
      ? (str(cur.description) || cur.value)
      : (profiles.length
        ? 'Claude Code sans agent particulier (les skills de la bibliothèque restent disponibles)'
        : 'Lie un dépôt dans l\'onglet « Bibliothèque » pour lancer Claude Code avec un agent spécialisé'));
    return cur;
  }

  function updateProfileSelects() {
    const cur = fillProfileSelect(els.profile, STORE_KEYS.profile);
    const desc = cur ? truncate(str(cur.description).trim(), 180) : '';
    setText(els.profileDesc, desc);
    setHidden(els.profileDesc, !desc);
    fillProfileSelect(els.tProfile, STORE_KEYS.termProfile);
  }

  // ---- link form

  function setLibError(message) {
    setText(els.libError, message || '');
    setHidden(els.libError, !message);
    els.fldLibUrl.classList.toggle('has-error', !!message);
    setAttr(els.libUrl, 'aria-invalid', message ? 'true' : null);
  }

  function submitLibraryLink() {
    if (libLinking) return;
    const v = els.libUrl.value.trim();
    if (!v || !LIB_INPUT_RE.test(v)) {
      setLibError(v ? LIB_INVALID : 'Colle le lien d\'un dépôt GitHub, par exemple anthropics/skills.');
      els.libUrl.focus();
      return;
    }
    setLibError('');
    libLinking = true;
    const label = els.libSubmit.querySelector('[data-label]') || els.libSubmit;
    label.textContent = 'Liaison…';
    setAttr(els.libSubmit, 'aria-busy', 'true');
    setAttr(els.libSubmit, 'aria-disabled', 'true');
    let p;
    try {
      p = Promise.resolve(cb.onLibraryLink(v));
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(() => {
      els.libUrl.value = '';
    }).catch((err) => {
      setLibError(errMsg(err));
      try {
        els.libUrl.focus();
      } catch (_) {
        /* ignore */
      }
    }).finally(() => {
      libLinking = false;
      label.textContent = 'Lier le dépôt';
      setAttr(els.libSubmit, 'aria-busy', null);
      setAttr(els.libSubmit, 'aria-disabled', null);
    });
  }

  function buildSuggestions() {
    for (const value of LIB_SUGGESTIONS) {
      const b = h('button', { type: 'button', class: 'lib-chip mono', 'data-value': value }, value);
      b.addEventListener('click', () => {
        els.libUrl.value = value;
        setLibError('');
        els.libUrl.focus();
      });
      els.libSuggest.append(b);
    }
  }

  function updateSuggestions() {
    const linked = new Set(libRepos().map((r) => repoName(r).toLowerCase()));
    for (const b of els.libSuggest.querySelectorAll('.lib-chip')) {
      const on = linked.has(str(b.dataset.value).toLowerCase());
      b.classList.toggle('is-linked', on);
      setAttr(b, 'title', on ? 'Déjà lié' : 'Remplir le champ avec ce dépôt');
    }
  }

  // ---- repo cards

  function libCall(fn) {
    try {
      return Promise.resolve(fn());
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function createLibCard(id) {
    const rec = { id, expanded: false, filter: '', itemsSig: '', warnSig: '', confirmTimer: 0 };
    rec.link = h('a', { class: 'lib-repo', target: '_blank', rel: 'noopener noreferrer' });
    rec.where = h('span', { class: 'lib-where', hidden: true });
    rec.progress = h('span', { class: 'lib-progress', 'aria-hidden': 'true', hidden: true });
    rec.statusText = h('span', { class: 'lib-status-text' });
    rec.status = h('span', { class: 'lib-status' }, [rec.progress, rec.statusText]);
    rec.switchInput = h('input', { type: 'checkbox', role: 'switch', class: 'switch-input' });
    rec.switchText = h('span', { class: 'switch-text' });
    rec.sw = h('label', { class: 'switch' }, [rec.switchInput, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), rec.switchText]);
    rec.counts = h('span', { class: 'lib-counts' });
    rec.commit = h('code', { class: 'lib-commit', hidden: true });
    rec.error = h('p', { class: 'lib-card-err', role: 'alert', hidden: true });
    rec.warnings = h('ul', { class: 'lib-warnings', hidden: true });
    rec.btnItems = h('button', { type: 'button', class: 'btn btn-ghost btn-sm lib-btn-items', 'aria-expanded': 'false' }, [
      h('span', { class: 'lib-caret', 'aria-hidden': 'true' }),
      h('span', { 'data-label': '' }, 'Contenu')
    ]);
    rec.btnUpdate = h('button', { type: 'button', class: 'btn btn-sm' }, h('span', { 'data-label': '' }, 'Mettre à jour'));
    rec.btnRemove = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Retirer');
    rec.confirmYes = h('button', { type: 'button', class: 'btn btn-danger btn-sm' }, h('span', { 'data-label': '' }, 'Oui, retirer'));
    rec.confirmNo = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Annuler');
    rec.confirm = h('div', { class: 'confirm-box lib-confirm', role: 'group', 'aria-label': 'Confirmer le retrait du dépôt', hidden: true }, [
      h('span', { class: 'confirm-q' }, 'Retirer ce dépôt ? Ses skills et agents ne seront plus proposés.'),
      rec.confirmYes,
      rec.confirmNo
    ]);
    rec.actions = h('div', { class: 'lib-actions' }, [rec.btnItems, h('span', { class: 'foot-spacer' }), rec.btnUpdate, rec.btnRemove]);
    rec.search = h('input', {
      type: 'search', class: 'input lib-search', placeholder: 'Filtrer par nom ou description…',
      spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Filtrer le contenu du dépôt'
    });
    rec.itemsList = h('div', { class: 'lib-items-list' });
    rec.items = h('div', { class: 'lib-items', hidden: true }, [rec.search, rec.itemsList]);
    rec.li = h('li', { class: 'lib-card' }, [
      h('div', { class: 'lib-card-head' }, [h('div', { class: 'lib-title' }, [rec.link, rec.where]), rec.status, rec.sw]),
      h('div', { class: 'lib-meta' }, [rec.counts, rec.commit]),
      rec.error,
      rec.warnings,
      rec.actions,
      rec.confirm,
      rec.items
    ]);

    rec.switchInput.addEventListener('change', () => {
      const enabled = rec.switchInput.checked;
      libCall(() => cb.onLibraryToggle(id, { enabled })).catch((err) => {
        rec.switchInput.checked = !enabled;
        toast(errMsg(err), 'err');
      });
    });
    rec.btnItems.addEventListener('click', () => {
      if (rec.btnItems.getAttribute('aria-disabled') === 'true') return;
      rec.expanded = !rec.expanded;
      updateLibCard(rec, libRepoById(id));
    });
    rec.btnUpdate.addEventListener('click', () => {
      if (rec.btnUpdate.getAttribute('aria-disabled') === 'true') return;
      runBusy(rec.btnUpdate, () => cb.onLibraryUpdate(id), 'Mise à jour…');
    });
    rec.btnRemove.addEventListener('click', () => openLibConfirm(rec));
    rec.confirmNo.addEventListener('click', () => closeLibConfirm(rec, true));
    rec.confirmYes.addEventListener('click', () => {
      clearTimeout(rec.confirmTimer);
      runBusy(rec.confirmYes, () => cb.onLibraryRemove(id), 'Retrait…').then((ok) => {
        if (ok === false) closeLibConfirm(rec, true);
      });
    });
    rec.itemsList.addEventListener('change', (e) => {
      const input = e.target;
      if (!input || input.type !== 'checkbox' || !input.dataset || !input.dataset.key) return;
      const key = input.dataset.key;
      const enabled = input.checked;
      libCall(() => cb.onLibraryToggle(id, { key, enabled })).catch((err) => {
        input.checked = !enabled;
        toast(errMsg(err), 'err');
      });
    });
    rec.search.addEventListener('input', () => {
      rec.filter = rec.search.value;
      renderLibItems(rec, libRepoById(id));
    });
    return rec;
  }

  function openLibConfirm(rec) {
    closeLibConfirm(null, false);
    setHidden(rec.actions, true);
    setHidden(rec.confirm, false);
    rec.confirmNo.focus();
    clearTimeout(rec.confirmTimer);
    rec.confirmTimer = setTimeout(() => closeLibConfirm(rec, false), CONFIRM_TIMEOUT * 2);
  }

  /** Closes the in-page « Retirer ce dépôt ? » confirmation(s). Returns true when one was open. */
  function closeLibConfirm(target, focusBack) {
    let closed = false;
    for (const rec of target ? [target] : Array.from(libCards.values())) {
      if (rec.confirm.hidden || isBusy(rec.confirmYes)) continue;
      const hadFocus = rec.confirm.contains(document.activeElement);
      clearTimeout(rec.confirmTimer);
      setHidden(rec.confirm, true);
      setHidden(rec.actions, false);
      if (focusBack !== false && (hadFocus || focusBack === true)) rec.btnRemove.focus();
      closed = true;
    }
    return closed;
  }

  function libItemRow(it) {
    const input = h('input', { type: 'checkbox', class: 'lib-check' });
    input.dataset.key = it.key;
    input.checked = it.enabled !== false;
    const desc = str(it.description).trim();
    const extra = [];
    if (it.model) extra.push(h('span', { class: 'chip', title: 'Modèle de l\'agent' }, str(it.model)));
    if (it.tools) extra.push(h('span', { class: 'chip lib-tools', title: 'Outils : ' + str(it.tools) }, truncate(str(it.tools), 36)));
    return h('li', { class: 'lib-item' }, [
      h('label', { class: 'lib-item-row', title: str(it.fullName) || null }, [
        input,
        h('span', { class: 'lib-item-name' }, str(it.name) || it.key)
      ].concat(extra)),
      desc ? h('p', { class: 'lib-item-desc', title: desc.length > 220 ? desc : null }, truncate(desc, 220)) : null
    ]);
  }

  /** Item list grouped by type, then by plugin group. Rebuilt only when the content or the filter changes. */
  function renderLibItems(rec, r) {
    if (!rec.expanded || !r) return;
    const items = Array.isArray(r.items) ? r.items.filter((it) => it && typeof it.key === 'string') : [];
    const sig = items.length + '|' + items.map((it) => it.key + '\u0001' + str(it.description).length + '\u0001' + str(it.group)).join('\u0002')
      + '#' + rec.filter;
    if (sig === rec.itemsSig) {
      const byKey = new Map(items.map((it) => [it.key, it]));
      for (const input of rec.itemsList.querySelectorAll('input[data-key]')) {
        const it = byKey.get(input.dataset.key);
        if (it && input.checked !== (it.enabled !== false)) input.checked = it.enabled !== false;
      }
      for (const T of LIB_TYPES) {
        const node = rec.itemsList.querySelector('[data-type-count="' + T.type + '"]');
        if (node) setText(node, typeCount(items, T.type));
      }
      return;
    }
    rec.itemsSig = sig;
    const active = document.activeElement;
    const activeKey = active && rec.itemsList.contains(active) && active.dataset ? active.dataset.key : null;
    const q = rec.filter.trim().toLowerCase();
    const match = (it) => !q || [it.name, it.fullName, it.description, it.group].some((v) => str(v).toLowerCase().includes(q));
    const nodes = [];
    for (const T of LIB_TYPES) {
      const all = items.filter((it) => it.type === T.type);
      const shown = all.filter(match);
      if (!shown.length) continue;
      const count = h('span', { class: 'num lib-type-count', 'data-type-count': T.type }, typeCount(items, T.type));
      const section = h('section', { class: 'lib-type' }, [h('h4', { class: 'lib-type-title' }, [T.label + ' ', count])]);
      if (T.type === 'agent') {
        section.append(h('p', { class: 'lib-type-hint' }, 'Choisis un agent dans « Profil » (Nouveau pix ou Terminal) pour lancer Claude Code avec lui.'));
      }
      const groups = new Map();
      for (const it of shown) {
        const g = str(it.group);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(it);
      }
      const keys = Array.from(groups.keys()).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b, 'fr')));
      for (const g of keys) {
        if (g) section.append(h('h5', { class: 'lib-group-title' }, g));
        section.append(h('ul', { class: 'lib-item-list' }, groups.get(g).map(libItemRow)));
      }
      nodes.push(section);
    }
    if (!nodes.length) {
      nodes.push(h('p', { class: 'lib-items-empty' }, items.length
        ? 'Rien ne correspond à « ' + rec.filter.trim() + ' ».'
        : 'Aucun skill, agent ni commande trouvé dans ce dépôt.'));
    }
    rec.itemsList.replaceChildren(...nodes);
    if (activeKey && window.CSS && typeof window.CSS.escape === 'function') {
      const again = rec.itemsList.querySelector('input[data-key="' + window.CSS.escape(activeKey) + '"]');
      if (again) again.focus();
    }
  }

  function typeCount(items, type) {
    const all = items.filter((it) => it.type === type);
    const on = all.filter((it) => it.enabled !== false).length;
    return on < all.length ? fmtInt(on) + '/' + fmtInt(all.length) : fmtInt(all.length);
  }

  function updateLibCard(rec, r) {
    if (!r) return;
    const status = LIB_STATUS_LABEL[r.status] ? r.status : 'error';
    const busy = status === 'cloning' || status === 'updating';
    const enabled = r.enabled !== false;
    rec.li.dataset.status = status;
    rec.li.dataset.enabled = enabled ? 'true' : 'false';
    const name = repoName(r);
    setText(rec.link, name);
    setAttr(rec.link, 'href', repoUrl(r));
    setAttr(rec.link, 'title', 'Ouvrir ' + name + ' sur GitHub (nouvel onglet)');
    const where = [r.branch ? 'branche ' + str(r.branch) : '', r.subpath ? 'dossier ' + str(r.subpath) : ''].filter(Boolean).join(' · ');
    setText(rec.where, where);
    setHidden(rec.where, !where);

    setText(rec.statusText, LIB_STATUS_LABEL[status]);
    setHidden(rec.progress, !busy);
    rec.status.className = 'lib-status lib-status--' + status;

    if (rec.switchInput.checked !== enabled) rec.switchInput.checked = enabled;
    rec.switchInput.disabled = busy;
    setText(rec.switchText, enabled ? 'Actif' : 'Désactivé');
    setAttr(rec.switchInput, 'aria-label', 'Utiliser ' + name + ' dans tes pix');
    setAttr(rec.sw, 'title', busy ? 'Patiente : une opération est en cours sur ce dépôt'
      : enabled ? 'Ce dépôt est proposé à tes pix : clique pour le désactiver' : 'Ce dépôt est ignoré : clique pour le réactiver');

    const counts = libCountsText(r);
    setText(rec.counts, counts || (status === 'cloning' ? 'Récupération du dépôt…' : status === 'ready' ? 'Aucun skill, agent ni commande trouvé' : ''));
    const commit = str(r.commit).slice(0, 7);
    setText(rec.commit, commit);
    setHidden(rec.commit, !commit);
    const when = fmtWhen(r.updatedAt || r.clonedAt);
    setAttr(rec.commit, 'title', commit ? 'Commit ' + commit + (when ? ' · récupéré ' + when : '') : null);

    const err = status === 'error' ? (str(r.error) || 'Le dépôt n\'a pas pu être préparé.') : '';
    setText(rec.error, err);
    setHidden(rec.error, !err);
    const warns = Array.isArray(r.warnings) ? r.warnings.map(str).filter(Boolean) : [];
    const wsig = warns.join('\n');
    if (rec.warnSig !== wsig) {
      rec.warnSig = wsig;
      rec.warnings.replaceChildren(...warns.map((w) => h('li', null, w)));
    }
    setHidden(rec.warnings, !warns.length);

    const nItems = Array.isArray(r.items) ? r.items.length : 0;
    if (!nItems) rec.expanded = false;
    setText(rec.btnItems.querySelector('[data-label]'), nItems ? 'Contenu (' + fmtInt(nItems) + ')' : 'Contenu');
    setAttr(rec.btnItems, 'aria-disabled', nItems ? null : 'true');
    setAttr(rec.btnItems, 'aria-expanded', rec.expanded ? 'true' : 'false');
    setHidden(rec.items, !rec.expanded);
    if (!isBusy(rec.btnUpdate)) {
      setAttr(rec.btnUpdate, 'aria-disabled', busy ? 'true' : null);
      setText(rec.btnUpdate.querySelector('[data-label]'), status === 'updating' ? 'Mise à jour…' : 'Mettre à jour');
    }
    setAttr(rec.btnUpdate, 'title', busy ? 'Une opération est déjà en cours sur ce dépôt' : 'Récupérer la dernière version depuis GitHub');
    renderLibItems(rec, r);
  }

  function renderLibrary() {
    if (!initialized) return;
    const git = gitFound();
    setHidden(els.libNogit, git);
    setHidden(els.libForm, !git || (!library && !!libUnavailable));
    const repos = libRepos();
    const ids = new Set(repos.map((r) => r.id));
    for (const [id, rec] of Array.from(libCards)) {
      if (ids.has(id)) continue;
      clearTimeout(rec.confirmTimer);
      rec.li.remove();
      libCards.delete(id);
    }
    repos.forEach((r, i) => {
      let rec = libCards.get(r.id);
      if (!rec) {
        rec = createLibCard(r.id);
        libCards.set(r.id, rec);
      }
      if (els.libList.children[i] !== rec.li) els.libList.insertBefore(rec.li, els.libList.children[i] || null);
      updateLibCard(rec, r);
    });
    setHidden(els.libList, !repos.length);
    setHidden(els.libEmpty, repos.length > 0);
    if (!repos.length) {
      if (library) {
        setText(els.libEmptyTitle, 'Aucun dépôt lié');
        setText(els.libEmptyText, libEmptyDefault);
      } else if (libUnavailable) {
        setText(els.libEmptyTitle, 'Bibliothèque indisponible');
        setText(els.libEmptyText, libUnavailable);
      } else {
        setText(els.libEmptyTitle, 'Chargement de la bibliothèque…');
        setText(els.libEmptyText, '');
      }
      setHidden(els.libEmptyText, !els.libEmptyText.textContent);
    }
    const n = repos.length;
    const busyN = repos.filter((r) => r.status === 'cloning' || r.status === 'updating').length;
    setText(els.dockLibCount, String(n));
    setHidden(els.dockLibCount, n === 0);
    els.dockLibCount.classList.toggle('is-busy', busyN > 0);
    setAttr(els.dockLibCount, 'aria-label', n ? (n > 1 ? n + ' dépôts liés' : '1 dépôt lié') : null);
    setAttr(els.libNote, 'title', library && library.pluginDir ? 'Plugins générés dans ' + str(library.pluginDir) : null);
    updateSuggestions();
    updateProfileSelects();
  }

  /**
   * Library object from the server (snapshot / SSE « library » / API answers), or null.
   * opts.unavailable: French reason shown when this server has no library at all.
   */
  function setLibrary(lib, opts) {
    if (lib && typeof lib === 'object' && Array.isArray(lib.repos)) {
      library = lib;
      libUnavailable = '';
    } else if (opts && opts.unavailable) {
      library = null;
      libUnavailable = str(opts.unavailable);
    } else {
      return;
    }
    renderLibrary();
  }

  function bindLibrary() {
    libEmptyDefault = els.libEmptyText.textContent;
    buildSuggestions();
    els.libForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitLibraryLink();
    });
    els.libUrl.addEventListener('input', () => {
      if (!els.libError.hidden) setLibError('');
    });
    const onProfile = (select, key) => () => {
      profilePrefs[key] = select.value || '';
      storageSet(key, select.value || '');
      updateProfileSelects();
    };
    els.profile.addEventListener('change', onProfile(els.profile, STORE_KEYS.profile));
    els.tProfile.addEventListener('change', onProfile(els.tProfile, STORE_KEYS.termProfile));
  }

  // ------------------------------------------------------------------ « Tes pix » party bar (RTS style)

  function rank(a) {
    if (isRunning(a)) return 0;
    if (a.status === 'waiting') return 1;
    return 2;
  }

  function recency(a) {
    return Math.max(toNum(a.startedAt), toNum(a.endedAt));
  }

  /** Root agents (running first, most recent first) with their subagents. */
  function partyGroups(all) {
    const byIdMap = new Map(all.map((a) => [a.id, a]));
    const roots = [];
    const subsOfRoot = new Map();
    for (const a of all) {
      if (a.kind === 'sub' && a.parentId && byIdMap.has(a.parentId) && byIdMap.get(a.parentId).kind !== 'sub') {
        if (!subsOfRoot.has(a.parentId)) subsOfRoot.set(a.parentId, []);
        subsOfRoot.get(a.parentId).push(a);
      } else {
        roots.push(a);
      }
    }
    roots.sort((x, y) => rank(x) - rank(y) || recency(y) - recency(x) || x.id.localeCompare(y.id));
    return roots.map((r) => {
      const subs = subsOfRoot.get(r.id) || [];
      subs.sort((x, y) => rank(x) - rank(y) || toNum(x.startedAt) - toNum(y.startedAt) || x.id.localeCompare(y.id));
      return { agent: r, subs };
    });
  }

  function statusRing(a) {
    if (asksUser(a)) return 'asks';
    return knownStatus(a);
  }

  function createMember(id) {
    const avatar = h('canvas', { class: 'member-avatar', width: '40', height: '40', 'aria-hidden': 'true' });
    const lvl = h('span', { class: 'member-lvl num', 'aria-hidden': 'true' });
    const portrait = h('span', { class: 'member-portrait' }, [avatar, lvl]);
    const name = h('span', { class: 'member-name' });
    const actIco = h('span', { class: 'member-act-ico' });
    const actText = h('span', { class: 'member-act-text' });
    const act = h('span', { class: 'member-act' }, [actIco, actText]);
    const fill = h('span', { class: 'member-fill' });
    const bar = h('span', { class: 'member-bar', 'aria-hidden': 'true' }, [fill]);
    const tok = h('span', { class: 'member-tok num' });
    const main = h('button', { type: 'button', class: 'member-main', 'aria-pressed': 'false' }, [
      portrait,
      h('span', { class: 'member-info' }, [name, act, h('span', { class: 'member-xp' }, [bar, tok])])
    ]);
    const subs = h('span', { class: 'member-subs' });
    const li = h('li', { class: 'member' }, [main, subs]);
    li.dataset.id = id;
    main.addEventListener('click', () => toggleSelect(id));
    main.addEventListener('keydown', onMemberKey);
    main.addEventListener('mouseenter', () => hoverAgent(id));
    main.addEventListener('mouseleave', () => hoverAgent(null));
    main.addEventListener('focus', () => hoverAgent(id));
    main.addEventListener('blur', () => hoverAgent(null));
    return {
      id, li, main, avatar, lvl, name, actIco, actText, fill, tok, subs,
      subsSig: '', avatarKey: '', color: '', ring: '', kind: ''
    };
  }

  function hoverAgent(id) {
    try { cb.onHoverAgent(id); } catch (_) { /* highlight only */ }
  }

  function updateMember(rec, a, subs, now) {
    const color = safeColor(a.color);
    if (rec.color !== color) {
      rec.color = color;
      rec.li.style.setProperty('--agent', color);
    }
    const ring = statusRing(a);
    if (rec.ring !== ring) {
      rec.ring = ring;
      rec.li.dataset.status = ring;
    }
    rec.li.classList.toggle('is-ended', isEnded(a));
    rec.li.classList.toggle('is-hover', hoverId === a.id);
    rec.li.classList.toggle('is-selected', selectedId === a.id);

    const name = str(a.name) || a.id;
    setText(rec.name, name);

    const tk = tokensOf(a);
    const lv = levelOf(tk.total);
    setText(rec.lvl, String(lv.level));
    setText(rec.tok, fmtTokens(tk.total));
    const pct = Math.round(Math.max(0, Math.min(1, lv.progress)) * 100) + '%';
    if (rec.fill.style.width !== pct) rec.fill.style.width = pct;

    const kind = a.activity && typeof a.activity.kind === 'string' && KIND_LABEL[a.activity.kind] ? a.activity.kind
      : a.status === 'error' ? 'error' : a.status === 'done' ? 'done' : 'idle';
    if (rec.kind !== kind) {
      rec.kind = kind;
      rec.actIco.replaceChildren(icon(kind));
      rec.actIco.className = 'member-act-ico tone--' + kind;
    }
    const act = activityText(a);
    setText(rec.actText, act);

    const label = statusLabel(a);
    const pressed = selectedId === a.id ? 'true' : 'false';
    setAttr(rec.main, 'aria-pressed', pressed);
    setAttr(rec.main, 'aria-label', name + ', niveau ' + lv.level + ' ' + lv.title + ', ' + label + ' : ' + act
      + ', ' + fmtTokens(tk.total) + ' tokens' + (subs.length ? ', ' + subs.length + ' sous-pix' : ''));
    setAttr(rec.main, 'title', name + ' · Niv. ' + lv.level + ' ' + lv.title + ' · ' + label + '\n' + act);

    paintMemberAvatar(rec, a);
    renderMemberSubs(rec, subs);
  }

  function paintMemberAvatar(rec, a) {
    const status = knownStatus(a);
    const frame = isRunning(a) && !prefersReducedMotion() ? avatarFrame : 0;
    const key = rec.color + '|' + status + '|' + frame;
    if (rec.avatarKey === key) return;
    rec.avatarKey = key;
    drawAvatar(rec.avatar, rec.color, { size: 40, status, frame });
  }

  /** Subagents: small stacked portraits behind their parent (click = select that subagent). */
  function renderMemberSubs(rec, subs) {
    const MAX = 3;
    const sig = subs.map((s) => [s.id, s.color, knownStatus(s), s.id === selectedId ? 1 : 0, s.name].join('\u0001')).join('\u0002');
    if (sig === rec.subsSig) return;
    rec.subsSig = sig;
    const nodes = subs.slice(0, MAX).map((s) => {
      const c = h('canvas', { class: 'member-sub-avatar', 'aria-hidden': 'true' });
      drawAvatar(c, safeColor(s.color), { size: 20, status: knownStatus(s), frame: 0 });
      const b = h('button', {
        type: 'button',
        class: 'member-sub' + (s.id === selectedId ? ' is-selected' : '') + (isEnded(s) ? ' is-ended' : ''),
        title: (str(s.name) || s.id) + (s.role ? ' · ' + str(s.role) : '') + ' : ' + activityText(s),
        'aria-label': 'Sous-pix ' + (str(s.name) || s.id) + ', ' + statusLabel(s)
      }, [c]);
      b.style.setProperty('--agent', safeColor(s.color));
      b.dataset.status = knownStatus(s);
      b.addEventListener('click', () => toggleSelect(s.id));
      b.addEventListener('mouseenter', () => hoverAgent(s.id));
      b.addEventListener('mouseleave', () => hoverAgent(null));
      return b;
    });
    if (subs.length > MAX) {
      nodes.push(h('span', { class: 'member-sub-more num', title: subs.length + ' sous-pix' }, '+' + (subs.length - MAX)));
    }
    rec.subs.replaceChildren(...nodes);
    setHidden(rec.subs, !subs.length);
  }

  function renderParty(now) {
    const all = agentsList();
    const groups = partyGroups(all);
    const active = document.activeElement;
    const seen = new Set();
    let prev = null;
    for (const g of groups) {
      const a = g.agent;
      let rec = members.get(a.id);
      if (!rec) {
        rec = createMember(a.id);
        members.set(a.id, rec);
      }
      updateMember(rec, a, g.subs, now);
      seen.add(a.id);
      const expected = prev ? prev.nextSibling : els.partyList.firstChild;
      if (rec.li !== expected) els.partyList.insertBefore(rec.li, expected);
      prev = rec.li;
    }
    for (const [id, rec] of members) {
      if (!seen.has(id)) {
        rec.li.remove();
        members.delete(id);
      }
    }
    if (active && active !== document.activeElement && active.isConnected && els.partyList.contains(active)) {
      try { active.focus({ preventScroll: true }); } catch (_) { /* focus restore is best effort */ }
    }

    const count = all.length;
    setText(els.rosterCount, fmtInt(count));
    setAttr(els.rosterCount, 'title', count + ' pix au bureau');
    setHidden(els.partyEmpty, count > 0);
    setHidden(els.partyList, count === 0);
    setHidden(els.stageEmpty, count > 0);
    updateNamePlaceholder();
  }

  function toggleSelect(id) {
    cb.onSelect(selectedId === id ? null : id);
  }

  function onMemberKey(e) {
    const list = Array.from(els.partyList.querySelectorAll('.member-main'));
    const idx = list.indexOf(e.currentTarget);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = Math.min(list.length - 1, idx + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = Math.max(0, idx - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    if (next >= 0 && list[next]) {
      e.preventDefault();
      list[next].focus();
    }
  }

  /** Hover coming from the office canvas: highlight that member in the party bar. */
  function setHover(id) {
    const next = typeof id === 'string' && id ? id : null;
    if (next === hoverId) return;
    const prevRec = hoverId && members.get(hoverId);
    if (prevRec) prevRec.li.classList.remove('is-hover');
    hoverId = next;
    const a = next ? agentById(next) : null;
    const rootId = a && a.kind === 'sub' && a.parentId ? a.parentId : next;
    const rec = rootId && members.get(rootId);
    if (rec) rec.li.classList.add('is-hover');
  }

  function bindParty() {
    // Vertical wheel scrolls the party bar horizontally.
    els.partyList.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (els.partyList.scrollWidth <= els.partyList.clientWidth) return;
      e.preventDefault();
      els.partyList.scrollLeft += e.deltaY;
    }, { passive: false });
  }

  // ------------------------------------------------------------------ drawer

  function bindDrawer() {
    els.dClose.addEventListener('click', () => cb.onSelect(null));
    els.tabInfo.addEventListener('click', () => setTab('info'));
    els.tabLog.addEventListener('click', () => setTab('log'));
    [els.tabInfo, els.tabLog].forEach((tab) => {
      tab.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          const goLog = e.key === 'End' || ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && drawer.tab === 'info');
          setTab(goLog ? 'log' : 'info', true);
        }
      });
    });

    els.panelLog.addEventListener('scroll', () => {
      drawer.stick = nearBottom();
      if (drawer.stick) {
        drawer.pendingBelow = 0;
        setHidden(els.dLogJump, true);
      }
    }, { passive: true });
    els.dLogJump.addEventListener('click', () => {
      drawer.stick = true;
      drawer.pendingBelow = 0;
      setHidden(els.dLogJump, true);
      scrollLogToBottom();
    });

    els.dCopy.addEventListener('click', copySession);
    els.dParent.addEventListener('click', () => {
      const id = els.dParent.dataset.target;
      if (id) cb.onSelect(id);
    });

    els.dStop.addEventListener('click', () => {
      const id = drawer.id;
      if (!id) return;
      runBusy(els.dStop, () => cb.onStop(id));
    });

    els.dTerm.addEventListener('click', () => {
      const termId = els.dTerm.dataset.target;
      if (!termId) return;
      if (els.dTerm.getAttribute('aria-disabled') === 'true') {
        toast(termSupport.supported === true
          ? 'Son terminal a été fermé : la session reste visible au bureau, mais il n\'y a plus de terminal à afficher.'
          : 'Le terminal intégré n\'est pas disponible avec ce serveur.', 'info');
        return;
      }
      cb.onShowTerminal(termId);
    });

    els.dRemove.addEventListener('click', openRemoveConfirm);
    els.dRemoveNo.addEventListener('click', () => closeRemoveConfirm(true));
    els.dRemoveYes.addEventListener('click', () => {
      const id = drawer.id;
      if (!id) return;
      clearTimeout(drawer.confirmTimer);
      runBusy(els.dRemoveYes, () => cb.onRemove(id)).then((ok) => {
        if (drawer.id === id && ok === false) closeRemoveConfirm(true);
      });
    });

    els.dFollowup.addEventListener('submit', (e) => {
      e.preventDefault();
      submitFollowup();
    });
    els.dFollowupText.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitFollowup();
      }
    });
    els.dFollowupText.addEventListener('input', () => {
      if (!drawer.id) return;
      const v = els.dFollowupText.value;
      if (v) drafts.set(drawer.id, v);
      else drafts.delete(drawer.id);
      if (v.trim()) setFollowupError('');
    });
  }

  function setTab(tab, focus) {
    const isLog = tab === 'log';
    drawer.tab = isLog ? 'log' : 'info';
    setAttr(els.tabInfo, 'aria-selected', isLog ? 'false' : 'true');
    setAttr(els.tabLog, 'aria-selected', isLog ? 'true' : 'false');
    setAttr(els.tabInfo, 'tabindex', isLog ? '-1' : '0');
    setAttr(els.tabLog, 'tabindex', isLog ? '0' : '-1');
    setHidden(els.panelInfo, isLog);
    setHidden(els.panelLog, !isLog);
    if (isLog) {
      drawer.unseen = 0;
      updateBadge();
      if (drawer.stick) scrollLogToBottom();
    }
    if (focus) (isLog ? els.tabLog : els.tabInfo).focus();
  }

  function updateBadge() {
    const n = drawer.unseen;
    setText(els.logBadge, n > 99 ? '99+' : String(n));
    setHidden(els.logBadge, n <= 0);
    setAttr(els.logBadge, 'aria-label', n > 0 ? n + ' nouvel' + (n > 1 ? 's' : '') + ' événement' + (n > 1 ? 's' : '') : null);
  }

  function nearBottom() {
    const el = els.panelLog;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 28;
  }

  function scrollLogToBottom() {
    const el = els.panelLog;
    el.scrollTop = el.scrollHeight;
  }

  function openRemoveConfirm() {
    const a = agentById(drawer.id);
    if (!a) return;
    const name = str(a.name) || a.id;
    let extra = '';
    if (a.interactive === true && canStop(a)) extra = ' Sa session Claude Code sera d\'abord arrêtée (le terminal reste ouvert).';
    else if (isRunning(a)) extra = ' Il sera d\'abord arrêté.';
    else if (a.source === 'observed') extra = ' Il réapparaîtra en cas de nouvelle activité.';
    setText(els.dRemoveQ, 'Retirer ' + name + ' du bureau ?' + extra);
    setHidden(els.dRemove, true);
    setHidden(els.dRemoveConfirm, false);
    els.dRemoveNo.focus();
    clearTimeout(drawer.confirmTimer);
    drawer.confirmTimer = setTimeout(() => closeRemoveConfirm(false), CONFIRM_TIMEOUT);
  }

  function closeRemoveConfirm(restoreFocus) {
    clearTimeout(drawer.confirmTimer);
    const wasOpen = !els.dRemoveConfirm.hidden;
    const hadFocus = els.dRemoveConfirm.contains(document.activeElement);
    setHidden(els.dRemoveConfirm, true);
    setHidden(els.dRemove, false);
    if (wasOpen && (restoreFocus || hadFocus)) els.dRemove.focus();
    return wasOpen;
  }

  function setFollowupError(message) {
    setText(els.dFollowupErr, message || '');
    setHidden(els.dFollowupErr, !message);
  }

  function submitFollowup() {
    const id = drawer.id;
    if (!id || isBusy(els.dSend)) return;
    const text = els.dFollowupText.value.trim();
    if (!text) {
      setFollowupError('Écris une consigne avant d\'envoyer.');
      els.dFollowupText.focus();
      return;
    }
    if (text.length > MAX_PROMPT) {
      setFollowupError('Message trop long (' + fmtInt(MAX_PROMPT) + ' caractères maximum).');
      return;
    }
    setFollowupError('');
    runBusy(els.dSend, () => cb.onMessage(id, text), 'Envoi…').then((ok) => {
      if (ok === false) return;
      drafts.delete(id);
      if (drawer.id === id) els.dFollowupText.value = '';
    });
  }

  async function copySession() {
    const a = agentById(drawer.id);
    const text = a && a.sessionId ? str(a.sessionId) : '';
    if (!text) return;
    let ok = false;
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        ok = true;
      } catch (_) {
        ok = false;
      }
    }
    if (!ok) {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(els.dSession);
        sel.removeAllRanges();
        sel.addRange(range);
        try {
          ok = document.execCommand('copy');
        } catch (_) {
          ok = false;
        }
      }
    }
    if (ok) {
      setText(els.dCopy, 'Copié ✓');
      clearTimeout(drawer.copyTimer);
      drawer.copyTimer = setTimeout(() => setText(els.dCopy, 'Copier'), 1600);
    } else {
      toast('Identifiant sélectionné : appuie sur Ctrl+C pour le copier.', 'info');
    }
  }

  function chip(text, cls, title) {
    return h('span', { class: 'chip' + (cls ? ' ' + cls : ''), title: title || null }, text);
  }

  function subsOf(id) {
    return agentsList()
      .filter((x) => x.kind === 'sub' && x.parentId === id)
      .sort((x, y) => toNum(x.startedAt) - toNum(y.startedAt) || x.id.localeCompare(y.id));
  }

  function renderSubs(a) {
    const subs = a.kind === 'sub' ? [] : subsOf(a.id);
    const sig = subs.map((s) => [s.id, s.name, s.color, s.status, activityText(s), s.role].join('\u0001')).join('\u0002');
    setHidden(els.dSubsBlock, subs.length === 0);
    if (sig === drawer.subsSig) return;
    drawer.subsSig = sig;
    setText(els.dSubsCount, String(subs.length));
    els.dSubs.replaceChildren(...subs.map((s) => {
      const status = knownStatus(s);
      const avatar = h('canvas', { class: 'sub-avatar', 'aria-hidden': 'true' });
      drawAvatar(avatar, s.color, { size: 24, status, frame: 0 });
      const pill = h('span', { class: 'pill pill--' + status }, [
        h('span', { class: 'pill-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'pill-label' }, STATUS_LABEL[status])
      ]);
      const btn = h('button', { type: 'button', class: 'sub-btn', title: 'Afficher la fiche de ' + (str(s.name) || s.id) }, [
        avatar,
        h('span', { class: 'sub-text' }, [
          h('span', { class: 'sub-name' }, (str(s.name) || s.id) + (s.role ? ' · ' + str(s.role) : '')),
          h('span', { class: 'sub-activity' }, activityText(s))
        ]),
        pill
      ]);
      btn.style.setProperty('--agent', safeColor(s.color));
      btn.addEventListener('click', () => cb.onSelect(s.id));
      return h('li', null, [btn]);
    }));
  }

  function renderFooter(a) {
    const running = isRunning(a);
    const ended = isEnded(a);
    const controllable = a.canControl !== false;
    const isSub = a.kind === 'sub';
    const interactive = a.interactive === true;

    setHidden(els.dStop, !canStop(a));
    setAttr(els.dStop, 'title', isSub
      ? 'Arrêter ce sous-pix arrête aussi son pix parent.'
      : interactive ? 'Arrêter cette session Claude Code (le terminal reste ouvert)' : 'Arrêter le processus du pix');

    // « Voir son terminal »: agents started in an HQ terminal (subagents follow their root).
    const root = isSub && a.parentId ? agentById(a.parentId) : a;
    const termId = root && typeof root.terminalId === 'string' && root.terminalId ? root.terminalId : '';
    const term = termId ? terminalOfAgent(root) : undefined;
    setHidden(els.dTerm, !termId);
    if (termId) {
      els.dTerm.dataset.target = termId;
      const closed = !term || termSupport.supported !== true;
      setAttr(els.dTerm, 'aria-disabled', closed ? 'true' : null);
      setAttr(els.dTerm, 'title', closed
        ? (termSupport.supported === true ? 'Son terminal a été fermé.' : 'Le terminal intégré n\'est pas disponible.')
        : 'Afficher ' + (str(term.title) || 'son terminal') + ' dans la fenêtre Terminal');
    }

    const canFollow = ended && !isSub && controllable && !interactive && !!a.sessionId;
    setHidden(els.dFollowup, !canFollow);
    if (!canFollow) setFollowupError('');
    const name = str(a.name) || a.id;
    const ph = 'Donner une nouvelle consigne à ' + name + '… (Ctrl+Entrée)';
    if (els.dFollowupText.placeholder !== ph) els.dFollowupText.placeholder = ph;

    let note = '';
    if (!controllable) note = 'Session externe : observation seule, impossible de l\'arrêter ou de lui écrire depuis PixelQG.';
    else if (interactive && !isSub) {
      if (ended && a.sessionId) note = 'Session terminée. Pour la reprendre, tape « claude --resume ' + str(a.sessionId) + ' » dans un terminal de PixelQG.';
      else if (ended) note = 'Session terminée.';
      else if (a.status === 'starting') note = 'Claude Code démarre dans son terminal… Réponds-lui directement dans son terminal.';
      else note = 'Réponds-lui directement dans son terminal.';
    } else if (isSub && running) note = 'Arrêter un sous-pix arrête aussi son pix parent.';
    else if (isSub && ended) note = 'Sous-pix : pour poursuivre, écris à son pix parent.';
    else if (ended && !a.sessionId) note = 'Aucune session à reprendre : impossible d\'envoyer une suite à ce pix.';
    else if (a.status === 'starting') note = 'Démarrage du processus Claude Code…';
    setText(els.dNote, note);
    setHidden(els.dNote, !note);
  }

  function setBar(seg, value, max) {
    // Square-root scale against the biggest counter: cache reads would otherwise flatten the others.
    const pct = max > 0 && value > 0 ? Math.sqrt(value / max) * 100 : 0;
    const w = pct > 0 && pct < 0.6 ? '0.6%' : pct.toFixed(2) + '%';
    if (seg.style.width !== w) seg.style.width = w;
  }

  /** Level badge, rank title and XP bar of the character sheet. */
  function renderLevel(total) {
    const lv = levelOf(total);
    setText(els.dLevel, String(lv.level));
    setAttr(els.dLevel, 'title', 'Niveau ' + lv.level);
    setText(els.dLevelTitle, 'Niveau ' + lv.level + ' · ' + lv.title);
    const pct = Math.round(Math.max(0, Math.min(1, lv.progress)) * 100);
    const w = pct + '%';
    if (els.dXpFill.style.width !== w) els.dXpFill.style.width = w;
    setText(els.dXpText, lv.next ? fmtTokens(total) + ' / ' + fmtTokens(lv.next) : fmtTokens(total) + ' · MAX');
    setAttr(els.dXp, 'aria-valuenow', String(pct));
    setAttr(els.dXp, 'aria-valuetext', lv.next
      ? 'Niveau ' + lv.level + ', ' + pct + ' % vers le niveau ' + (lv.level + 1)
      : 'Niveau maximum atteint');
    setAttr(els.dXp, 'title', lv.next
      ? 'Encore ' + fmtInt(Math.max(0, lv.next - total)) + ' tokens avant le niveau ' + (lv.level + 1)
      : 'Niveau maximum atteint');
  }

  function renderDrawer(now) {
    const a = selectedId ? agentById(selectedId) : undefined;
    if (!a) {
      if (drawer.id !== null || !els.drawer.hidden) {
        drawer.id = null;
        closeRemoveConfirm(false);
      }
      if (!els.drawer.hidden) {
        setHidden(els.drawer, true);
        els.app.classList.remove('has-sheet');
        scheduleInsets();
      }
      return;
    }

    const switched = drawer.id !== a.id;
    if (switched) {
      drawer.id = a.id;
      drawer.avatarKey = '';
      drawer.subsSig = '';
      drawer.stick = true;
      drawer.unseen = 0;
      drawer.pendingBelow = 0;
      updateBadge();
      closeRemoveConfirm(false);
      setFollowupError('');
      els.dFollowupText.value = drafts.get(a.id) || '';
      els.dPromptBlock.open = true;
      els.panelInfo.scrollTop = 0;
      setHidden(els.dLogJump, true);
      setText(els.dCopy, 'Copier');
    }

    if (els.drawer.hidden) {
      setHidden(els.drawer, false);
      els.app.classList.add('has-sheet');
      scheduleInsets();
    }

    const color = safeColor(a.color);
    els.drawer.style.setProperty('--agent', color);
    const status = knownStatus(a);
    const avatarKey = color + '|' + status;
    if (drawer.avatarKey !== avatarKey) {
      drawer.avatarKey = avatarKey;
      drawAvatar(els.dAvatar, color, { size: 64, status, frame: 0 });
    }

    const name = str(a.name) || a.id;
    setText(els.dName, name);
    setAttr(els.dName, 'title', name);

    const chips = [];
    if (a.kind === 'sub') chips.push(['Sous-pix' + (a.role ? ' · ' + str(a.role) : ''), 'chip--role', 'Type de sous-pix']);
    if (a.model) chips.push([shortModel(a.model), '', 'Modèle : ' + str(a.model)]);
    if (profileShort(a.profile)) chips.push([profileShort(a.profile), 'chip--profile', 'Profil de la bibliothèque : ' + str(a.profile)]);
    if (SOURCE_LABEL[a.source]) chips.push([SOURCE_LABEL[a.source], 'chip--src-' + a.source, sourceTitle(a)]);
    const chipSig = JSON.stringify(chips);
    if (els.dChips.dataset.sig !== chipSig) {
      els.dChips.dataset.sig = chipSig;
      els.dChips.replaceChildren(...chips.map((c) => chip(c[0], c[1], c[2])));
    }

    els.dPill.className = pillClass(a);
    setText(els.dPillLabel, statusLabel(a));
    const act = activityText(a);
    setText(els.dActivity, act);
    setAttr(els.dActivity, 'title', act);

    const elapsed = fmtDuration(elapsedMs(a, now));
    setText(els.dTimerTop, elapsed);
    setText(els.dTimer, elapsed);
    const costInParent = a.kind === 'sub' && !hasCost(a);
    const costInteractive = a.interactive === true && !hasCost(a);
    setText(els.dCost, costInParent ? 'inclus' : fmtCost(a.costUsd));
    setAttr(els.dCost, 'title', costInParent
      ? 'Inclus dans le coût du pix parent'
      : costInteractive ? 'Coût indisponible : les sessions interactives ne le communiquent pas' : null);
    setText(els.dTools, fmtInt(a.toolCount));
    setText(els.dTurns, fmtInt(a.turns));
    setText(els.dModel, a.model ? str(a.model) : 'Modèle par défaut de Claude Code');

    const parent = a.kind === 'sub' && a.parentId ? agentById(a.parentId) : undefined;
    setHidden(els.dParentRow, !parent);
    if (parent) {
      setText(els.dParent, str(parent.name) || parent.id);
      els.dParent.dataset.target = parent.id;
    }

    setText(els.dCwd, str(a.cwd) || '—');
    setAttr(els.dCwd, 'title', str(a.cwd) || null);
    const session = str(a.sessionId);
    setText(els.dSession, session || 'pas encore attribuée');
    els.dSession.classList.toggle('is-empty', !session);
    setHidden(els.dCopy, !session);
    setAttr(els.dSession, 'title', session || null);
    setText(els.dTimes, fmtSpan(a.startedAt, a.endedAt));

    const tk = tokensOf(a);
    setText(els.dTokTotal, fmtInt(tk.total));
    const top = Math.max(tk.input, tk.output, tk.cacheRead, tk.cacheWrite);
    setBar(els.dSegIn, tk.input, top);
    setBar(els.dSegOut, tk.output, top);
    setBar(els.dSegCr, tk.cacheRead, top);
    setBar(els.dSegCw, tk.cacheWrite, top);
    renderLevel(tk.total);
    setText(els.dTokIn, fmtInt(tk.input));
    setText(els.dTokOut, fmtInt(tk.output));
    setText(els.dTokCr, fmtInt(tk.cacheRead));
    setText(els.dTokCw, fmtInt(tk.cacheWrite));
    setAttr(els.dTokbar, 'aria-label', 'Tokens : entrée ' + fmtInt(tk.input) + ', sortie ' + fmtInt(tk.output)
      + ', cache lu ' + fmtInt(tk.cacheRead) + ', cache écrit ' + fmtInt(tk.cacheWrite));

    const error = str(a.error).trim();
    setText(els.dError, error);
    setHidden(els.dErrorBlock, !error);

    const result = str(a.resultText).trim();
    setText(els.dResult, result);
    setHidden(els.dResultBlock, !result);

    const last = str(a.lastText).trim();
    const showLast = !!last && !(result && result.startsWith(last.replace(/…$/, '')));
    setText(els.dLast, last);
    setHidden(els.dLastBlock, !showLast);

    setText(els.dPrompt, str(a.prompt).trim()
      || (a.interactive ? 'Pas encore de consigne : écris-lui dans son terminal.' : 'Aucune mission enregistrée.'));

    renderSubs(a);
    renderFooter(a);
  }

  // ------------------------------------------------------------------ log feed

  function toggleLogDetail(li, head, detail) {
    const open = head.getAttribute('aria-expanded') === 'true';
    let pre = li.querySelector('.log-detail');
    if (open) {
      head.setAttribute('aria-expanded', 'false');
      if (pre) pre.hidden = true;
      return;
    }
    if (!pre) {
      pre = h('pre', { class: 'log-detail' });
      pre.textContent = detail;
      li.appendChild(pre);
    }
    pre.hidden = false;
    head.setAttribute('aria-expanded', 'true');
    // Reading an expanded entry should not be interrupted by auto-scroll.
    drawer.stick = nearBottom();
  }

  function buildLogItem(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const type = LOG_TYPE_LABEL[entry.type] ? entry.type : 'system';
    const kind = typeof entry.kind === 'string' ? entry.kind : '';
    const iconName = logIconName(type, kind);
    const text = str(entry.text).trim() || LOG_TYPE_LABEL[type];
    const detail = typeof entry.detail === 'string' ? entry.detail : '';
    const hasDetail = detail.trim().length > 0 && detail.trim() !== text;
    const label = type === 'tool' && KIND_LABEL[kind] ? KIND_LABEL[kind] : LOG_TYPE_LABEL[type];

    const li = h('li', { class: 'log log--' + type + ' tone--' + iconName });
    const head = h(hasDetail ? 'button' : 'div', {
      class: 'log-head',
      type: hasDetail ? 'button' : null,
      'aria-expanded': hasDetail ? 'false' : null
    });
    const t = Number(entry.t);
    const time = h('time', { class: 'log-time num' }, fmtClock(t));
    if (Number.isFinite(t) && t > 0) time.setAttribute('datetime', new Date(t).toISOString());
    const body = h('span', { class: 'log-text' }, [h('span', { class: 'sr-only' }, label + ' : ')]);
    if (entry.tool) body.append(h('span', { class: 'log-tool' }, shortTool(entry.tool)), ' ');
    body.append(text);
    head.append(h('span', { class: 'log-ico', title: label }, [icon(iconName)]), time, body);
    if (hasDetail) {
      head.append(h('span', { class: 'log-chev', 'aria-hidden': 'true' }));
      head.title = 'Afficher ou masquer le détail';
      head.addEventListener('click', () => toggleLogDetail(li, head, detail));
    }
    li.appendChild(head);
    return li;
  }

  function trimLog() {
    while (els.dLog.childElementCount > LOG_CAP) {
      const first = els.dLog.firstElementChild;
      const height = !drawer.stick && !els.panelLog.hidden ? first.offsetHeight : 0;
      first.remove();
      if (height) els.panelLog.scrollTop = Math.max(0, els.panelLog.scrollTop - height);
    }
  }

  function updateLogEmpty() {
    const empty = els.dLog.childElementCount === 0;
    setText(els.dLogEmpty, drawer.loading ? 'Chargement du journal…' : 'Aucun événement pour l\'instant.');
    setHidden(els.dLogEmpty, !empty);
  }

  /** Replaces the whole feed of the selected agent. */
  function setLogs(id, entries, opts) {
    if (!id || id !== selectedId) return;
    if (drawer.id !== id) renderDrawer(Date.now());
    drawer.loading = !!(opts && opts.loading);
    const list = Array.isArray(entries) ? entries.slice(-LOG_CAP) : [];
    const frag = document.createDocumentFragment();
    for (const e of list) {
      const item = buildLogItem(e);
      if (item) frag.appendChild(item);
    }
    const keepPosition = !drawer.stick && els.dLog.childElementCount > 0;
    const prevTop = els.panelLog.scrollTop;
    els.dLog.replaceChildren(frag);
    updateLogEmpty();
    if (keepPosition && !els.panelLog.hidden) {
      els.panelLog.scrollTop = prevTop;
    } else {
      drawer.stick = true;
      drawer.pendingBelow = 0;
      setHidden(els.dLogJump, true);
      if (!els.panelLog.hidden) scrollLogToBottom();
    }
  }

  /** Appends one live entry to the selected agent's feed. */
  function appendLog(id, entry) {
    if (!id || id !== drawer.id) return;
    const item = buildLogItem(entry);
    if (!item) return;
    const visible = !els.panelLog.hidden;
    const stick = visible ? nearBottom() || drawer.stick : drawer.stick;
    els.dLog.appendChild(item);
    drawer.loading = false;
    trimLog();
    updateLogEmpty();
    if (!visible) {
      drawer.unseen += 1;
      updateBadge();
    }
    if (stick) {
      drawer.stick = true;
      if (visible) scrollLogToBottom();
    } else {
      drawer.pendingBelow += 1;
      setText(els.dLogJump, drawer.pendingBelow + ' nouvel' + (drawer.pendingBelow > 1 ? 's' : '') + ' événement' + (drawer.pendingBelow > 1 ? 's' : '') + ' ↓');
      setHidden(els.dLogJump, false);
    }
  }

  // ------------------------------------------------------------------ selection

  function select(id) {
    const next = typeof id === 'string' && id ? id : null;
    const prev = selectedId;
    if (next === prev && next === drawer.id) return;
    const focusInDrawer = els.drawer.contains(document.activeElement);
    selectedId = next;
    if (next !== prev) {
      // Clear the previous feed right away; main.js pushes the new one through setLogs().
      els.dLog.replaceChildren();
      drawer.loading = !!next;
      updateLogEmpty();
    }
    renderNow();
    if (!next && focusInDrawer) {
      const a = prev ? agentById(prev) : null;
      const rootId = a && a.kind === 'sub' && a.parentId ? a.parentId : prev;
      const rec = rootId && members.get(rootId);
      try {
        if (rec) rec.main.focus({ preventScroll: true });
      } catch (_) { /* best effort */ }
    }
    if (next) revealMember(next);
    scheduleInsets();
  }

  /** Scrolls the party bar (never the page) so the portrait of `id` (or of its parent) is visible. */
  function revealMember(id) {
    const a = agentById(id);
    const rootId = a && a.kind === 'sub' && a.parentId ? a.parentId : id;
    const rec = members.get(rootId);
    if (!rec || !rec.li.isConnected) return;
    const box = els.partyList;
    const view = box.getBoundingClientRect();
    const item = rec.li.getBoundingClientRect();
    if (item.left < view.left) box.scrollLeft -= view.left - item.left + 8;
    else if (item.right > view.right) box.scrollLeft += item.right - view.right + 8;
  }

  // ------------------------------------------------------------------ toasts

  function removeToast(node) {
    if (!node || !node.isConnected || node.classList.contains('is-leaving')) return;
    clearTimeout(node._hqTimer);
    if (prefersReducedMotion()) {
      node.remove();
      return;
    }
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
  }

  function toast(message, kind, opts) {
    const k = TOAST_KINDS.has(kind) ? kind : 'info';
    const text = truncate(str(message).trim(), 400);
    if (!text || !els.toasts) return null;
    const close = h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Fermer la notification' }, '×');
    const node = h('div', { class: 'toast toast--' + k }, [
      h('span', { class: 'toast-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'toast-text' }, text),
      close
    ]);
    close.addEventListener('click', () => removeToast(node));
    const timeout = opts && Number.isFinite(opts.timeout) ? opts.timeout : k === 'err' ? 7000 : 4200;
    const arm = () => {
      clearTimeout(node._hqTimer);
      if (timeout > 0) node._hqTimer = setTimeout(() => removeToast(node), timeout);
    };
    node.addEventListener('mouseenter', () => clearTimeout(node._hqTimer));
    node.addEventListener('mouseleave', arm);
    node.addEventListener('focusin', () => clearTimeout(node._hqTimer));
    node.addEventListener('focusout', arm);
    els.toasts.appendChild(node);
    // Game toasts come in bursts (level-ups): keep at most 3 of them on screen.
    const live = Array.from(els.toasts.children).filter((n) => !n.classList.contains('is-leaving'));
    const games = live.filter((n) => n.classList.contains('toast--game'));
    for (let i = 0; i < games.length - 3; i++) games[i].remove();
    for (let i = 0; i < live.length - MAX_TOASTS; i++) live[i].remove();
    arm();
    return node;
  }

  // ------------------------------------------------------------------ banners

  /**
   * Shows (or replaces) a persistent banner under the top bar.
   * spec: { kind: 'warn'|'err'|'info', title?, text, actions?: [{ label, onClick, primary? }], dismissible? }
   */
  function showBanner(key, spec) {
    const s = spec || {};
    const kind = s.kind === 'err' || s.kind === 'info' ? s.kind : 'warn';
    const textNode = h('p', { class: 'banner-text' });
    if (s.title) textNode.append(h('span', { class: 'banner-title' }, str(s.title)), ' ');
    textNode.append(str(s.text));
    const actions = h('div', { class: 'banner-actions' });
    for (const act of Array.isArray(s.actions) ? s.actions : []) {
      if (!act || !act.label) continue;
      const btn = h('button', { type: 'button', class: 'btn btn-sm' + (act.primary ? ' btn-primary' : '') }, str(act.label));
      btn.addEventListener('click', () => {
        if (typeof act.onClick === 'function') runBusy(btn, () => act.onClick());
      });
      actions.appendChild(btn);
    }
    if (s.dismissible !== false) {
      const close = h('button', { type: 'button', class: 'btn btn-ghost btn-sm' }, 'Masquer');
      close.addEventListener('click', () => hideBanner(key));
      actions.appendChild(close);
    }
    const node = h('div', { class: 'banner banner--' + kind, role: kind === 'err' ? 'alert' : 'status' }, [
      h('span', { class: 'banner-icon', 'aria-hidden': 'true' }, kind === 'info' ? 'i' : '!'),
      textNode,
      actions
    ]);
    const existing = banners.get(key);
    if (existing && existing.isConnected) existing.replaceWith(node);
    else els.banners.appendChild(node);
    banners.set(key, node);
  }

  function hideBanner(key) {
    const node = banners.get(key);
    if (node) node.remove();
    banners.delete(key);
  }

  // ------------------------------------------------------------------ achievements (« Succès » window) + game toasts

  const achData = { list: null, stats: null };
  let achSig = '';
  let achStatsSig = '';

  const STAT_LABELS = [
    ['totalTokens', 'Tokens cumulés', true],
    ['agentsLaunched', 'Pix lancés'],
    ['maxConcurrent', 'Record de pix simultanés'],
    ['toolsUsed', 'Outils utilisés'],
    ['reads', 'Lectures'],
    ['searches', 'Recherches'],
    ['edits', 'Modifications'],
    ['writes', 'Fichiers écrits'],
    ['bashes', 'Commandes'],
    ['tests', 'Tests lancés'],
    ['gits', 'Opérations Git'],
    ['webs', 'Visites web'],
    ['tasks', 'Délégations'],
    ['subagents', 'Sous-pix'],
    ['done', 'Missions terminées'],
    ['errors', 'Erreurs'],
    ['terminalSessions', 'Terminaux ouverts'],
    ['reposLinked', 'Dépôts liés']
  ];

  /**
   * list: [{ id, icon, title, description, unlocked, at }] (null when progression.js is missing);
   * stats: the counters main.js accumulates (docs/GAME2.md §2).
   */
  function setAchievements(list, stats) {
    achData.list = Array.isArray(list) ? list.filter((a) => a && typeof a.id === 'string') : null;
    achData.stats = stats && typeof stats === 'object' ? stats : null;
    updateAchBadge();
    if (isOpen('achievements')) renderAchievements();
  }

  function updateAchBadge() {
    const list = achData.list || [];
    const n = list.filter((a) => a.unlocked).length;
    setText(els.tbAchCount, String(n));
    setHidden(els.tbAchCount, n === 0);
    setAttr(els.tbAch, 'data-tip', list.length ? 'Succès : ' + n + ' / ' + list.length : 'Succès');
  }

  function fmtDay(t) {
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n);
    return 'le ' + dayFmt.format(d) + ' à ' + clockFmt.format(d).slice(0, 5);
  }

  function renderAchievements() {
    if (!initialized) return;
    const list = achData.list;
    setHidden(els.achEmpty, !!list);
    const total = list ? list.length : 0;
    const unlocked = list ? list.filter((a) => a.unlocked).length : 0;
    setText(els.achCount, fmtInt(unlocked) + ' / ' + fmtInt(total));
    const pct = total ? Math.round((unlocked / total) * 100) + '%' : '0%';
    if (els.achFill.style.width !== pct) els.achFill.style.width = pct;

    const stats = achData.stats || {};
    const ssig = STAT_LABELS.map((s) => toNum(stats[s[0]])).join(',');
    if (ssig !== achStatsSig) {
      achStatsSig = ssig;
      els.achStats.replaceChildren(...STAT_LABELS.map(([key, label, compact]) => h('div', { class: 'ach-stat' }, [
        h('dt', null, label),
        h('dd', { class: 'num', title: fmtInt(stats[key]) }, compact ? fmtTokens(stats[key]) : fmtInt(stats[key]))
      ])));
    }

    const sig = list ? list.map((a) => [a.id, a.unlocked ? 1 : 0, toNum(a.at), a.title, a.description, a.icon].join('\u0001')).join('\u0002') : '';
    if (sig === achSig) return;
    achSig = sig;
    if (!list) {
      els.achList.replaceChildren();
      return;
    }
    const sorted = list.slice().sort((x, y) => (y.unlocked ? 1 : 0) - (x.unlocked ? 1 : 0) || toNum(y.at) - toNum(x.at));
    els.achList.replaceChildren(...sorted.map((a) => {
      const ico = h('span', { class: 'ach-ico' }, [achievementIcon(str(a.icon))]);
      if (!a.unlocked) ico.append(h('span', { class: 'ach-lock' }, [icon('lock')]));
      const when = a.unlocked ? fmtDay(a.at) : '';
      return h('li', { class: 'ach' + (a.unlocked ? ' is-unlocked' : ' is-locked') }, [
        ico,
        h('div', { class: 'ach-text' }, [
          h('p', { class: 'ach-title' }, str(a.title) || a.id),
          h('p', { class: 'ach-desc' }, str(a.description)),
          h('p', { class: 'ach-when' }, a.unlocked ? (when ? 'Débloqué ' + when : 'Débloqué') : 'À débloquer')
        ])
      ]);
    }));
  }

  /** Game-style toast: { kind: 'achievement'|'level', iconNode, label, title, text, color }. */
  function gameToast(spec) {
    const s = spec || {};
    if (!els.toasts) return null;
    const close = h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Fermer la notification' }, '×');
    const ico = h('span', { class: 'gt-ico', 'aria-hidden': 'true' }, s.iconNode ? [s.iconNode] : [icon('star')]);
    const node = h('div', { class: 'toast toast--game toast--' + (s.kind === 'level' ? 'level' : 'achievement'), role: 'status' }, [
      ico,
      h('div', { class: 'gt-text' }, [
        h('span', { class: 'gt-label' }, str(s.label)),
        h('span', { class: 'gt-title' }, truncate(str(s.title), 120)),
        s.text ? h('span', { class: 'gt-desc' }, truncate(str(s.text), 200)) : null
      ]),
      close
    ]);
    if (s.color) node.style.setProperty('--agent', safeColor(s.color));
    close.addEventListener('click', () => removeToast(node));
    const arm = () => {
      clearTimeout(node._hqTimer);
      node._hqTimer = setTimeout(() => removeToast(node), s.kind === 'level' ? 4200 : 5600);
    };
    node.addEventListener('mouseenter', () => clearTimeout(node._hqTimer));
    node.addEventListener('mouseleave', arm);
    node.addEventListener('focusin', () => clearTimeout(node._hqTimer));
    node.addEventListener('focusout', arm);
    els.toasts.appendChild(node);
    const live = Array.from(els.toasts.children).filter((n) => !n.classList.contains('is-leaving'));
    for (let i = 0; i < live.length - MAX_TOASTS; i++) live[i].remove();
    arm();
    return node;
  }

  /** « Succès débloqué : … » */
  function achievementToast(ach) {
    if (!ach) return null;
    return gameToast({
      kind: 'achievement',
      iconNode: achievementIcon(str(ach.icon)),
      label: 'Succès débloqué',
      title: str(ach.title),
      text: str(ach.description)
    });
  }

  /** « NIVEAU 3 ! Nova devient Confirmé » */
  function levelToast(info) {
    const i = info || {};
    const lvl = Math.max(1, Math.round(toNum(i.level)));
    const title = str(i.title) || levelOf(LEVEL_FLOORS[Math.min(LEVEL_FLOORS.length, lvl) - 1] || 0).title;
    return gameToast({
      kind: 'level',
      iconNode: icon('star'),
      label: 'Niveau ' + lvl + ' !',
      title: (str(i.name) || 'Un pix') + ' devient ' + title,
      color: i.color
    });
  }

  // ------------------------------------------------------------------ render scheduling

  function renderNow() {
    renderQueued = false;
    const now = Date.now();
    renderParty(now);
    renderDrawer(now);
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

  function agentChanged() {
    scheduleRender();
  }

  function agentRemoved(id) {
    drafts.delete(id);
    if (hoverId === id) hoverId = null;
    scheduleRender();
  }

  function agentsReset() {
    scheduleRender();
  }

  /** Called once per second by main.js: advances timers and the portraits' idle frame. */
  function tick(now) {
    if (!initialized) return;
    const t = Number.isFinite(now) ? now : Date.now();
    avatarFrame = avatarFrame ? 0 : 1;
    for (const rec of members.values()) {
      const a = agentById(rec.id);
      if (a) paintMemberAvatar(rec, a);
    }
    if (drawer.id) {
      const a = agentById(drawer.id);
      if (a) {
        const elapsed = fmtDuration(elapsedMs(a, t));
        setText(els.dTimerTop, elapsed);
        setText(els.dTimer, elapsed);
      }
    }
  }

  /** Escape handling for in-page overlays. Returns true when the key was consumed. */
  function handleEscape() {
    if (!els.dRemoveConfirm.hidden) {
      closeRemoveConfirm(true);
      return true;
    }
    if (closeLibConfirm()) return true;
    // The terminal's own « Fermer ce terminal ? » confirmation is handled by terminal.js.
    const termConfirm = document.getElementById('term-confirm');
    if (termConfirm && !termConfirm.hidden) return false;
    // A focused game window closes (the character sheet is handled by main.js: Escape deselects).
    for (const n of WIN_NAMES) {
      const rec = wins[n];
      if (rec && rec.open && rec.el.contains(document.activeElement)) {
        closeWindow(n);
        return true;
      }
    }
    return false;
  }

  function drawEmptyAvatar() {
    drawAvatar(els.emptyAvatar, '#FF8A5B', { size: 48, status: 'waiting', frame: 0 });
  }

  // ------------------------------------------------------------------ init

  function init(options) {
    if (initialized) return;
    const o = options || {};
    for (const key of Object.keys(cb)) {
      if (typeof o[key] === 'function') cb[key] = o[key];
    }
    // Backwards compatibility: onDockChange(state) receives the dock-like state of the windows.
    if (typeof o.onDockChange === 'function' && typeof o.onWindowsChange !== 'function') {
      const dockCb = o.onDockChange;
      cb.onWindowsChange = () => dockCb(dockState());
    }
    collectElements();
    paintStaticIcons(document);
    bindToolbar();
    bindLauncher();
    bindTerminalTools();
    bindLibrary();
    bindDrawer();
    bindParty();
    bindMinimap();
    setConfig(null);
    config = null;
    updateVersion();
    updateTerminalTools();
    setTerminalSupport({ supported: false, ready: false, reason: '' });
    setTab('info');
    drawEmptyAvatar();
    initialized = true;
    setupWindows();
    terminalsChanged();
    renderLibrary();
    renderNow();
    updateAchBadge();
    if (typeof window.ResizeObserver === 'function') {
      const ro = new window.ResizeObserver(() => scheduleInsets());
      for (const node of [els.resBar, els.toolbar, els.party, els.drawer, els.minimapPanel]) if (node) ro.observe(node);
    }
    scheduleInsets();
  }

  window.HQUI = {
    init,
    setConfig,
    setStats,
    setConnection,
    select,
    setHover,
    agentChanged,
    agentRemoved,
    agentsReset,
    setLogs,
    appendLog,
    tick,
    toast,
    showBanner,
    hideBanner,
    handleEscape,
    focusLauncher,
    showDockTab,
    dockState,
    setTerminalSupport,
    terminalsChanged,
    setLibrary,
    drawAvatar,
    // game HUD (docs/GAME2.md §3)
    openWindow,
    closeWindow,
    toggleWindow,
    isWindowOpen: isOpen,
    windowsState: () => windowsState(null),
    coinTarget,
    coinHit,
    setTourState,
    setSoundState,
    setRooms,
    setWorldSize,
    setAchievements,
    achievementToast,
    levelToast,
    gameToast,
    levelOf,
    reportInsets: scheduleInsets,
    fmt: {
      int: fmtInt,
      tokens: fmtTokens,
      cost: fmtCost,
      duration: fmtDuration,
      clock: fmtClock
    }
  };
})();
