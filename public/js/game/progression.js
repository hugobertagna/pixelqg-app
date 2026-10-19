/* PixelQG — progression.js
 * Levels (tokens -> level / title / progress), achievements over the global stats object and a set of
 * small pixel-art icons shared by the game (emotes, items) and the HUD (badges, toasts, toolbar).
 * Icons are fill-only ASCII bitmaps; a 1 px dark outline is added automatically when drawn.
 * Exposes window.HQProgression. Classic script, no dependencies (loaded before sprites.js).
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------ levels
  const THRESHOLDS = [0, 10000, 50000, 150000, 400000, 1000000, 2500000, 6000000, 15000000, 40000000];
  const TITLES = ['Stagiaire', 'Junior', 'Confirmé', 'Senior', 'Expert', 'Architecte', 'Maestro', 'Légende', 'Mythe', 'Oracle'];
  const MAX_LEVEL = THRESHOLDS.length;
  /** Badge colours per level (fill, text): cool greys -> greens -> blues -> purples -> gold. */
  const LEVEL_COLORS = [
    ['#8A8FA8', '#FFFFFF'], ['#6CA7B8', '#FFFFFF'], ['#6CC28A', '#14151F'], ['#4FC1B9', '#14151F'], ['#5BA4E6', '#FFFFFF'],
    ['#8E9BF0', '#FFFFFF'], ['#B48EE0', '#FFFFFF'], ['#E0709B', '#FFFFFF'], ['#F08A3C', '#14151F'], ['#F2C14E', '#14151F']
  ];

  /** level(tokens) -> { level (1..10), title, progress (0..1 toward next), floor, next (null at max) }. */
  function level(tokens) {
    const n = Math.max(0, Number(tokens) || 0);
    let i = 0;
    while (i + 1 < THRESHOLDS.length && n >= THRESHOLDS[i + 1]) i++;
    const floor = THRESHOLDS[i];
    const next = i + 1 < THRESHOLDS.length ? THRESHOLDS[i + 1] : null;
    const progress = next === null ? 1 : Math.max(0, Math.min(1, (n - floor) / (next - floor)));
    return { level: i + 1, title: TITLES[i], progress, floor, next };
  }

  /** Just the level number (cheap, no allocation). */
  function levelOf(tokens) {
    const n = Math.max(0, Number(tokens) || 0);
    let i = 0;
    while (i + 1 < THRESHOLDS.length && n >= THRESHOLDS[i + 1]) i++;
    return i + 1;
  }

  function titleOf(lvl) { return TITLES[Math.max(1, Math.min(MAX_LEVEL, lvl | 0)) - 1]; }

  /** { bg, fg } colours for a level badge. */
  function levelColor(lvl) {
    const c = LEVEL_COLORS[Math.max(1, Math.min(MAX_LEVEL, lvl | 0)) - 1];
    return { bg: c[0], fg: c[1] };
  }

  // ------------------------------------------------------------------ achievements
  /** Fresh stats object (all counters at 0). main.js accumulates it from the store + SSE logs. */
  function emptyStats() {
    return {
      totalTokens: 0, agentsLaunched: 0, toolsUsed: 0, reads: 0, searches: 0, edits: 0, writes: 0, bashes: 0,
      tests: 0, gits: 0, webs: 0, tasks: 0, errors: 0, done: 0, subagents: 0, terminalSessions: 0, reposLinked: 0, maxConcurrent: 0
    };
  }
  function n(s, k) { return s && typeof s[k] === 'number' && isFinite(s[k]) ? s[k] : 0; }

  const ACHIEVEMENTS = [
    { id: 'premier-pas', icon: 'star', title: 'Premier pas', description: 'Lance ton tout premier pix.', test: (s) => n(s, 'agentsLaunched') >= 1 },
    { id: 'mission-accomplie', icon: 'trophy', title: 'Mission accomplie', description: 'Termine 10 tâches avec succès.', test: (s) => n(s, 'done') >= 10 },
    { id: 'open-space', icon: 'crown', title: 'Open space bondé', description: 'Fais travailler 5 pix en même temps.', test: (s) => n(s, 'maxConcurrent') >= 5 },
    { id: 'fourmiliere', icon: 'flame', title: 'La fourmilière', description: 'Atteins 12 pix actifs en même temps.', test: (s) => n(s, 'maxConcurrent') >= 12 },
    { id: 'rat-de-bibliotheque', icon: 'book', title: 'Rat de bibliothèque', description: 'Fais lire 100 fichiers à tes pix.', test: (s) => n(s, 'reads') >= 100 },
    { id: 'sherlock', icon: 'magnifier', title: 'Sherlock', description: 'Lance 50 recherches dans le code.', test: (s) => n(s, 'searches') >= 50 },
    { id: 'plume-infatigable', icon: 'pencil', title: 'Plume infatigable', description: 'Cumule 100 modifications ou créations de fichiers.', test: (s) => n(s, 'edits') + n(s, 'writes') >= 100 },
    { id: 'pilote-de-terminal', icon: 'terminal', title: 'Pilote de terminal', description: 'Exécute 100 commandes.', test: (s) => n(s, 'bashes') >= 100 },
    { id: 'tout-est-vert', icon: 'check', title: 'Tout est vert', description: 'Lance 25 séries de tests ou de builds.', test: (s) => n(s, 'tests') >= 25 },
    { id: 'facteur', icon: 'letter', title: 'Le facteur sonne toujours deux fois', description: 'Envoie 20 opérations git au bureau de poste.', test: (s) => n(s, 'gits') >= 20 },
    { id: 'globe-trotteur', icon: 'globe', title: 'Globe-trotteur', description: 'Visite le web 30 fois.', test: (s) => n(s, 'webs') >= 30 },
    { id: 'chef-orchestre', icon: 'crown', title: "Chef d'orchestre", description: 'Fais naître 10 sous-pix.', test: (s) => n(s, 'subagents') >= 10 },
    { id: 'post-it', icon: 'clock', title: 'Roi du post-it', description: 'Organise ou délègue 20 tâches en réunion.', test: (s) => n(s, 'tasks') >= 20 },
    { id: 'boite-a-outils', icon: 'wrench', title: 'Boîte à outils', description: 'Utilise 500 outils au total.', test: (s) => n(s, 'toolsUsed') >= 500 },
    { id: 'premier-million', icon: 'coin', title: 'Premier million', description: 'Dépense 1 000 000 tokens.', test: (s) => n(s, 'totalTokens') >= 1000000 },
    { id: 'tirelire-cosmique', icon: 'bolt', title: 'Tirelire cosmique', description: 'Dépasse les 10 000 000 tokens.', test: (s) => n(s, 'totalTokens') >= 10000000 },
    { id: 'meme-pas-mal', icon: 'heart', title: 'Même pas mal', description: 'Survis à 10 erreurs sans perdre le sourire.', test: (s) => n(s, 'errors') >= 10 },
    { id: 'hacker', icon: 'terminal', title: 'Hacker du dimanche', description: 'Ouvre ton premier terminal intégré.', test: (s) => n(s, 'terminalSessions') >= 1 },
    { id: 'bibliophile', icon: 'book', title: 'Bibliophile', description: 'Relie 3 dépôts de skills à ta bibliothèque.', test: (s) => n(s, 'reposLinked') >= 3 }
  ];

  /** Achievements newly satisfied by `stats` and not in `unlocked` (array or Set of ids). Never throws. */
  function checkAchievements(stats, unlocked) {
    const has = unlocked instanceof Set ? (id) => unlocked.has(id)
      : Array.isArray(unlocked) ? (id) => unlocked.indexOf(id) >= 0 : () => false;
    const out = [];
    for (const a of ACHIEVEMENTS) {
      if (has(a.id)) continue;
      let ok = false;
      try { ok = !!a.test(stats || {}); } catch (e) { ok = false; }
      if (ok) out.push(a);
    }
    return out;
  }

  // ------------------------------------------------------------------ pixel icons
  const K = '#14151F';
  const ICON_DEFS = {
    lightbulb: { rows: ['..yyyy..', '.yywyyy.', 'yywyyyyy', 'yyyyyyyy', 'yyyyyyyy', '.yyyyyy.', '..gggg..', '..hhhh..', '...gg...'],
      colors: { y: '#FFD84A', w: '#FFFBE0', g: '#A0A7B8', h: '#6E7489' } },
    coin: { rows: ['..yyyy..', '.yywwyy.', 'yywyyyoy', 'yywyyyoy', 'yyyyyyoy', 'yyyyyyoy', '.yooooy.', '..yyyy..'],
      colors: { y: '#F2C14E', w: '#FFF3B0', o: '#C98E1E' } },
    star: { rows: ['....y....', '...yyy...', 'yyyywyyyy', '.yyyyyyy.', '..yyyyy..', '.yyy.yyy.', '.yy...yy.'],
      colors: { y: '#FFD84A', w: '#FFFBE0' } },
    trophy: { rows: ['.yyyyyyy.', 'yyywyyyyy', 'y.ywyyy.y', '.yyyyyyy.', '..yyyyy..', '...yyy...', '....y....', '...ooo...', '..ooooo..'],
      colors: { y: '#F2C14E', w: '#FFF3B0', o: '#B8862A' } },
    book: { rows: ['dbbbbbb', 'dbbybbb', 'dbbbbbb', 'dbbbbbb', 'dbbbbbb', 'dwwwwww'],
      colors: { d: '#8E2F2A', b: '#C2453D', y: '#F2C14E', w: '#EFE9DC' } },
    wrench: { rows: ['.....g.g', '.....g.g', '....gggg', '...ggw..', '..ggw...', '.ggw....', 'ggw.....', 'gg......'],
      colors: { g: '#A0A7B8', w: '#D9DCE6' } },
    terminal: { rows: ['fffffffff', 'ddddddddd', 'dgddddddd', 'ddgdddddd', 'dgddgggdd', 'ddddddddd'],
      colors: { f: '#A0A7B8', d: '#262A3D', g: '#6CC28A' } },
    globe: { rows: ['..bbbb..', '.bggbbb.', 'bbgggbbb', 'bbbggbgb', 'bbbbbggb', 'bgbbbggb', '.bgbbbb.', '..bbbb..'],
      colors: { b: '#3D7FD0', g: '#6CC28A' } },
    letter: { rows: ['wwwwwwwww', 'wlwwwwwlw', 'wwlwwwlww', 'wwwlrlwww', 'wwwwwwwww', 'wwwwwwwww'],
      colors: { w: '#F7F4EC', l: '#B9B2A2', r: '#E5534B' } },
    heart: { rows: ['.rr.rr.', 'rwrrrrr', 'rrrrrrr', '.rrrrr.', '..rrr..', '...r...'],
      colors: { r: '#E5534B', w: '#FFB3AE' } },
    bolt: { rows: ['...yyy', '..yyy.', '.yyy..', 'yyyyyy', '...yy.', '..yy..', '.yy...', 'yy....'],
      colors: { y: '#FFD84A' } },
    clock: { rows: ['..wwww..', '.wwwhww.', 'wwwwhwww', 'wwwwhwww', 'wwwwhhhw', 'wwwwwwww', '.wwwwww.', '..wwww..'],
      colors: { w: '#ECE8F4', h: '#14151F' } },
    flame: { rows: ['...r...', '...rr..', '..rrr..', '.rrorr.', '.roorr.', 'rrooorr', 'rooyyor', 'rooyyor', '.rooor.'],
      colors: { r: '#E5534B', o: '#F08A3C', y: '#FFD84A' } },
    crown: { rows: ['y...y...y', 'yy.yyy.yy', 'yyyyyyyyy', 'yyryybyry', 'yyyyyyyyy', 'ooooooooo'],
      colors: { y: '#F2C14E', o: '#B8862A', r: '#E5534B', b: '#5BA4E6' } },
    // ---- extras used by the game (emotes, items, scene bubbles) and available to the HUD
    magnifier: { rows: ['.ggg...', 'gwbbg..', 'gbbbg..', 'gbbbg..', '.gggh..', '....hh.', '.....hh'],
      colors: { g: '#C9CCD8', b: '#9FD3F0', w: '#FFFFFF', h: '#8A5A3C' } },
    pencil: { rows: ['.....pp', '....yyp', '...yyy.', '..yyy..', '.yyy...', 'ttt....', 'd......'],
      colors: { p: '#E0709B', y: '#F2C14E', t: '#E8C9A0', d: '#3A3B4E' } },
    paper: { rows: ['wwwwg.', 'wwwwgg', 'wllllw', 'wwwwww', 'wllllw', 'wwwwww', 'wlllww'],
      colors: { w: '#F7F4EC', g: '#CFC8B8', l: '#8E9BB0' } },
    check: { rows: ['......g', '.....gg', 'g...gg.', 'gg.gg..', '.ggg...', '..g....'],
      colors: { g: '#6CC28A' } },
    cross: { rows: ['r....r', 'rr..rr', '.rrrr.', '.rrrr.', 'rr..rr', 'r....r'],
      colors: { r: '#E5534B' } },
    mug: { rows: ['wcccw..', 'wwwwwh.', 'wwwww.h', 'wwwwwh.', '.www...'],
      colors: { w: '#F3EFE6', c: '#6B4226', h: '#F3EFE6' } },
    gear: { rows: ['...gg...', '.g.gg.g.', '..gggg..', 'ggg..ggg', 'ggg..ggg', '..gggg..', '.g.gg.g.', '...gg...'],
      colors: { g: '#A0A7B8' } },
    question: { rows: ['.www.', 'ww.ww', '...ww', '..ww.', '..w..', '.....', '..w..'],
      colors: { w: '#FFFFFF' } },
    exclaim: { rows: ['ww', 'ww', 'ww', 'ww', 'ww', '..', 'ww'],
      colors: { w: '#FF6B5E' } },
    sweat: { rows: ['..b..', '..b..', '.bbb.', 'bbwbb', 'bwbbb', 'bbbbb', '.bbb.'],
      colors: { b: '#6AA9FF', w: '#D8ECFF' } },
    note: { rows: ['..nnnnn', '..n...n', '..n...n', '.nn..nn', 'nnn.nnn', '.n...n.'],
      colors: { n: '#B48EE0' } },
    zzz: { rows: ['zzzzz', '...z.', '..z..', '.z...', 'zzzzz'],
      colors: { z: '#E8E6FF' } },
    dots: { rows: ['d.d.d'], colors: { d: '#14151F' } },
    thumb: { rows: ['...ss..', '...ss..', '..sss..', 'bssssss', 'bssssss', 'bsssss.', 'bssss..'],
      colors: { s: '#F2C14E', b: '#5BA4E6' } },
    sparkle: { rows: ['...y...', '...y...', '..yyy..', 'yyywyyy', '..yyy..', '...y...', '...y...'],
      colors: { y: '#FFD84A', w: '#FFFFFF' } },
    paw: { rows: ['.p.p.', 'p...p', '.ppp.', 'ppppp', '.ppp.'],
      colors: { p: '#E8955A' } }
  };

  /** Pre-computed horizontal runs (fill + automatic 1 px outline) per icon. */
  function compile(def, outline) {
    const rows = def.rows;
    const h = rows.length;
    let w = 0;
    for (const r of rows) w = Math.max(w, r.length);
    const W = w + 2, H = h + 2;
    const grid = new Array(W * H).fill(null);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        const c = def.colors[rows[y][x]];
        if (c) grid[(y + 1) * W + x + 1] = c;
      }
    }
    if (outline) {
      const src = grid.slice();
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (src[y * W + x] !== null) continue;
        if ((x > 0 && src[y * W + x - 1] !== null) || (x < W - 1 && src[y * W + x + 1] !== null) ||
            (y > 0 && src[(y - 1) * W + x] !== null) || (y < H - 1 && src[(y + 1) * W + x] !== null)) grid[y * W + x] = outline;
      }
    }
    const runs = [];
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        const c = grid[y * W + x];
        if (c === null) { x++; continue; }
        let e = x + 1;
        while (e < W && grid[y * W + e] === c) e++;
        runs.push(x, y, e - x, c);
        x = e;
      }
    }
    return { w: W, h: H, runs };
  }

  const ICONS = {};
  Object.keys(ICON_DEFS).forEach((name) => {
    const def = ICON_DEFS[name];
    let withOutline = null, bare = null;
    const icon = {
      name,
      rows: def.rows,
      colors: def.colors,
      /** Size including the 1 px outline. */
      get w() { return (withOutline || (withOutline = compile(def, K))).w; },
      get h() { return (withOutline || (withOutline = compile(def, K))).h; },
      /** draw(ctx, x, y, scale = 1, outline = true): crisp fillRects at integer scale. */
      draw(ctx, x, y, scale, outline) {
        const c = outline === false ? (bare || (bare = compile(def, null))) : (withOutline || (withOutline = compile(def, K)));
        const s = Math.max(1, Math.round(scale || 1));
        const r = c.runs;
        for (let i = 0; i < r.length; i += 4) {
          ctx.fillStyle = r[i + 3];
          ctx.fillRect(x + r[i] * s, y + r[i + 1] * s, r[i + 2] * s, s);
        }
      }
    };
    ICONS[name] = icon;
  });

  function makeCanvas(w, h) {
    w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h));
    if (global.document && typeof global.document.createElement === 'function') {
      const c = global.document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    if (typeof global.OffscreenCanvas === 'function') return new global.OffscreenCanvas(w, h);
    return null;
  }

  /** drawIcon(ctx, name, x, y, scale, outline) -> true when drawn. */
  function drawIcon(ctx, name, x, y, scale, outline) {
    const ic = ICONS[name];
    if (!ic || !ctx) return false;
    ic.draw(ctx, Math.round(x), Math.round(y), scale, outline);
    return true;
  }

  const canvasCache = new Map();
  /** Cached canvas of an icon at an integer scale (outline included unless outline === false). */
  function iconCanvas(name, scale, outline) {
    const ic = ICONS[name];
    if (!ic) return null;
    const s = Math.max(1, Math.round(scale || 1));
    const key = name + '|' + s + '|' + (outline === false ? 0 : 1);
    let cv = canvasCache.get(key);
    if (cv === undefined) {
      // Both variants keep the 1 px border (transparent without outline) so sizes match.
      cv = makeCanvas(ic.w * s, ic.h * s);
      if (cv) {
        const ctx = cv.getContext('2d');
        if (ctx) ic.draw(ctx, 0, 0, s, outline);
      }
      canvasCache.set(key, cv);
    }
    return cv;
  }

  const urlCache = new Map();
  /** data: URL of an icon (for <img> / CSS in the HUD). Empty string when canvases are unavailable. */
  function iconURL(name, scale, outline) {
    const key = name + '|' + (scale || 1) + '|' + (outline === false ? 0 : 1);
    if (urlCache.has(key)) return urlCache.get(key);
    let url = '';
    try {
      const cv = iconCanvas(name, scale, outline);
      if (cv && typeof cv.toDataURL === 'function') url = cv.toDataURL('image/png');
    } catch (e) { url = ''; }
    urlCache.set(key, url);
    return url;
  }

  global.HQProgression = {
    THRESHOLDS, TITLES, MAX_LEVEL,
    level, levelOf, titleOf, levelColor,
    ACHIEVEMENTS, emptyStats, checkAchievements,
    ICONS, ICON_NAMES: Object.keys(ICONS), drawIcon, iconCanvas, iconURL
  };
})(typeof window !== 'undefined' ? window : globalThis);
