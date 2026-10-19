/* PixelQG — office.js
 * The office: a 64x40 tile map (16 px tiles) with ten rooms (hall, open space, library, server room, test lab,
 * Git post office, web lab, meeting room, cafeteria and an outdoor terrace under the sky), 2-tile-high walls drawn
 * in 3/4 view (top caps, faces with mouldings and baseboards), per-room floors, a lot of procedurally drawn
 * furniture, room signs in a tiny bitmap font, a walkable grid with A* pathfinding (8 directions, no corner
 * cutting), named spots per room, desk assignment and spot reservation.
 * Static parts (floors, walls, furniture sprites, minimap) are pre-rendered once into offscreen canvases; ambient
 * life (elevator, agents board, test board, whiteboard scribbles, pneumatic tube, world map, coffee steam, server
 * LEDs and fans, conveyor, arcade, plants swaying, real-time clock, sky and windows following the time of day)
 * is drawn per frame. lighting.js adds the light layer (drawLighting). Exposes window.HQOffice.
 */
(function (global) {
  'use strict';

  const T = 16;
  const COLS = 64;
  const ROWS = 40;
  const WIDTH = COLS * T;
  const HEIGHT = ROWS * T;
  const WALL = 0;
  const FLOOR = 1;
  const SKY = 2;
  const SQRT2 = Math.SQRT2;

  // ------------------------------------------------------------------ small helpers
  /** Deterministic hash in [0, 1) for texture variation. */
  function hash(x, y, s) {
    let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul((s | 0) + 1, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  /** Seeded PRNG (mulberry32). */
  function rng(seed) {
    let a = (seed | 0) + 0x6D2B79F5;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeCanvas(w, h) {
    if (global.HQSprites && global.HQSprites.makeCanvas) return global.HQSprites.makeCanvas(w, h);
    if (global.document && typeof global.document.createElement === 'function') {
      const c = global.document.createElement('canvas');
      c.width = Math.max(1, Math.ceil(w)); c.height = Math.max(1, Math.ceil(h));
      return c;
    }
    return null;
  }

  function px(ctx, x, y, w, h, c) {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ------------------------------------------------------------------ colours
  function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return [200, 200, 210];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function byte(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }
  function toHex(r, g, b) { return '#' + ((1 << 24) | (byte(r) << 16) | (byte(g) << 8) | byte(b)).toString(16).slice(1).toUpperCase(); }
  function mixHex(a, b, k) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return toHex(A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k, A[2] + (B[2] - A[2]) * k);
  }
  /** f > 0 lightens toward white, f < 0 darkens toward black. */
  function shadeHex(hex, f) {
    const c = hexToRgb(hex);
    if (f >= 0) return toHex(c[0] + (255 - c[0]) * f, c[1] + (255 - c[1]) * f, c[2] + (255 - c[2]) * f);
    return toHex(c[0] * (1 + f), c[1] * (1 + f), c[2] * (1 + f));
  }
  function normColor(c, fallback) {
    return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : (fallback || '#9BE3C8');
  }

  // ------------------------------------------------------------------ 3x5 bitmap font (signs, boards, plates)
  const GLYPHS = {
    A: ['.#.', '#.#', '###', '#.#', '#.#'], B: ['##.', '#.#', '##.', '#.#', '##.'],
    C: ['.##', '#..', '#..', '#..', '.##'], D: ['##.', '#.#', '#.#', '#.#', '##.'],
    E: ['###', '#..', '##.', '#..', '###'], F: ['###', '#..', '##.', '#..', '#..'],
    G: ['.##', '#..', '#.#', '#.#', '.##'], H: ['#.#', '#.#', '###', '#.#', '#.#'],
    I: ['###', '.#.', '.#.', '.#.', '###'], J: ['..#', '..#', '..#', '#.#', '.#.'],
    K: ['#.#', '#.#', '##.', '#.#', '#.#'], L: ['#..', '#..', '#..', '#..', '###'],
    M: ['#.#', '###', '###', '#.#', '#.#'], N: ['##.', '#.#', '#.#', '#.#', '#.#'],
    O: ['.#.', '#.#', '#.#', '#.#', '.#.'], P: ['##.', '#.#', '##.', '#..', '#..'],
    Q: ['.#.', '#.#', '#.#', '##.', '.##'], R: ['##.', '#.#', '##.', '#.#', '#.#'],
    S: ['.##', '#..', '.#.', '..#', '##.'], T: ['###', '.#.', '.#.', '.#.', '.#.'],
    U: ['#.#', '#.#', '#.#', '#.#', '###'], V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
    W: ['#.#', '#.#', '###', '###', '#.#'], X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
    Y: ['#.#', '#.#', '.#.', '.#.', '.#.'], Z: ['###', '..#', '.#.', '#..', '###'],
    0: ['###', '#.#', '#.#', '#.#', '###'], 1: ['.#.', '##.', '.#.', '.#.', '###'],
    2: ['##.', '..#', '.#.', '#..', '###'], 3: ['##.', '..#', '.#.', '..#', '##.'],
    4: ['#.#', '#.#', '###', '..#', '..#'], 5: ['###', '#..', '##.', '..#', '##.'],
    6: ['.##', '#..', '###', '#.#', '###'], 7: ['###', '..#', '.#.', '.#.', '.#.'],
    8: ['###', '#.#', '###', '#.#', '###'], 9: ['###', '#.#', '###', '..#', '##.'],
    ' ': ['...', '...', '...', '...', '...'], '-': ['...', '...', '###', '...', '...'],
    '.': ['...', '...', '...', '...', '.#.'], '!': ['.#.', '.#.', '.#.', '...', '.#.'],
    "'": ['.#.', '.#.', '...', '...', '...'], ':': ['...', '.#.', '...', '.#.', '...'],
    '+': ['...', '.#.', '###', '.#.', '...'], '/': ['..#', '..#', '.#.', '#..', '#..'],
    '?': ['##.', '..#', '.#.', '...', '.#.'], '_': ['...', '...', '...', '...', '###'],
    '>': ['#..', '.#.', '..#', '.#.', '#..'], '<': ['..#', '.#.', '#..', '.#.', '..#'],
    '#': ['#.#', '###', '#.#', '###', '#.#'], '%': ['#.#', '..#', '.#.', '#..', '#.#'],
    '(': ['.#.', '#..', '#..', '#..', '.#.'], ')': ['.#.', '..#', '..#', '..#', '.#.'],
    '=': ['...', '###', '...', '###', '...'], '*': ['...', '#.#', '.#.', '#.#', '...']
  };
  const ACCENTS = {
    'É': ['E', 'acute'], 'È': ['E', 'grave'], 'Ê': ['E', 'circ'], 'Ë': ['E', 'trema'], 'À': ['A', 'grave'], 'Â': ['A', 'circ'],
    'Ç': ['C', 'cedil'], 'Ô': ['O', 'circ'], 'Û': ['U', 'circ'], 'Ù': ['U', 'grave'], 'Î': ['I', 'circ'], 'Ï': ['I', 'trema'], 'Ü': ['U', 'trema']
  };

  /** Width in pixels of a string in the 3x5 font (scale 1). */
  function measurePixelText(text) {
    const n = String(text).length;
    return n > 0 ? n * 4 - 1 : 0;
  }

  /** Draws upper-case text in the 3x5 font; (x, y) is the top of the letters (accents go 2 px above). */
  function drawPixelText(ctx, text, x, y, color, scale) {
    const s = scale || 1;
    ctx.fillStyle = color;
    let cx = x;
    for (const raw of String(text).toUpperCase()) {
      let ch = raw, accent = null;
      if (ACCENTS[ch]) { accent = ACCENTS[ch][1]; ch = ACCENTS[ch][0]; }
      const g = GLYPHS[ch] || GLYPHS[' '];
      for (let r = 0; r < 5; r++) {
        const row = g[r];
        for (let c = 0; c < 3; c++) if (row.charCodeAt(c) === 35) ctx.fillRect(cx + c * s, y + r * s, s, s);
      }
      if (accent === 'acute') ctx.fillRect(cx + 2 * s, y - 2 * s, s, s);
      else if (accent === 'grave') ctx.fillRect(cx, y - 2 * s, s, s);
      else if (accent === 'circ') { ctx.fillRect(cx, y - s, s, s); ctx.fillRect(cx + s, y - 2 * s, s, s); ctx.fillRect(cx + 2 * s, y - s, s, s); }
      else if (accent === 'trema') { ctx.fillRect(cx, y - 2 * s, s, s); ctx.fillRect(cx + 2 * s, y - 2 * s, s, s); }
      else if (accent === 'cedil') ctx.fillRect(cx + s, y + 5 * s, s, s);
      cx += 4 * s;
    }
  }

  /** Upper-cases and trims a string so that it fits maxPx in the 3x5 font. */
  function fitPixelText(text, maxPx) {
    let s = String(text == null ? '' : text).toUpperCase().replace(/\s+/g, ' ').trim();
    while (s.length > 1 && measurePixelText(s) > maxPx) s = s.slice(0, -1);
    return s.trim();
  }

  // ------------------------------------------------------------------ time of day
  /**
   * Keyframes of the day → golden hour → night palette. amb/out = light multipliers (indoor / outdoor),
   * lamp = how much lamps are on, sun = daylight strength (window shafts), stars = star visibility.
   */
  const TOD_KEYS = [
    { h: 0, top: '#060A1C', mid: '#0D1533', bot: '#1B2652', amb: [0.50, 0.53, 0.76], out: [0.34, 0.38, 0.62], lamp: 1, sun: 0, stars: 1, sc: '#FFF4D6' },
    { h: 5, top: '#090E25', mid: '#141C42', bot: '#27315F', amb: [0.52, 0.55, 0.78], out: [0.36, 0.40, 0.64], lamp: 1, sun: 0, stars: 0.9, sc: '#FFF4D6' },
    { h: 6.6, top: '#2E3770', mid: '#8C6C9C', bot: '#F2A988', amb: [0.80, 0.76, 0.84], out: [0.72, 0.64, 0.74], lamp: 0.55, sun: 0.35, stars: 0.15, sc: '#FFC28C' },
    { h: 8, top: '#4F95E0', mid: '#86BDF0', bot: '#CFEAF8', amb: [1, 1, 1], out: [1, 1, 1], lamp: 0, sun: 1, stars: 0, sc: '#FFF4D6' },
    { h: 16.4, top: '#4C90DC', mid: '#84BAEE', bot: '#D2EAF6', amb: [1, 1, 1], out: [1, 1, 1], lamp: 0, sun: 1, stars: 0, sc: '#FFF2D0' },
    { h: 18.2, top: '#D6724E', mid: '#F0A060', bot: '#FCD98C', amb: [1, 0.92, 0.80], out: [1, 0.87, 0.72], lamp: 0.3, sun: 0.85, stars: 0, sc: '#FFA35C' },
    { h: 19.6, top: '#463A78', mid: '#B0607A', bot: '#F29A6A', amb: [0.78, 0.71, 0.80], out: [0.64, 0.55, 0.69], lamp: 0.8, sun: 0.22, stars: 0.3, sc: '#FF8A5C' },
    { h: 21, top: '#0B1130', mid: '#18214A', bot: '#2B3568', amb: [0.54, 0.57, 0.79], out: [0.38, 0.42, 0.66], lamp: 1, sun: 0, stars: 0.85, sc: '#FFF4D6' },
    { h: 24, top: '#060A1C', mid: '#0D1533', bot: '#1B2652', amb: [0.50, 0.53, 0.76], out: [0.34, 0.38, 0.62], lamp: 1, sun: 0, stars: 1, sc: '#FFF4D6' }
  ];

  function lerp(a, b, k) { return a + (b - a) * k; }

  /** Interpolated palette for a float hour (0–24). */
  function computeTod(hours) {
    let h = Number(hours);
    if (!isFinite(h)) h = 12;
    h = ((h % 24) + 24) % 24;
    let i = 0;
    while (i < TOD_KEYS.length - 2 && TOD_KEYS[i + 1].h <= h) i++;
    const a = TOD_KEYS[i], b = TOD_KEYS[i + 1];
    let k = (h - a.h) / Math.max(1e-6, b.h - a.h);
    k = clamp(k, 0, 1);
    k = k * k * (3 - 2 * k);   // smoothstep: softer transitions
    const tod = {
      hours: h,
      top: mixHex(a.top, b.top, k), mid: mixHex(a.mid, b.mid, k), bot: mixHex(a.bot, b.bot, k),
      amb: [lerp(a.amb[0], b.amb[0], k), lerp(a.amb[1], b.amb[1], k), lerp(a.amb[2], b.amb[2], k)],
      out: [lerp(a.out[0], b.out[0], k), lerp(a.out[1], b.out[1], k), lerp(a.out[2], b.out[2], k)],
      lamp: lerp(a.lamp, b.lamp, k), sun: lerp(a.sun, b.sun, k), stars: lerp(a.stars, b.stars, k),
      sunColor: mixHex(a.sc, b.sc, k)
    };
    // Seven sky bands from zenith to horizon (pre-computed strings: no per-frame allocation).
    tod.bands = [];
    for (let j = 0; j < 7; j++) {
      const q = j / 6;
      tod.bands.push(q < 0.5 ? mixHex(tod.top, tod.mid, q * 2) : mixHex(tod.mid, tod.bot, (q - 0.5) * 2));
    }
    tod.night = clamp((1 - (tod.amb[0] + tod.amb[1] + tod.amb[2]) / 3) / 0.36, 0, 1);   // 0 day … 1 night
    // Sun arc 6.6 h → 19.6 h, moon the rest of the time (frac 0..1 across the sky band).
    if (h >= 6.6 && h <= 19.6) { tod.body = 'sun'; tod.bodyFrac = (h - 6.6) / 13; }
    else { tod.body = 'moon'; tod.bodyFrac = ((h < 6.6 ? h + 24 : h) - 19.6) / 11; }
    tod.glassTop = mixHex(tod.top, '#0E1430', 0.15);
    tod.glassMid = mixHex(tod.mid, '#0E1430', 0.15);
    tod.glassBot = mixHex(tod.bot, '#0E1430', 0.15);
    tod.cloud = mixHex('#FFFFFF', tod.bot, 0.35 + tod.night * 0.45);
    tod.cloudShade = mixHex(tod.cloud, tod.mid, 0.4);
    tod.skyline = mixHex('#3A4466', tod.top, 0.35 + tod.night * 0.3);
    tod.skylineFar = mixHex(tod.skyline, tod.bot, 0.45);
    return tod;
  }

  function localHours() {
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }

  // ------------------------------------------------------------------ layout data
  /**
   * Rooms (rects in tiles). label = French name for tooltips, sign = text painted on the wall plaque,
   * short = minimap label, signAt = plaque centre (px) on the wall cap row, gather = default floor point.
   */
  const ROOM_DEFS = [
    { id: 'lobby', label: "Hall d'entrée", sign: "HALL D'ENTRÉE", short: 'HALL', x: 16, y: 24, w: 22, h: 14, floor: 'marble', accent: '#F2C14E',
      wall: { face: '#6B4E3A', low: '#4E3828', trim: '#9A7656', pattern: 'wood' }, signAt: { cx: 21.5 * T, row: 22 }, gather: { x: 26, y: 27 },
      blurb: "Le hall : les agents arrivent par l'ascenseur et repartent par là quand tu les retires." },
    { id: 'open', label: 'Open space', sign: 'OPEN SPACE', short: 'OPEN SPACE', x: 16, y: 2, w: 22, h: 20, floor: 'wood', accent: '#D97757',
      wall: { face: '#5A5078', low: '#433B5E', trim: '#7E74A2', pattern: 'stripe' }, signAt: { cx: 27 * T, row: 0 }, gather: { x: 26, y: 18 },
      blurb: "L'open space : chaque agent a son bureau pour écrire, modifier du code et réfléchir." },
    { id: 'library', label: 'Bibliothèque', sign: 'BIBLIOTHÈQUE', short: 'BIBLIO', x: 1, y: 2, w: 14, h: 10, floor: 'carpet', accent: '#7BC67E',
      wall: { face: '#3F5B4D', low: '#2E4439', trim: '#6E8C70', pattern: 'wood' }, signAt: { cx: 8 * T, row: 0 }, gather: { x: 7, y: 10 },
      blurb: 'La bibliothèque : on y lit des fichiers et on cherche dans le code. Tes dépôts liés sont rangés sur les étagères.' },
    { id: 'servers', label: 'Salle serveurs', sign: 'SALLE SERVEURS', short: 'SERVEURS', x: 39, y: 13, w: 12, h: 11, floor: 'metal', accent: '#5BA4E6',
      wall: { face: '#2F3A52', low: '#232C40', trim: '#4C5A7C', pattern: 'metal' }, signAt: { cx: 45.5 * T, row: 11 }, gather: { x: 45, y: 17 },
      blurb: 'La salle serveurs : toutes les commandes shell tournent ici, au milieu des baies qui clignotent.' },
    { id: 'tests', label: 'Salle de tests', sign: 'SALLE DE TESTS', short: 'TESTS', x: 52, y: 13, w: 11, h: 11, floor: 'lab', accent: '#6CC28A',
      wall: { face: '#3D4E5C', low: '#2D3B47', trim: '#62798A', pattern: 'panel' }, signAt: null, gather: { x: 57, y: 16 },
      blurb: 'La salle de tests : tests, lint et builds. Le grand tableau garde les derniers résultats, vert ou rouge.' },
    { id: 'post', label: 'Bureau de poste Git', sign: 'POSTE GIT', short: 'POSTE GIT', x: 39, y: 26, w: 12, h: 12, floor: 'terracotta', accent: '#F0A35A',
      wall: { face: '#7A4A3A', low: '#5A3428', trim: '#A86E52', pattern: 'brick' }, signAt: { cx: 49.2 * T, row: 24 }, gather: { x: 44, y: 35 },
      blurb: 'Le bureau de poste Git : commits, push, pull et merges partent et arrivent par le tube pneumatique.' },
    { id: 'web', label: 'Labo web', sign: 'LABO WEB', short: 'WEB', x: 52, y: 26, w: 11, h: 12, floor: 'tech', accent: '#4FC1B9',
      wall: { face: '#28414D', low: '#1D313A', trim: '#3F6675', pattern: 'circuit' }, signAt: { cx: 53.6 * T, row: 24 }, gather: { x: 57, y: 33 },
      blurb: 'Le labo web : recherches sur internet, pages consultées et outils MCP, en direct sur la carte du monde.' },
    { id: 'meeting', label: 'Salle de réunion', sign: 'SALLE DE RÉUNION', short: 'RÉUNION', x: 1, y: 14, w: 14, h: 10, floor: 'meeting', accent: '#B48EE0',
      wall: { face: '#4C4766', low: '#3A3652', trim: '#6E6696', pattern: 'stripe' }, signAt: { cx: 6.5 * T, row: 12 }, gather: { x: 7, y: 22 },
      blurb: 'La salle de réunion : délégation aux sous-agents et organisation des tâches autour de la grande table.' },
    { id: 'cafe', label: 'Cafétéria', sign: 'CAFÉTÉRIA', short: 'CAFÉ', x: 1, y: 26, w: 14, h: 12, floor: 'cafe', accent: '#E8955A',
      wall: { face: '#C9B79C', low: '#9E8A6E', trim: '#E6D8BE', pattern: 'tile' }, signAt: { cx: 6 * T, row: 24 }, gather: { x: 7, y: 32 },
      blurb: 'La cafétéria : les agents qui ont fini ou qui sont en pause viennent boire un café et jouer au baby-foot.' },
    { id: 'terrace', label: 'Terrasse', sign: 'TERRASSE', short: 'TERRASSE', x: 39, y: 4, w: 24, h: 7, floor: 'deck', accent: '#C9D86B', outdoor: true,
      wall: { face: '#5A5078', low: '#433B5E', trim: '#7E74A2', pattern: 'stripe' }, signAt: null, gather: { x: 50, y: 9 },
      blurb: "La terrasse : un coin au grand air, avec le ciel qui suit l'heure de la journée, pour les agents qui attendent." }
  ];

  /** Named spots: tile, facing, the pose played on arrival and an optional carried item. */
  function S(x, y, facing, pose, item, oy) { const s = { x, y, facing, pose }; if (item) s.item = item; if (oy) s.oy = oy; return s; }
  const SPOT_DEFS = {
    lobby: [
      S(20, 28, 'up', 'stand'), S(21, 28, 'up', 'stand'),
      S(31, 33, 'down', 'sit', null, -3), S(32, 33, 'down', 'sit', null, -3), S(33, 33, 'down', 'sit', null, -3), S(34, 33, 'down', 'sit', null, -3),
      S(18, 33, 'down', 'sit', null, -2), S(19, 33, 'down', 'sit', null, -2), S(20, 33, 'down', 'sit', null, -2)
    ],
    open: [
      S(24, 3, 'up', 'board', 'marker'), S(16, 3, 'up', 'coffee', 'mug'), S(36, 2, 'right', 'stand', 'paper'),
      S(23, 20, 'down', 'sit', null, -2), S(30, 20, 'down', 'sit', null, -2)
    ],
    library: [
      S(2, 3, 'up', 'read', 'book'), S(4, 3, 'up', 'read', 'book'), S(10, 3, 'up', 'read', 'magnifier'), S(12, 3, 'up', 'read', 'book'), S(14, 3, 'up', 'read', 'magnifier'),
      S(4, 6, 'right', 'read', 'book'), S(9, 6, 'left', 'read', 'book'),
      S(6, 8, 'up', 'read', 'book'), S(7, 8, 'up', 'read', 'magnifier'),
      S(6, 5, 'down', 'read', 'book'), S(7, 5, 'down', 'read', 'magnifier'),
      S(11, 9, 'down', 'sit', 'book', -2), S(13, 9, 'down', 'sit', 'book', -2)
    ],
    servers: [
      S(43, 16, 'up', 'rack', 'laptop'), S(46, 16, 'up', 'rack', 'laptop'), S(49, 16, 'up', 'rack', 'laptop'),
      S(43, 20, 'up', 'rack', 'laptop'), S(46, 20, 'up', 'rack', 'laptop'), S(49, 20, 'up', 'rack', 'laptop'),
      S(41, 19, 'right', 'rack', 'laptop'), S(47, 23, 'up', 'screen', 'laptop', -4)
    ],
    tests: [
      S(54, 14, 'up', 'test', 'laptop'), S(56, 14, 'up', 'test', 'laptop'), S(58, 14, 'up', 'test', 'laptop'),
      S(54, 18, 'up', 'test', 'laptop'), S(59, 18, 'up', 'test', 'laptop'),
      S(55, 22, 'up', 'test', 'laptop'), S(58, 22, 'up', 'test', 'laptop')
    ],
    post: [
      S(40, 27, 'up', 'mail', 'letter'), S(42, 27, 'up', 'mail', 'letter'), S(49, 27, 'up', 'mail', 'letter'),
      S(42, 29, 'right', 'mail', 'letter'), S(47, 29, 'left', 'mail', 'letter'),
      S(44, 31, 'up', 'mail', 'letter'), S(45, 31, 'up', 'mail', 'letter'),
      S(41, 34, 'up', 'mail', 'letter'), S(43, 34, 'up', 'mail', 'letter'), S(47, 34, 'up', 'mail', 'letter')
    ],
    web: [
      S(56, 27, 'up', 'screen', 'globe'), S(58, 27, 'up', 'screen', 'globe'), S(60, 27, 'up', 'screen', 'globe'),
      S(55, 30, 'right', 'screen', 'tablet'), S(58, 30, 'left', 'screen', 'tablet'), S(56, 31, 'up', 'screen', 'globe'), S(57, 31, 'up', 'screen', 'tablet'),
      S(53, 35, 'up', 'type', 'tablet', -5), S(56, 35, 'up', 'type', 'tablet', -5), S(59, 35, 'right', 'screen', 'tablet')
    ],
    meeting: [
      S(5, 14, 'up', 'board', 'marker'), S(7, 14, 'up', 'board', 'marker'), S(12, 14, 'up', 'screen'),
      S(5, 17, 'down', 'sit', 'paper', -2), S(7, 17, 'down', 'sit', 'paper', -2), S(9, 17, 'down', 'sit', 'paper', -2), S(11, 17, 'down', 'sit', 'paper', -2),
      S(5, 20, 'up', 'sit', 'paper', -3), S(7, 20, 'up', 'sit', 'paper', -3), S(9, 20, 'up', 'sit', 'paper', -3), S(11, 20, 'up', 'sit', 'paper', -3),
      S(3, 18, 'right', 'sit', 'paper', -2), S(12, 18, 'left', 'sit', 'paper', -2)
    ],
    cafe: [
      S(5, 27, 'up', 'coffee', 'mug'), S(7, 27, 'up', 'coffee', 'mug'), S(9, 27, 'up', 'stand'),
      S(12, 27, 'up', 'screen'), S(13, 27, 'up', 'screen'),
      S(4, 30, 'right', 'sit', 'mug', -2), S(6, 30, 'left', 'sit', 'mug', -2), S(9, 30, 'right', 'sit', 'mug', -2), S(11, 30, 'left', 'sit', 'mug', -2),
      S(2, 34, 'down', 'sit', 'mug', -3), S(3, 34, 'down', 'sit', 'mug', -3), S(4, 34, 'down', 'sit', 'mug', -3), S(5, 34, 'down', 'sit', 'mug', -3),
      S(10, 32, 'down', 'stand'), S(10, 35, 'up', 'stand')
    ],
    terrace: [
      S(43, 4, 'up', 'stand'), S(51, 4, 'up', 'stand'), S(59, 4, 'up', 'stand'), S(61, 5, 'up', 'stand'),
      S(42, 7, 'down', 'sit', null, -2), S(43, 7, 'down', 'sit', null, -2), S(44, 7, 'down', 'sit', null, -2),
      S(52, 7, 'down', 'sit', null, -2), S(53, 7, 'down', 'sit', null, -2), S(54, 7, 'down', 'sit', null, -2),
      S(57, 8, 'down', 'sit', null, -1), S(59, 8, 'down', 'sit', null, -1),
      S(47, 7, 'right', 'sit', 'mug', -2), S(49, 7, 'left', 'sit', 'mug', -2)
    ]
  };

  /** Doorways between rooms (tiles carved through the walls). */
  const DOORWAYS = [
    [15, 6], [15, 7], [15, 17], [15, 18], [15, 30], [15, 31],
    [38, 6], [38, 7], [38, 16], [38, 17], [38, 30], [38, 31],
    [51, 17], [51, 18], [51, 30], [51, 31],
    [2, 12], [3, 12], [2, 13], [3, 13], [2, 24], [3, 24], [2, 25], [3, 25],
    [17, 22], [18, 22], [17, 23], [18, 23], [36, 22], [37, 22], [36, 23], [37, 23],
    [40, 11], [41, 11], [40, 12], [41, 12], [44, 24], [45, 24], [44, 25], [45, 25],
    [61, 24], [62, 24], [61, 25], [62, 25]
  ];
  /** Tiles in front of the elevator doors (spawn and exit). */
  const ELEVATOR = [[26, 24], [27, 24]];
  const DESK_COLS = [18, 23, 28, 33];
  const DESK_ROWS = [4, 8, 12, 16];
  /** Desks are handed out centre-first so a small team sits together. */
  const DESK_ORDER = [5, 6, 9, 10, 4, 7, 8, 11, 1, 2, 13, 14, 0, 3, 12, 15];

  function isSkyTile(x, y) { return (x >= 39 && y <= 3) || (x === 63 && y <= 10); }

  /**
   * Furniture: kind, footprint (tiles), whether it blocks walking, extra path cost, how many px it rises
   * above its footprint (3/4 view) and its layer: "base" = baked into the floor canvas, "sorted" = depth-sorted
   * with characters. Seats (couches, benches, armchairs) do not block and sort by their top edge so a sitting
   * character is drawn over them.
   */
  function furnitureList() {
    const F = [];
    const add = (kind, x, y, w, h, o) => { const f = Object.assign({ kind, x, y, w, h, block: true, cost: 0, rise: 0, layer: 'sorted', seed: F.length * 7 + 3 }, o || {}); F.push(f); return f; };
    const seat = (kind, x, y, w, h, o) => add(kind, x, y, w, h, Object.assign({ block: false, cost: 3, seat: true }, o || {}));
    const base = (kind, x, y, w, h, o) => add(kind, x, y, w, h, Object.assign({ block: false, layer: 'base' }, o || {}));
    // Open space: 16 desks in four rows.
    DESK_ROWS.forEach((dy, r) => DESK_COLS.forEach((dx, c) => {
      add('desk', dx, dy, 2, 1, { rise: 13, desk: r * DESK_COLS.length + c });
      base('chair', dx, dy + 1, 1, 1, { dir: 'up', tint: '#3C4160' });
    }));
    base('rug', 21, 19, 12, 3, { color: '#5E4A6E', border: '#8E74A6' });
    add('cooler', 16, 2, 1, 1, { rise: 12 });
    add('printer', 37, 2, 1, 1, { rise: 8 });
    add('filecab', 37, 4, 1, 1, { rise: 10 });
    add('plant', 16, 13, 1, 1, { rise: 12 });
    add('plant', 37, 10, 1, 1, { rise: 12 });
    add('plant', 37, 13, 1, 1, { rise: 12, v: 1 });
    add('plant', 16, 21, 1, 1, { rise: 12, v: 2 });
    add('plant', 35, 21, 1, 1, { rise: 12 });
    seat('beanbag', 23, 20, 1, 1, { rise: 2, color: '#E0709B' });
    seat('beanbag', 30, 20, 1, 1, { rise: 2, color: '#5BA4E6' });
    add('lowtable', 26, 20, 2, 1, { rise: 3 });
    // Library
    add('shelf', 1, 2, 2, 1, { rise: 18 });
    add('shelf', 3, 2, 2, 1, { rise: 18, ladder: true });
    add('shelf', 5, 2, 2, 1, { rise: 18 });
    add('statue', 7, 2, 1, 1, { rise: 15 });
    add('plant', 8, 2, 1, 1, { rise: 12, v: 1 });
    add('shelf', 9, 2, 2, 1, { rise: 18 });
    add('shelf', 11, 2, 2, 1, { rise: 18 });
    add('shelf', 13, 2, 2, 1, { rise: 18 });
    base('rug', 4, 5, 6, 4, { color: '#6B4A2E', border: '#C9A15C' });
    add('readtable', 5, 6, 4, 2, { rise: 4 });
    add('globe', 1, 5, 1, 1, { rise: 8 });
    add('cardcat', 1, 7, 1, 1, { rise: 10 });
    add('plant', 1, 11, 1, 1, { rise: 12 });
    base('rug', 10, 8, 5, 4, { color: '#7A3B46', border: '#C98E55' });
    add('floorlamp', 12, 8, 1, 1, { rise: 20 });
    add('sidetable', 12, 9, 1, 1, { rise: 3 });
    seat('armchair', 11, 9, 1, 1, { rise: 7 });
    seat('armchair', 13, 9, 1, 1, { rise: 7, color: '#3E6A8A' });
    // Meeting room
    base('rug', 3, 16, 10, 6, { color: '#3E4466', border: '#6F78A8' });
    add('meettable', 4, 18, 8, 2, { rise: 3 });
    [5, 7, 9, 11].forEach((x) => { base('chair', x, 17, 1, 1, { dir: 'down', tint: '#5D4E8A' }); base('chair', x, 20, 1, 1, { dir: 'up', tint: '#5D4E8A' }); });
    base('chair', 3, 18, 1, 1, { dir: 'right', tint: '#5D4E8A' });
    base('chair', 12, 18, 1, 1, { dir: 'left', tint: '#5D4E8A' });
    add('plant', 1, 14, 1, 1, { rise: 12, v: 2 });
    add('plant', 13, 22, 1, 1, { rise: 12 });
    add('plant', 1, 22, 1, 1, { rise: 12, v: 1 });
    add('credenza', 13, 15, 2, 1, { rise: 8 });
    // Cafeteria
    add('counter', 4, 26, 5, 1, { rise: 14 });
    add('fridge', 9, 26, 1, 1, { rise: 22 });
    add('vending', 10, 26, 1, 1, { rise: 22 });
    add('arcade', 12, 26, 1, 1, { rise: 22, hue: 0 });
    add('arcade', 13, 26, 1, 1, { rise: 22, hue: 1 });
    add('plant', 14, 26, 1, 1, { rise: 12, v: 1 });
    add('bistro', 5, 30, 1, 1, { rise: 4 });
    add('bistro', 10, 30, 1, 1, { rise: 4 });
    [4, 6, 9, 11].forEach((x) => base('stool', x, 30, 1, 1));
    base('rug', 1, 33, 7, 4, { color: '#7A5A3A', border: '#C98E55' });
    seat('couch', 2, 34, 4, 1, { rise: 10 });
    add('coffeetable', 3, 36, 2, 1, { rise: 3 });
    add('babyfoot', 9, 33, 3, 2, { rise: 6 });
    add('plant', 1, 37, 1, 1, { rise: 12, v: 2 });
    add('plant', 14, 37, 1, 1, { rise: 12 });
    add('plant', 13, 33, 1, 1, { rise: 12, v: 1 });
    // Lobby
    add('reception', 19, 27, 4, 1, { rise: 12 });
    base('inlay', 24, 29, 6, 5);
    seat('sofa', 31, 33, 4, 1, { rise: 10 });
    add('coffeetable', 32, 35, 2, 1, { rise: 3 });
    seat('bench', 18, 33, 3, 1, { rise: 6 });
    add('trophy', 16, 27, 1, 1, { rise: 20 });
    add('kiosk', 35, 27, 1, 1, { rise: 14 });
    base('rug', 26, 25, 2, 4, { color: '#8A2E3A', border: '#C9A15C' });
    add('aquarium', 31, 27, 3, 1, { rise: 16 });
    add('tree', 22, 30, 1, 1, { rise: 24, v: 1 });
    add('tree', 31, 30, 1, 1, { rise: 24 });
    add('tree', 16, 24, 1, 1, { rise: 24 });
    add('plant', 37, 26, 1, 1, { rise: 12 });
    add('tree', 16, 37, 1, 1, { rise: 24, v: 1 });
    add('tree', 37, 37, 1, 1, { rise: 24 });
    add('plant', 23, 37, 1, 1, { rise: 12, v: 1 });
    add('plant', 30, 37, 1, 1, { rise: 12, v: 2 });
    // Terrace
    add('planter', 39, 4, 2, 1, { rise: 10 });
    add('planter', 47, 4, 2, 1, { rise: 10, flowers: 1 });
    add('planter', 55, 4, 2, 1, { rise: 10, flowers: 2 });
    seat('bench', 42, 7, 3, 1, { rise: 6, wood: true });
    seat('bench', 52, 7, 3, 1, { rise: 6, wood: true });
    add('parasol', 48, 7, 1, 1, { rise: 30 });
    base('stool', 47, 7, 1, 1, { wood: true });
    base('stool', 49, 7, 1, 1, { wood: true });
    seat('transat', 57, 8, 1, 1, { rise: 4, color: '#E8955A' });
    seat('transat', 59, 8, 1, 1, { rise: 4, color: '#4FC1B9' });
    add('telescope', 61, 4, 1, 1, { rise: 14 });
    add('tree', 39, 10, 1, 1, { rise: 24 });
    add('tree', 62, 10, 1, 1, { rise: 24, v: 1 });
    add('plant', 50, 10, 1, 1, { rise: 12, v: 2 });
    add('plant', 45, 10, 1, 1, { rise: 12 });
    // Server room
    for (let x = 42; x <= 49; x++) { add('rack', x, 15, 1, 1, { rise: 22, row: 0 }); add('rack', x, 19, 1, 1, { rise: 22, row: 1 }); }
    add('crac', 49, 13, 2, 1, { rise: 22 });
    add('console', 47, 22, 2, 1, { rise: 11 });
    base('chair', 47, 23, 1, 1, { dir: 'up', tint: '#2E3A55' });
    add('extinguisher', 39, 22, 1, 1, { rise: 6 });
    // Test lab
    add('testbench', 53, 17, 3, 1, { rise: 12, variant: 0 });
    add('testbench', 58, 17, 3, 1, { rise: 12, variant: 1 });
    add('conveyor', 54, 21, 6, 1, { rise: 10 });
    add('plant', 62, 13, 1, 1, { rise: 12, v: 1 });
    add('toolcart', 62, 20, 1, 1, { rise: 10 });
    // Git post office
    add('pigeonholes', 39, 26, 4, 1, { rise: 18 });
    add('pigeonholes', 48, 26, 3, 1, { rise: 18 });
    add('receiver', 46, 26, 2, 1, { rise: 16 });
    add('sortingtable', 43, 29, 4, 2, { rise: 4 });
    add('mailboxes', 40, 33, 4, 1, { rise: 18 });
    add('laposte', 47, 33, 1, 1, { rise: 14 });
    add('parcels', 49, 35, 2, 2, { rise: 8 });
    add('plant', 39, 37, 1, 1, { rise: 12 });
    // Web lab
    add('holotable', 56, 30, 2, 1, { rise: 14 });
    add('webdesk', 53, 34, 2, 1, { rise: 13 });
    base('chair', 53, 35, 1, 1, { dir: 'up', tint: '#24434E' });
    add('webdesk', 56, 34, 2, 1, { rise: 13, variant: 1 });
    base('chair', 56, 35, 1, 1, { dir: 'up', tint: '#24434E' });
    add('dish', 60, 34, 2, 2, { rise: 18 });
    add('router', 62, 29, 1, 1, { rise: 16 });
    add('plant', 52, 37, 1, 1, { rise: 12, v: 2 });
    add('plant', 62, 37, 1, 1, { rise: 12 });
    return F;
  }

  /** Wall-mounted decorations: x, y = face tile (the wall tile whose bottom touches the floor), w in tiles. */
  const WALL_DECOR = [
    // Open space (top outer wall)
    { kind: 'poster', x: 17, y: 1, w: 1, art: 'shipit' },
    { kind: 'window', x: 19, y: 1, w: 2 },
    { kind: 'clock', x: 22, y: 1, w: 1 },
    { kind: 'kanban', x: 23, y: 1, w: 3 },
    { kind: 'window', x: 27, y: 1, w: 2 },
    { kind: 'poster', x: 30, y: 1, w: 1, art: 'clawd' },
    { kind: 'window', x: 32, y: 1, w: 2 },
    { kind: 'poster', x: 35, y: 1, w: 1, art: 'cat' },
    // Meeting room
    { kind: 'whiteboard', x: 4, y: 13, w: 5 },
    { kind: 'projscreen', x: 10, y: 13, w: 4 },
    // Cafeteria
    { kind: 'menu', x: 1, y: 25, w: 1 },
    { kind: 'neon', x: 11, y: 25, w: 1 },
    // Lobby
    { kind: 'logo', x: 20, y: 23, w: 4 },
    { kind: 'elevator', x: 26, y: 23, w: 2 },
    { kind: 'agents', x: 29, y: 23, w: 7 },
    // Server room
    { kind: 'vent', x: 42, y: 12, w: 1 }, { kind: 'vent', x: 44, y: 12, w: 1 }, { kind: 'warning', x: 46, y: 12, w: 1 }, { kind: 'vent', x: 47, y: 12, w: 1 },
    { kind: 'breaker', x: 39, y: 12, w: 1 },
    // Test lab
    { kind: 'testboard', x: 53, y: 12, w: 7 },
    { kind: 'poster', x: 61, y: 12, w: 1, art: 'bug' },
    // Git post office
    { kind: 'tube', x: 39, y: 25, w: 9 },
    // Web lab
    { kind: 'worldmap', x: 55, y: 25, w: 6 },
    // Side windows in the outer walls (left and right)
    { kind: 'sidewin', x: 0, y: 4, h: 2, side: 'left' }, { kind: 'sidewin', x: 0, y: 8, h: 2, side: 'left' },
    { kind: 'sidewin', x: 0, y: 16, h: 2, side: 'left' }, { kind: 'sidewin', x: 0, y: 20, h: 2, side: 'left' },
    { kind: 'sidewin', x: 0, y: 28, h: 2, side: 'left' }, { kind: 'sidewin', x: 0, y: 33, h: 2, side: 'left' },
    { kind: 'sidewin', x: 63, y: 15, h: 2, side: 'right' }, { kind: 'sidewin', x: 63, y: 20, h: 2, side: 'right' },
    { kind: 'sidewin', x: 63, y: 29, h: 2, side: 'right' }, { kind: 'sidewin', x: 63, y: 33, h: 2, side: 'right' }
  ];

  // ------------------------------------------------------------------ the Office (map + logic)
  function key(x, y) { return x + ',' + y; }

  function Office() {
    const N = COLS * ROWS;
    this.cols = COLS; this.rows = ROWS; this.tile = T; this.width = WIDTH; this.height = HEIGHT;
    this.tiles = new Uint8Array(N);      // WALL, FLOOR or SKY
    this.blocked = new Uint8Array(N);    // furniture footprint
    this.cost = new Float32Array(N);     // extra traversal cost (couches, benches…)
    this.door = new Uint8Array(N);       // 1 = doorway between rooms, 2 = in front of the elevator
    this.floorKind = new Array(N).fill(null);
    this.roomOf = new Array(N).fill(null);
    this.rooms = {};
    this.roomList = [];
    this.furniture = furnitureList();
    this.decor = WALL_DECOR;
    this.desks = [];
    this.spotTiles = new Set();
    this.spawnTiles = ELEVATOR.map((p) => ({ x: p[0], y: p[1] }));
    this.exitTiles = this.spawnTiles;
    this.doorOpen = 0;
    this._resTile = new Map();   // "x,y" -> owner id (spots, floor tiles, desk seats)
    this._resOwner = new Map();  // owner id -> spot (desk seats excluded)
    this._deskOwner = new Map(); // owner id -> desk index
    this.built = false;
    this.base = null;
    this.items = [];
    this.lights = [];            // static light sources for lighting.js: { x, y, r, color, power, kind }
    this.emissive = [];          // screens / LEDs / neon kept bright at night: { x, y, w, h, color }
    this.lightVersion = 1;       // bumped whenever the light layer must be re-rendered
    this.libRepos = [];
    this.libMore = 0;
    this.reduced = false;
    this._t = 0;                 // last world time seen by drawBase (used by ping)
    this._todAge = 0;
    this.amb = {
      elevator: { open: 0, until: -10, ding: -10 },
      tests: { results: [], flashAt: -10, flashOk: true },
      tube: { caps: [], n: 0, arriveAt: -10, arriveX: 0 },
      coffee: { busy: false, boost: -10 },
      arcade: { busy: false },
      meeting: { occ: 0, prog: 0, hold: 0, seed: 1, drawn: 0, canvas: null, strokes: null, boost: -10 },
      web: { burst: -10 },
      servers: { burst: -10 },
      board: { entries: [], n: 0, more: 0, sig: '', timer: 0, canvas: null, dirty: true }
    };
    this._glowPool = [];
    this._glowCount = 0;
    this._layout();
    this._buildLights();
    this.todBucket = -1;
    this.setTimeOfDay(localHours(), true);
  }

  Office.prototype._layout = function () {
    const self = this;
    function carve(x, y, kind, room) {
      const i = y * COLS + x;
      self.tiles[i] = FLOOR;
      self.floorKind[i] = kind;
      self.roomOf[i] = room;
    }
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (isSkyTile(x, y)) this.tiles[y * COLS + x] = SKY;
    for (const def of ROOM_DEFS) {
      const room = {
        id: def.id, label: def.label, name: def.label, sign: def.sign, short: def.short, blurb: def.blurb,
        x: def.x, y: def.y, w: def.w, h: def.h, accent: def.accent, floor: def.floor, wall: def.wall,
        signAt: def.signAt, gather: def.gather, outdoor: !!def.outdoor,
        rect: { x: def.x, y: def.y, w: def.w, h: def.h }, spots: []
      };
      for (let y = def.y; y < def.y + def.h; y++) for (let x = def.x; x < def.x + def.w; x++) carve(x, y, def.floor, def.id);
      (SPOT_DEFS[def.id] || []).forEach((s, n) => {
        const spot = { id: def.id + '-' + n, room: def.id, x: s.x, y: s.y, facing: s.facing, pose: s.pose, index: n };
        if (s.item) spot.item = s.item;
        if (s.oy) spot.oy = s.oy;
        room.spots.push(spot);
        self.spotTiles.add(key(s.x, s.y));
      });
      this.rooms[def.id] = room;
      this.roomList.push(room);
    }
    // Legacy alias (older code called the hall "entrance"); not enumerable so room lists stay clean.
    Object.defineProperty(this.rooms, 'entrance', { value: this.rooms.lobby, enumerable: false });
    for (const d of DOORWAYS) { carve(d[0], d[1], 'door', null); this.door[d[1] * COLS + d[0]] = 1; }
    for (const e of ELEVATOR) this.door[e[1] * COLS + e[0]] = 2;

    for (const f of this.furniture) {
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) {
          const i = y * COLS + x;
          if (f.block) this.blocked[i] = 1;
          if (f.cost) this.cost[i] = Math.max(this.cost[i], f.cost);
        }
      }
    }
    DESK_ROWS.forEach((dy, r) => DESK_COLS.forEach((dx, c) => {
      const index = r * DESK_COLS.length + c;
      this.desks[index] = {
        index, id: 'desk-' + index, room: 'open', x: dx, y: dy + 1, ox: 0, oy: -5, deskX: dx, deskY: dy, facing: 'up', pose: 'type',
        owner: null, mode: 'off', modeAt: -1e9, color: null, name: null, papers: 0, plate: null, plateKey: ''
      };
      this.spotTiles.add(key(dx, dy + 1));
    }));
  };

  /** Static light sources (tile coords → px) used by lighting.js. */
  Office.prototype._buildLights = function () {
    const L = [];
    const add = (tx, ty, r, color, power, kind) => L.push({ x: Math.round(tx * T), y: Math.round(ty * T), r, color, power, kind });
    // Open space: ceiling pools over the desk rows + the lounge.
    add(20.5, 6.6, 64, '#FFE6BC', 0.85, 'ceil'); add(31, 6.6, 64, '#FFE6BC', 0.85, 'ceil');
    add(20.5, 14.6, 64, '#FFE6BC', 0.85, 'ceil'); add(31, 14.6, 64, '#FFE6BC', 0.85, 'ceil');
    add(27, 20, 56, '#FFD08A', 0.9, 'lamp');
    // Library: floor lamp, banker lamp, statue spotlight.
    add(12.5, 9, 50, '#FFC56A', 1.1, 'lamp'); add(7, 6.8, 46, '#FFD98A', 1, 'lamp'); add(7.5, 3.4, 34, '#FFE2A0', 0.8, 'lamp');
    add(3.5, 4.5, 44, '#FFD9A0', 0.55, 'ceil'); add(11, 4.5, 44, '#FFD9A0', 0.55, 'ceil');
    // Meeting room
    add(7.5, 18.8, 72, '#FFE6C4', 0.9, 'ceil');
    // Cafeteria
    add(6, 28, 48, '#FFC98A', 1, 'lamp'); add(7.5, 31, 54, '#FFD9A0', 0.75, 'ceil'); add(3.8, 35.2, 46, '#FFB870', 0.95, 'lamp');
    add(10.5, 34.2, 46, '#FFD9A0', 0.7, 'ceil');
    // Lobby
    add(21, 28.5, 58, '#FFE0A8', 0.85, 'ceil'); add(27, 25, 42, '#FFE6B0', 0.9, 'lamp'); add(33, 30, 62, '#FFE0A8', 0.8, 'ceil');
    add(27, 33.5, 62, '#FFE0A8', 0.8, 'ceil'); add(19.5, 35, 50, '#FFE0A8', 0.6, 'ceil');
    // Server room (cold light)
    add(45, 17.4, 60, '#9CC8FF', 0.65, 'ceil'); add(45, 21.4, 56, '#9CC8FF', 0.6, 'ceil');
    // Test lab
    add(57, 15.4, 58, '#E8F4FF', 0.8, 'ceil'); add(57, 20.6, 56, '#E8F4FF', 0.7, 'ceil');
    // Post office
    add(44.5, 28.6, 58, '#FFD9A0', 0.8, 'ceil'); add(44.5, 34.4, 56, '#FFD9A0', 0.7, 'ceil');
    // Web lab
    add(57, 29.6, 56, '#9FF5EC', 0.7, 'ceil'); add(56, 35.2, 48, '#9FF5EC', 0.6, 'ceil');
    // Terrace: string lights along the railing + the parasol lantern.
    for (let x = 39.5; x <= 62.5; x += 2) add(x, 4.25, 20, '#FFC46A', 0.55, 'string');
    add(48.5, 7.4, 40, '#FFD08A', 0.75, 'lamp');
    this.lights = L;
    this.lightVersion++;
  };

  // ---- grid queries
  Office.prototype.inBounds = function (x, y) { return x >= 0 && y >= 0 && x < COLS && y < ROWS; };
  Office.prototype.isWalkable = function (x, y) {
    if (!(x >= 0 && y >= 0 && x < COLS && y < ROWS)) return false;
    const i = y * COLS + x;
    return this.tiles[i] === FLOOR && this.blocked[i] === 0;
  };
  /** True for walls, sky and anything outside the map (i.e. not floor). */
  Office.prototype.isWall = function (x, y) { return !this.inBounds(x, y) || this.tiles[y * COLS + x] !== FLOOR; };
  Office.prototype.roomAt = function (x, y) { return this.inBounds(x, y) ? this.roomOf[y * COLS + x] : null; };
  Office.prototype.isDoorway = function (x, y) { return this.inBounds(x, y) && this.door[y * COLS + x] !== 0; };
  /** Feet position (world px) for a tile. */
  Office.prototype.tileCenter = function (x, y) { return { x: x * T + 8, y: y * T + 13 }; };
  Office.prototype.worldToTile = function (wx, wy) {
    return { x: Math.max(0, Math.min(COLS - 1, Math.floor(wx / T))), y: Math.max(0, Math.min(ROWS - 1, Math.floor(wy / T))) };
  };

  /** Room object by id (null when unknown). */
  Office.prototype.roomInfo = function (id) {
    if (typeof id !== 'string') return null;
    return Object.prototype.hasOwnProperty.call(this.rooms, id) || id === 'entrance' ? this.rooms[id] || null : null;
  };

  /** Room id under a world point (walls / signs above a room count for that room), or null. */
  Office.prototype.roomAtWorld = function (wx, wy) {
    if (typeof wx !== 'number' || typeof wy !== 'number' || !isFinite(wx) || !isFinite(wy)) return null;
    const tx = Math.floor(wx / T), ty = Math.floor(wy / T);
    if (!this.inBounds(tx, ty)) return null;
    const i = ty * COLS + tx;
    if (this.roomOf[i]) return this.roomOf[i];
    if (this.tiles[i] === SKY) return 'terrace';
    if (this.tiles[i] === WALL) {
      for (let k = 1; k <= 2 && ty + k < ROWS; k++) {
        const j = (ty + k) * COLS + tx;
        if (this.tiles[j] === FLOOR) return this.roomOf[j] || null;
      }
      return null;
    }
    // Doorway: the room on either side.
    const around = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const d of around) {
      const r = this.roomAt(tx + d[0], ty + d[1]);
      if (r) return r;
    }
    return null;
  };

  /** Nearest walkable tile to (x, y) (ring search), optionally filtered. */
  Office.prototype.nearestWalkable = function (x, y, filter) {
    x = Math.max(0, Math.min(COLS - 1, Math.round(x)));
    y = Math.max(0, Math.min(ROWS - 1, Math.round(y)));
    const maxR = Math.max(COLS, ROWS);
    for (let r = 0; r <= maxR; r++) {
      let best = null, bd = Infinity;
      const test = (xx, yy) => {
        if (!this.isWalkable(xx, yy) || (filter && !filter(xx, yy))) return;
        const d = (xx - x) * (xx - x) + (yy - y) * (yy - y);
        if (d < bd) { bd = d; best = { x: xx, y: yy }; }
      };
      if (r === 0) test(x, y);
      else {
        for (let xx = x - r; xx <= x + r; xx++) { test(xx, y - r); test(xx, y + r); }
        for (let yy = y - r + 1; yy <= y + r - 1; yy++) { test(x - r, yy); test(x + r, yy); }
      }
      if (best) return best;
    }
    return null;
  };

  // ---- A* (8 directions, no corner cutting), reusable typed arrays, binary heap
  const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

  Office.prototype._ensureSearch = function () {
    if (this._g) return;
    const N = COLS * ROWS;
    this._g = new Float64Array(N);
    this._seen = new Int32Array(N);
    this._done = new Int32Array(N);
    this._came = new Int32Array(N);
    this._genId = 0;
    this._hi = new Int32Array(N * 9);
    this._hf = new Float64Array(N * 9);
  };

  /** Returns an array of tiles [{x,y}, …] from start to goal (inclusive), or null when unreachable. */
  Office.prototype.findPath = function (sx, sy, tx, ty) {
    sx = Math.round(sx); sy = Math.round(sy); tx = Math.round(tx); ty = Math.round(ty);
    if (!this.isWalkable(tx, ty)) return null;
    if (!this.isWalkable(sx, sy)) {
      const n = this.nearestWalkable(sx, sy);
      if (!n) return null;
      sx = n.x; sy = n.y;
    }
    if (sx === tx && sy === ty) return [{ x: sx, y: sy }];
    this._ensureSearch();
    const gen = ++this._genId;
    const g = this._g, seen = this._seen, done = this._done, came = this._came, hi = this._hi, hf = this._hf;
    let size = 0;
    const push = (i, f) => {
      let n = size++;
      while (n > 0) {
        const p = (n - 1) >> 1;
        if (hf[p] <= f) break;
        hi[n] = hi[p]; hf[n] = hf[p]; n = p;
      }
      hi[n] = i; hf[n] = f;
    };
    const pop = () => {
      const top = hi[0];
      const li = hi[--size], lf = hf[size];
      let n = 0;
      for (;;) {
        let c = 2 * n + 1;
        if (c >= size) break;
        if (c + 1 < size && hf[c + 1] < hf[c]) c++;
        if (hf[c] >= lf) break;
        hi[n] = hi[c]; hf[n] = hf[c]; n = c;
      }
      hi[n] = li; hf[n] = lf;
      return top;
    };
    const heur = (x, y) => {
      const dx = Math.abs(x - tx), dy = Math.abs(y - ty);
      return (dx + dy + (SQRT2 - 2) * Math.min(dx, dy)) * 1.001;
    };
    const start = sy * COLS + sx, goal = ty * COLS + tx;
    seen[start] = gen; g[start] = 0; came[start] = -1;
    push(start, heur(sx, sy));
    let found = false;
    while (size > 0) {
      const i = pop();
      if (done[i] === gen) continue;
      done[i] = gen;
      if (i === goal) { found = true; break; }
      const x = i % COLS, y = (i / COLS) | 0;
      for (let d = 0; d < 8; d++) {
        const dx = DIRS8[d][0], dy = DIRS8[d][1];
        const nx = x + dx, ny = y + dy;
        if (!this.isWalkable(nx, ny)) continue;
        const diag = dx !== 0 && dy !== 0;
        if (diag && (!this.isWalkable(x + dx, y) || !this.isWalkable(x, y + dy))) continue;
        const ni = ny * COLS + nx;
        if (done[ni] === gen) continue;
        const ng = g[i] + (diag ? SQRT2 : 1) * (1 + this.cost[ni]);
        if (seen[ni] !== gen || ng < g[ni]) {
          seen[ni] = gen; g[ni] = ng; came[ni] = i;
          push(ni, ng + heur(nx, ny));
        }
      }
    }
    if (!found) return null;
    const out = [];
    for (let i = goal; i !== -1; i = came[i]) out.push({ x: i % COLS, y: (i / COLS) | 0 });
    out.reverse();
    return out;
  };

  // ---- reservations, spots and desks
  Office.prototype.isReservedByOther = function (x, y, owner) {
    const o = this._resTile.get(key(x, y));
    return o !== undefined && o !== owner;
  };
  Office.prototype._claim = function (owner, spot) {
    this._resTile.set(key(spot.x, spot.y), owner);
    this._resOwner.set(owner, spot);
  };
  /** Releases the room spot / floor tile held by owner (never the home desk). */
  Office.prototype.releaseSpot = function (owner) {
    const s = this._resOwner.get(owner);
    if (!s) return;
    const k = key(s.x, s.y);
    if (this._resTile.get(k) === owner) this._resTile.delete(k);
    this._resOwner.delete(owner);
  };
  Office.prototype.spotOf = function (owner) { return this._resOwner.get(owner) || null; };

  /**
   * Reserves the free spot of a room closest to `near` (tile). Falls back to the nearest free floor tile
   * of the room, then anywhere. Returns a spot { id, room, x, y, facing, pose, item?, oy?, floor? } or null.
   */
  Office.prototype.reserveSpot = function (roomId, owner, near) {
    this.releaseSpot(owner);
    const room = roomId === 'entrance' ? this.rooms.lobby : this.rooms[roomId];
    if (!room) return this.findFreeTile(null, near, owner);
    let best = null, bd = Infinity;
    for (const s of room.spots) {
      if (this.isReservedByOther(s.x, s.y, owner)) continue;
      const d = near ? (s.x - near.x) * (s.x - near.x) + (s.y - near.y) * (s.y - near.y) + s.index * 0.01 : s.index;
      if (d < bd) { bd = d; best = s; }
    }
    if (best) { this._claim(owner, best); return best; }
    return this.findFreeTile(room.id, null, owner);
  };

  /**
   * Reserves the nearest free plain floor tile (not a doorway, spot, seat or couch) in a room, else anywhere.
   * Unless `tight`, tiles on a 2-tile lattice are preferred so overflow characters spread out instead of piling up.
   */
  Office.prototype.findFreeTile = function (roomId, near, owner, tight) {
    this.releaseSpot(owner);
    if (roomId === 'entrance') roomId = 'lobby';
    const room = roomId ? this.rooms[roomId] : null;
    const origin = near || (room ? room.gather : this.rooms.open.gather);
    const ok = (x, y, strict) => {
      const i = y * COLS + x;
      if (this.door[i] || this.cost[i] > 0) return false;
      if (this.spotTiles.has(key(x, y))) return false;
      if (this.isReservedByOther(x, y, owner)) return false;
      if (strict && this.roomOf[i] !== roomId) return false;
      return true;
    };
    const lattice = (x, y) => (x & 1) === 0 && (y & 1) === 0;
    let t = null;
    if (room && !tight) t = this.nearestWalkable(origin.x, origin.y, (x, y) => lattice(x, y) && ok(x, y, true));
    if (!t && room) t = this.nearestWalkable(origin.x, origin.y, (x, y) => ok(x, y, true));
    if (!t) t = this.nearestWalkable(origin.x, origin.y, (x, y) => ok(x, y, false));
    if (!t) return null;
    const spot = { id: 'sol:' + key(t.x, t.y), room: this.roomAt(t.x, t.y) || roomId, x: t.x, y: t.y, facing: 'down', pose: 'stand', floor: true, index: -1 };
    this._claim(owner, spot);
    return spot;
  };

  /** Reserves one specific tile if it is walkable and free (used to "stay put"). */
  Office.prototype.reserveTile = function (x, y, owner) {
    if (!this.isWalkable(x, y) || this.isReservedByOther(x, y, owner)) return null;
    this.releaseSpot(owner);
    const spot = { id: 'sol:' + key(x, y), room: this.roomAt(x, y), x, y, facing: 'down', pose: 'stand', floor: true, index: -1 };
    this._claim(owner, spot);
    return spot;
  };

  /** Home desk: assigned once per agent (centre desks first); null when all 16 are taken. */
  Office.prototype.assignDesk = function (owner) {
    const cur = this._deskOwner.get(owner);
    if (cur !== undefined) return this.desks[cur];
    for (const i of DESK_ORDER) {
      const d = this.desks[i];
      if (d.owner === null && !this.isReservedByOther(d.x, d.y, owner)) {
        d.owner = owner;
        d.name = null; d.papers = 0; d.color = null; d.plate = null; d.plateKey = '';
        this._deskOwner.set(owner, i);
        this._resTile.set(key(d.x, d.y), owner);
        return d;
      }
    }
    return null;
  };
  Office.prototype.freeDesk = function (owner) {
    const i = this._deskOwner.get(owner);
    if (i === undefined) return;
    const d = this.desks[i];
    d.owner = null; d.mode = 'off'; d.name = null; d.papers = 0; d.color = null; d.plate = null; d.plateKey = '';
    if (this._resTile.get(key(d.x, d.y)) === owner) this._resTile.delete(key(d.x, d.y));
    this._deskOwner.delete(owner);
  };
  Office.prototype.deskOf = function (owner) {
    const i = this._deskOwner.get(owner);
    return i === undefined ? null : this.desks[i];
  };
  /**
   * Called every frame by a character sitting at its desk: mode "type" | "think" (anything else = idle screen).
   * extras (optional) = { name, papers }: the desk keeps a nameplate in the owner's colour and a paper stack
   * (0–6 sheets) even while its owner is away.
   */
  Office.prototype.markDesk = function (index, mode, color, time, extras) {
    const d = this.desks[index];
    if (!d) return;
    d.mode = mode; d.modeAt = time;
    if (color) d.color = normColor(color, d.color || '#9BE3C8');
    if (extras && typeof extras === 'object') {
      if (typeof extras.name === 'string' && extras.name) d.name = extras.name;
      if (extras.papers !== undefined) d.papers = clamp(Math.floor(Number(extras.papers) || 0), 0, 6);
    }
  };

  // ---- ambient life
  /**
   * Per-frame ambient update. points: iterable of characters ({x, y} world px; name / color / agent used by the
   * hall's agents board when present). Opens the elevator for anyone near it, tracks who sits in the meeting
   * room (whiteboard scribbles), at the coffee machine (steam) and at the arcade.
   */
  Office.prototype.updateAmbient = function (dt, points) {
    dt = Math.min(0.25, Math.max(0, Number(dt) || 0));
    const A = this.amb;
    this._todAge += dt;
    if (this._todAge > 60) this.setTimeOfDay(localHours(), true);
    let nearElev = false, meetOcc = 0, coffeeOcc = false, arcadeOcc = false;
    const board = A.board;
    board.timer -= dt;
    const gather = board.timer <= 0;
    let n = 0;
    if (gather) board.timer = 0.5;
    if (points) {
      for (const p of points) {
        if (!p || typeof p.x !== 'number' || typeof p.y !== 'number' || p.state === 'gone') continue;
        const x = p.x, y = p.y;
        if (x >= 24.5 * T && x <= 29.5 * T && y >= 23.6 * T && y <= 26.6 * T) nearElev = true;
        const tx = (x / T) | 0, ty = (y / T) | 0;
        if (tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS) {
          const r = this.roomOf[ty * COLS + tx];
          if (r === 'meeting') meetOcc++;
          else if (r === 'cafe' && ty === 27) {
            if (tx === 5 || tx === 7) coffeeOcc = true;
            else if (tx === 12 || tx === 13) arcadeOcc = true;
          }
        }
        if (gather && !p.leaving && n < 64) {
          let e = board.entries[n];
          if (!e) { e = { name: '', color: '', status: '' }; board.entries[n] = e; }
          const ag = p.agent && typeof p.agent === 'object' ? p.agent : null;
          e.name = String(p.name || (ag && ag.name) || p.id || '?');
          e.color = normColor(p.color || (ag && ag.color), '#ECE8F4');
          e.status = String((ag && ag.status) || p.status || 'working');
          n++;
        }
      }
    }
    if (gather) {
      let sig = '';
      for (let i = 0; i < n; i++) { const e = board.entries[i]; sig += e.name + e.color + e.status + '|'; }
      board.n = n;
      if (sig !== board.sig) { board.sig = sig; board.dirty = true; }
    }
    // Elevator doors: open for anyone close by and for a moment after a ping.
    const E = A.elevator;
    const target = nearElev || this._t < E.until ? 1 : 0;
    const step = dt * 3;
    E.open = E.open < target ? Math.min(target, E.open + step) : Math.max(target, E.open - step);
    this.doorOpen = E.open;
    // Meeting room whiteboard: scribbles appear while someone is in the room, then the board is wiped.
    const M = A.meeting;
    M.occ = meetOcc;
    if (meetOcc > 0 || this._t - M.boost < 6) {
      if (M.prog < 1) M.prog = Math.min(1, M.prog + dt * (0.05 + 0.015 * Math.min(4, meetOcc)));
      else { M.hold += dt; if (M.hold > 6) { M.prog = 0; M.hold = 0; M.seed++; M.strokes = null; M.drawn = 0; } }
    }
    A.coffee.busy = coffeeOcc;
    A.arcade.busy = arcadeOcc;
  };

  /**
   * Ambient reactions: "elevator" (doors open + ding), "tests" with ok true/false (the wall board records the
   * result and flashes green/red), "post" ("in"/"out" optional: a capsule whooshes through the pneumatic tube),
   * "coffee" (steam burst), "web" (packet burst on the world map), "servers" (LED storm), "meeting" (scribbles).
   */
  Office.prototype.ping = function (kind, arg) {
    const A = this.amb, now = this._t;
    switch (String(kind || '')) {
      case 'elevator': case 'spawn': case 'exit':
        A.elevator.until = now + 2.4; A.elevator.ding = now; break;
      case 'tests': case 'test': {
        const ok = !(arg === false || arg === 0 || arg === 'fail' || arg === 'ko' || arg === 'error');
        const res = A.tests.results;
        res.push(ok);
        if (res.length > 24) res.shift();
        A.tests.flashAt = now; A.tests.flashOk = ok;
        break;
      }
      case 'post': case 'git': {
        const T0 = A.tube;
        if (T0.caps.length >= 4) break;
        const dir = arg === 'in' || arg === 'pull' ? -1 : arg === 'out' || arg === 'push' ? 1 : (T0.n++ % 2 ? -1 : 1);
        T0.caps.push({ t0: now, dir });
        break;
      }
      case 'coffee': A.coffee.boost = now; break;
      case 'web': A.web.burst = now; break;
      case 'servers': case 'bash': A.servers.burst = now; break;
      case 'meeting': A.meeting.boost = now; break;
      default: break;
    }
  };

  /** Time of day (float hours, 0–24): sky, windows, terrace and the light layer follow it. */
  Office.prototype.setTimeOfDay = function (hours, auto) {
    const h = Number(hours);
    if (!isFinite(h)) return;
    this._todAge = auto ? 0 : -1e9;   // once the engine drives the clock, never fall back to the local time
    this.tod = computeTod(h);
    const bucket = Math.floor(this.tod.hours * 4);   // quarter-hour buckets for the pre-rendered light layer
    if (bucket !== this.todBucket) { this.todBucket = bucket; this.lightVersion++; }
  };

  /**
   * Dynamic glow sources for this frame (lighting.js): monitors of occupied desks, the open elevator, the test
   * board flash, the arcade. Fills a reused pool and returns how many entries are valid.
   */
  Office.prototype.dynamicGlows = function (t) {
    let n = 0;
    const pool = this._glowPool;
    const put = (x, y, r, color, a) => {
      let g = pool[n];
      if (!g) { g = { x: 0, y: 0, r: 0, color: '', a: 0 }; pool[n] = g; }
      g.x = x; g.y = y; g.r = r; g.color = color; g.a = a;
      n++;
    };
    for (let i = 0; i < this.desks.length; i++) {
      const d = this.desks[i];
      if (t - d.modeAt > 0.35) continue;
      const x = d.deskX * T + 10, y = d.deskY * T - 6;
      if (d.mode === 'type') put(x, y + 6, 22, d.color || '#9BE3C8', 0.55 + 0.08 * Math.sin(t * 9 + i));
      else put(x, y + 6, 18, '#8FA8FF', 0.35);
    }
    const E = this.amb.elevator;
    if (E.open > 0.02) put(27 * T, 24 * T - 2, 30, '#FFE2A8', 0.7 * E.open);
    const ts = this.amb.tests;
    const ft = t - ts.flashAt;
    if (ft >= 0 && ft < 1.4) put(56.5 * T, 12.6 * T, 52, ts.flashOk ? '#6CF09A' : '#FF5A4E', (1 - ft / 1.4) * 0.8);
    if (this.amb.arcade.busy) put(12.9 * T, 26 * T - 8, 22, Math.floor(t * 6) % 2 ? '#B07CFF' : '#5BE0FF', 0.5);
    if (this.amb.meeting.occ > 0) put(11.9 * T, 12.7 * T, 34, '#CFE0FF', 0.35);
    this._glowCount = n;
    return n;
  };

  // ------------------------------------------------------------------ static rendering: floors
  const FLOOR_PAINT = {
    wood(c, x, y, X, Y) {
      const tones = ['#7E5536', '#86593A', '#79502F', '#8A5E3D'];
      for (let r = 0; r < 4; r++) {
        const row = Y * 4 + r;
        px(c, x, y + r * 4, 16, 4, tones[(hash(X, row, 11) * 4) | 0]);
        px(c, x, y + r * 4 + 3, 16, 1, '#5E3D25');
        if (hash(X, row, 13) < 0.45) px(c, x + ((hash(X, row, 12) * 16) | 0), y + r * 4, 1, 3, '#5E3D25');
        px(c, x + ((hash(X, row, 14) * 13) | 0), y + r * 4 + 1, 3, 1, '#946742');
      }
    },
    carpet(c, x, y, X, Y) {
      px(c, x, y, 16, 16, '#2E5546');
      for (let j = 0; j < 16; j += 4) for (let i = ((j >> 2) & 1) * 2; i < 16; i += 4) px(c, x + i, y + j, 1, 1, '#386654');
      if (hash(X, Y, 21) < 0.3) px(c, x + ((hash(X, Y, 22) * 13) | 0), y + ((hash(X, Y, 23) * 14) | 0), 3, 1, '#294C3F');
    },
    metal(c, x, y, X, Y) {
      px(c, x, y, 16, 16, '#3A4252');
      px(c, x, y, 16, 1, '#465066'); px(c, x, y, 1, 16, '#465066');
      px(c, x, y + 15, 16, 1, '#2A303D'); px(c, x + 15, y, 1, 16, '#2A303D');
      px(c, x + 2, y + 2, 1, 1, '#5C677F'); px(c, x + 13, y + 2, 1, 1, '#5C677F');
      px(c, x + 2, y + 13, 1, 1, '#5C677F'); px(c, x + 13, y + 13, 1, 1, '#5C677F');
      const v = hash(X, Y, 31);
      if (v < 0.22) for (let k = 0; k < 4; k++) px(c, x + 4, y + 4 + k * 2, 8, 1, '#262B36');
      else if (v < 0.4) for (let j = 4; j < 12; j += 2) for (let i = 4; i < 12; i += 2) px(c, x + i, y + j, 1, 1, '#2B3140');
    },
    tech(c, x, y, X, Y) {
      px(c, x, y, 16, 16, '#1E2943');
      px(c, x, y, 16, 1, '#27365A'); px(c, x, y, 1, 16, '#27365A');
      px(c, x + 7, y + 7, 2, 2, '#243256');
      if (hash(X, Y, 41) < 0.25) px(c, x + 3 + ((hash(X, Y, 42) * 9) | 0), y + 3 + ((hash(X, Y, 43) * 9) | 0), 1, 1, '#2E8C8A');
      if (hash(X, Y, 44) < 0.18) { px(c, x + 2, y + 8, 6, 1, '#22406A'); px(c, x + 8, y + 8, 1, 5, '#22406A'); }
    },
    meeting(c, x, y) {
      px(c, x, y, 16, 16, '#464A6A');
      for (let j = 0; j < 16; j++) for (let i = 0; i < 16; i++) if ((i + j) % 6 === 0 && (i - j + 16) % 12 === 0) px(c, x + i, y + j, 1, 1, '#50557A');
      px(c, x + 3, y + 11, 1, 1, '#3E4260'); px(c, x + 12, y + 4, 1, 1, '#3E4260');
    },
    cafe(c, x, y) {
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) px(c, x + i * 8, y + j * 8, 8, 8, (i + j) % 2 ? '#A88A62' : '#CDB892');
      px(c, x, y, 16, 1, '#BBA57E'); px(c, x, y, 1, 16, '#BBA57E');
    },
    marble(c, x, y, X, Y) {
      const slab = ((X >> 1) + (Y >> 1)) & 1;
      px(c, x, y, 16, 16, slab ? '#B5AFC6' : '#C3BED3');
      if ((X & 1) === 0) px(c, x, y, 1, 16, '#A39DB6');
      if ((Y & 1) === 0) px(c, x, y, 16, 1, '#A39DB6');
      if ((X & 1) === 1) px(c, x + 15, y, 1, 16, '#CFCADC');
      let vx = (hash(X, Y, 51) * 12) | 0, vy = 1;
      for (let k = 0; k < 7; k++) {
        px(c, x + vx, y + vy, 1, 1, slab ? '#A29BB6' : '#ADA7C0');
        vx += hash(X + k, Y, 52) < 0.5 ? 1 : 2; vy += 2;
        if (vx > 14 || vy > 15) break;
      }
      if (hash(X, Y, 53) < 0.25) px(c, x + 3 + ((hash(X, Y, 54) * 9) | 0), y + 4 + ((hash(X, Y, 55) * 8) | 0), 2, 1, '#D6D2E2');
    },
    lab(c, x, y, X, Y) {
      px(c, x, y, 16, 16, '#6B7484');
      px(c, x, y, 16, 1, '#79828F'); px(c, x, y, 1, 16, '#79828F');
      px(c, x, y + 15, 16, 1, '#5B6372'); px(c, x + 15, y, 1, 16, '#5B6372');
      for (let k = 0; k < 4; k++) px(c, x + 1 + ((hash(X, Y * 7 + k, 61) * 14) | 0), y + 1 + ((hash(X * 3 + k, Y, 62) * 14) | 0), 1, 1, k % 2 ? '#828B98' : '#5F6878');
    },
    terracotta(c, x, y, X, Y) {
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const v = hash(X * 2 + i, Y * 2 + j, 63);
        px(c, x + i * 8, y + j * 8, 8, 8, v < 0.33 ? '#A35E40' : v < 0.66 ? '#AE6646' : '#98563A');
        px(c, x + i * 8, y + j * 8, 8, 1, '#7A4430'); px(c, x + i * 8, y + j * 8, 1, 8, '#7A4430');
        px(c, x + i * 8 + 1, y + j * 8 + 1, 3, 1, '#BC7452');
      }
    },
    deck(c, x, y, X, Y) {
      const tones = ['#9C6B45', '#A87650', '#93633F', '#A2704A'];
      for (let r = 0; r < 4; r++) {
        const row = Y * 4 + r;
        const off = ((hash(0, row, 64) * 16) | 0);
        px(c, x, y + r * 4, 16, 3, tones[(hash(X, row, 65) * 4) | 0]);
        px(c, x, y + r * 4 + 3, 16, 1, '#4E321E');
        if (((X * 16 + off) % 48) < 16) px(c, x + ((off + X * 5) % 16), y + r * 4, 1, 3, '#5E3D25');
        px(c, x + ((hash(X, row, 66) * 13) | 0), y + r * 4 + 1, 2, 1, '#B5835A');
      }
    },
    door(c, x, y) {
      px(c, x, y, 16, 16, '#4E536E');
      for (let j = 1; j < 16; j += 3) px(c, x + 1, y + j, 14, 1, '#5A6080');
    }
  };

  // ------------------------------------------------------------------ static rendering: base layer
  Office.prototype._paintFloors = function (c) {
    for (let Y = 0; Y < ROWS; Y++) {
      for (let X = 0; X < COLS; X++) {
        const i = Y * COLS + X;
        if (this.tiles[i] !== FLOOR) continue;
        const paint = FLOOR_PAINT[this.floorKind[i]] || FLOOR_PAINT.wood;
        paint(c, X * T, Y * T, X, Y);
        if (this.door[i] === 1) {
          // Threshold: a metal strip across the passage, darker sides inside the wall thickness.
          const x = X * T, y = Y * T;
          const wl = this.isWall(X - 1, Y), wr = this.isWall(X + 1, Y);
          if (!wl && !wr) { px(c, x + 7, y, 2, 16, '#8A90A6'); px(c, x + 7, y, 1, 16, '#B5BACB'); }
          else {
            if (wl) px(c, x, y, 2, 16, 'rgba(8,8,18,0.35)');
            if (wr) px(c, x + 14, y, 2, 16, 'rgba(8,8,18,0.35)');
            if (!this.isDoorway(X, Y + 1)) { px(c, x, y + 14, 16, 2, '#8A90A6'); px(c, x, y + 14, 16, 1, '#B5BACB'); }
          }
        }
      }
    }
  };

  /** Soft contact shadows on the floor along walls (3/4 depth cue). */
  Office.prototype._paintFloorShadows = function (c) {
    for (let Y = 0; Y < ROWS; Y++) {
      for (let X = 0; X < COLS; X++) {
        if (this.tiles[Y * COLS + X] !== FLOOR) continue;
        if (this.tiles[Math.max(0, Y - 1) * COLS + X] === WALL && Y > 0) {
          c.fillStyle = 'rgba(6,6,16,0.32)'; c.fillRect(X * T, Y * T, 16, 2);
          c.fillStyle = 'rgba(6,6,16,0.16)'; c.fillRect(X * T, Y * T + 2, 16, 2);
        }
        if (X > 0 && this.tiles[Y * COLS + X - 1] === WALL) { c.fillStyle = 'rgba(6,6,16,0.26)'; c.fillRect(X * T, Y * T, 2, 16); }
        if (X < COLS - 1 && this.tiles[Y * COLS + X + 1] === WALL) { c.fillStyle = 'rgba(6,6,16,0.14)'; c.fillRect(X * T + 15, Y * T, 1, 16); }
      }
    }
  };

  /** Room whose palette a wall face uses: the floor just below (doorways borrow a neighbour). */
  Office.prototype._faceRoom = function (X, Y) {
    const below = Y + 1 < ROWS ? this.roomOf[(Y + 1) * COLS + X] : null;
    if (below) return this.rooms[below];
    const tries = [1, -1, 2, -2, 3, -3];
    for (const dx of tries) {
      const r = this.roomAt(X + dx, Y + 1);
      if (r) return this.rooms[r];
    }
    return this.rooms.open;
  };

  const FACE_PATTERN = {
    stripe(c, x, y, pal, X) {
      for (let i = (X & 1) * 2; i < 16; i += 4) px(c, x + i, y + 3, 1, 9, pal.lite);
    },
    wood(c, x, y, pal, X, Y) {
      for (let i = 0; i < 16; i += 5) px(c, x + ((i + X * 3) % 16), y + 3, 1, 9, pal.low);
      px(c, x, y + 7, 16, 1, pal.lite);
      if (hash(X, Y, 67) < 0.5) px(c, x + 3 + ((hash(X, Y, 68) * 9) | 0), y + 4, 1, 2, pal.low);
    },
    panel(c, x, y, pal) {
      px(c, x + 2, y + 4, 12, 7, pal.low); px(c, x + 3, y + 5, 10, 5, pal.face); px(c, x + 3, y + 5, 10, 1, pal.lite);
    },
    metal(c, x, y, pal) {
      for (let j = 4; j < 12; j += 3) px(c, x, y + j, 16, 1, pal.low);
      px(c, x + 1, y + 4, 1, 1, pal.lite); px(c, x + 14, y + 4, 1, 1, pal.lite); px(c, x + 1, y + 10, 1, 1, pal.lite); px(c, x + 14, y + 10, 1, 1, pal.lite);
    },
    brick(c, x, y, pal, X) {
      for (let r = 0; r < 3; r++) {
        const yy = y + 3 + r * 3;
        px(c, x, yy + 2, 16, 1, pal.low);
        const off = ((r + X) & 1) * 4;
        for (let i = off; i < 16; i += 8) px(c, x + i, yy, 1, 2, pal.low);
        px(c, x + ((off + 2) % 16), yy, 2, 1, pal.lite);
      }
    },
    tile(c, x, y, pal) {
      for (let r = 0; r < 3; r++) {
        const yy = y + 3 + r * 3;
        px(c, x, yy + 2, 16, 1, pal.low);
        for (let i = (r & 1) * 3; i < 16; i += 6) px(c, x + i, yy, 1, 2, pal.low);
      }
    },
    circuit(c, x, y, pal, X, Y) {
      const r = hash(X, Y, 69);
      px(c, x + 2, y + 5 + ((r * 4) | 0), 9, 1, pal.lite);
      px(c, x + 10, y + 5 + ((r * 4) | 0), 1, 4, pal.lite);
      px(c, x + 10, y + 9 + ((r * 4) | 0) - 1, 2, 2, '#4FC1B9');
      if (r < 0.5) px(c, x + 4, y + 4, 2, 2, '#2E7A75');
    }
  };

  function palOf(room) {
    if (!room._pal) {
      const w = room.wall;
      room._pal = { face: w.face, low: w.low, trim: w.trim, lite: shadeHex(w.face, 0.1), dark: shadeHex(w.face, -0.3), trimLite: shadeHex(w.trim, 0.25), pattern: w.pattern };
    }
    return room._pal;
  }

  Office.prototype._paintWalls = function (c) {
    for (let Y = 0; Y < ROWS; Y++) {
      for (let X = 0; X < COLS; X++) {
        const i = Y * COLS + X;
        if (this.tiles[i] === SKY) { px(c, X * T, Y * T, 16, 16, '#1B2652'); continue; }
        if (this.tiles[i] !== WALL) continue;
        const x = X * T, y = Y * T;
        const below = Y + 1 < ROWS ? this.tiles[(Y + 1) * COLS + X] : -1;
        if (below === FLOOR) {
          const pal = palOf(this._faceRoom(X, Y));
          px(c, x, y, 16, 16, pal.face);
          const pat = FACE_PATTERN[pal.pattern];
          if (pat) pat(c, x, y, pal, X, Y);
          px(c, x, y, 16, 2, pal.trim); px(c, x, y, 16, 1, pal.trimLite);
          px(c, x, y + 2, 16, 1, pal.dark);
          px(c, x, y + 12, 16, 1, shadeHex(pal.low, 0.18));
          px(c, x, y + 13, 16, 2, pal.low);
          px(c, x, y + 15, 16, 1, '#17182A');
          // Door frames where the face meets a passage.
          if (!this.isWall(X - 1, Y)) { px(c, x, y, 2, 16, '#2A2B3E'); px(c, x + 1, y, 1, 16, shadeHex(pal.trim, -0.2)); }
          if (!this.isWall(X + 1, Y)) { px(c, x + 14, y, 2, 16, '#2A2B3E'); px(c, x + 14, y, 1, 16, shadeHex(pal.trim, -0.2)); }
        } else if (Y === ROWS - 1) {
          this._paintFacade(c, X, Y);
        } else {
          // Wall top (cap): dark, with light rims where it borders a room.
          px(c, x, y, 16, 16, '#232536');
          if (hash(X, Y, 71) < 0.5) px(c, x + 3 + ((hash(X, Y, 72) * 10) | 0), y + 4 + ((hash(X, Y, 73) * 8) | 0), 2, 1, '#28293C');
          const rim = '#41456A', rim2 = '#2E3150';
          const up = Y > 0 ? this.tiles[(Y - 1) * COLS + X] : WALL;
          if (up === FLOOR) { px(c, x, y, 16, 1, rim); px(c, x, y + 1, 16, 1, rim2); }
          if (up === SKY) { px(c, x, y, 16, 1, '#5A5F86'); }
          const lf = X > 0 ? this.tiles[i - 1] : WALL, rt = X < COLS - 1 ? this.tiles[i + 1] : WALL;
          if (lf === FLOOR || lf === SKY) { px(c, x, y, 1, 16, rim); px(c, x + 1, y, 1, 16, rim2); }
          if (rt === FLOOR || rt === SKY) { px(c, x + 15, y, 1, 16, rim); px(c, x + 14, y, 1, 16, rim2); }
          if (below === WALL && Y + 2 < ROWS && this.tiles[(Y + 2) * COLS + X] === FLOOR) px(c, x, y + 15, 16, 1, '#2D2F47');
        }
      }
    }
  };

  /** Outer facade (bottom row): concrete with windows, lit at night by a separate overlay. */
  Office.prototype._paintFacade = function (c, X, Y) {
    const x = X * T, y = Y * T;
    px(c, x, y, 16, 16, '#2E2A44');
    px(c, x, y, 16, 1, '#4A4568'); px(c, x, y + 1, 16, 1, '#3A3656');
    px(c, x, y + 13, 16, 3, '#24213A');
    if (X % 2 === 0) px(c, x + 15, y + 2, 1, 11, '#262338');
    if (X > 0 && X < COLS - 1) {
      px(c, x + 3, y + 4, 10, 7, '#3E3A5C');
      px(c, x + 4, y + 5, 8, 5, '#151B30');
      px(c, x + 4, y + 5, 8, 1, '#232B48');
      px(c, x + 7, y + 5, 1, 5, '#3E3A5C');
      if (!this._facadeWins) this._facadeWins = [];
      this._facadeWins.push({ x: x + 4, y: y + 5, w: 8, h: 5, lit: hash(X, Y, 74) < 0.55, warm: hash(X, Y, 75) < 0.7 });
    }
  };

  const WORLD_MAP = [
    '..####......####...#########..',
    '.######....##.##..###########.',
    '..####......###..############.',
    '....###.....####...######..##.',
    '.....##......###....###....#..',
    '......#.......#......#.....##.'
  ];

  /** Wall decorations baked into the base layer. Painters may register emissive rects / dynamic anchors. */
  const BASE_DECOR = {
    window(c, d, o) {
      const x = d.x * T, y = d.y * T, w = d.w * T;
      px(c, x + 1, y + 2, w - 2, 11, '#D9D4E8'); px(c, x + 1, y + 2, w - 2, 1, '#F1EEF8');
      px(c, x + 2, y + 3, w - 4, 9, '#1B2652');
      px(c, x, y + 12, w, 2, '#E6E1F0'); px(c, x, y + 14, w, 1, '#4A4468');
      o._windows.push({ x: x + 2, y: y + 3, w: w - 4, h: 9, seed: d.x });
    },
    sidewin(c, d, o) {
      const x = d.side === 'left' ? d.x * T + 11 : d.x * T + 1, y = d.y * T + 2, h = d.h * T - 4;
      px(c, x - 1, y - 1, 6, h + 2, '#8E8AA8');
      px(c, x, y, 4, h, '#1B2652');
      o._sideWins.push({ x, y, w: 4, h, side: d.side });
    },
    clock(c, d) {
      const cx = d.x * T + 8, cy = d.y * T + 7;
      const rows = ['..####..', '.#....#.', '#......#', '#......#', '#......#', '#......#', '.#....#.', '..####..'];
      rows.forEach((r, j) => { for (let i = 0; i < 8; i++) if (r[i] === '#') px(c, cx - 4 + i, cy - 4 + j, 1, 1, '#2A2B3A'); });
      px(c, cx - 3, cy - 2, 6, 4, '#F1EEE4'); px(c, cx - 2, cy - 3, 4, 6, '#F1EEE4');
      px(c, cx, cy - 3, 1, 1, '#9B9CB8'); px(c, cx, cy + 2, 1, 1, '#9B9CB8');
      px(c, cx - 3, cy, 1, 1, '#9B9CB8'); px(c, cx + 2, cy, 1, 1, '#9B9CB8');
    },
    kanban(c, d) {
      const x = d.x * T + 2, y = d.y * T + 2, w = d.w * T - 4;
      px(c, x, y, w, 10, '#6B4A2E'); px(c, x + 1, y + 1, w - 2, 8, '#A0794E');
      const cw = Math.floor(w / 3);
      px(c, x + cw, y + 1, 1, 8, '#7E5C3A'); px(c, x + cw * 2, y + 1, 1, 8, '#7E5C3A');
      const notes = ['#F2C14E', '#E0709B', '#7BC67E', '#5BA4E6', '#F2C14E', '#B48EE0', '#F07C6C', '#4FC1B9'];
      for (let k = 0; k < 10; k++) {
        const col = k % 3;
        const row = (k / 3) | 0;
        if (col === 2 && row > 1) continue;
        px(c, x + 2 + col * cw + ((k * 5) % 6), y + 2 + row * 2, 4, 2, notes[k % notes.length]);
      }
    },
    poster(c, d) {
      const x = d.x * T + 3, y = d.y * T + 2;
      px(c, x - 1, y - 1, 12, 12, '#1E1F2C');
      if (d.art === 'clawd') {
        px(c, x, y, 10, 10, '#F3E9D2');
        px(c, x + 2, y + 3, 6, 4, '#D97757'); px(c, x + 1, y + 4, 1, 2, '#D97757'); px(c, x + 8, y + 4, 1, 2, '#D97757');
        px(c, x + 3, y + 4, 1, 1, '#1E1F2C'); px(c, x + 6, y + 4, 1, 1, '#1E1F2C');
        px(c, x + 2, y + 7, 1, 2, '#D97757'); px(c, x + 4, y + 7, 1, 2, '#D97757'); px(c, x + 5, y + 7, 1, 2, '#D97757'); px(c, x + 7, y + 7, 1, 2, '#D97757');
        px(c, x + 1, y + 1, 8, 1, '#E8C9A0');
      } else if (d.art === 'cat') {
        px(c, x, y, 10, 10, '#5BA4E6');
        px(c, x + 2, y + 3, 6, 5, '#F2C14E'); px(c, x + 2, y + 2, 1, 1, '#F2C14E'); px(c, x + 7, y + 2, 1, 1, '#F2C14E');
        px(c, x + 3, y + 4, 1, 1, '#1E1F2C'); px(c, x + 6, y + 4, 1, 1, '#1E1F2C'); px(c, x + 4, y + 6, 2, 1, '#E0709B');
        px(c, x + 1, y + 9, 8, 1, '#ECE8F4');
      } else if (d.art === 'bug') {
        px(c, x, y, 10, 10, '#F3EFE6');
        px(c, x + 3, y + 3, 4, 5, '#3A3A44'); px(c, x + 4, y + 2, 2, 1, '#3A3A44');
        px(c, x + 2, y + 4, 1, 1, '#3A3A44'); px(c, x + 7, y + 4, 1, 1, '#3A3A44'); px(c, x + 2, y + 6, 1, 1, '#3A3A44'); px(c, x + 7, y + 6, 1, 1, '#3A3A44');
        for (let k = 0; k < 8; k++) { px(c, x + 1 + k, y + 1 + k, 1, 1, '#E5534B'); px(c, x + 8 - k, y + 1 + k, 1, 1, '#E5534B'); }
      } else {
        // "ship it" rocket
        px(c, x, y, 10, 10, '#262B4A');
        px(c, x + 4, y + 1, 2, 6, '#ECE8F4'); px(c, x + 3, y + 3, 4, 3, '#ECE8F4'); px(c, x + 4, y + 3, 2, 1, '#5BA4E6');
        px(c, x + 2, y + 5, 1, 2, '#E5534B'); px(c, x + 7, y + 5, 1, 2, '#E5534B');
        px(c, x + 4, y + 7, 2, 1, '#F2C14E'); px(c, x + 4, y + 8, 1, 1, '#E8955A');
        px(c, x + 1, y + 1, 1, 1, '#F2C14E'); px(c, x + 8, y + 2, 1, 1, '#ECE8F4');
      }
    },
    whiteboard(c, d, o) {
      const x = d.x * T + 2, y = d.y * T - 2, w = d.w * T - 4, h = 13;
      px(c, x, y, w, h, '#9AA3B5'); px(c, x, y, w, 1, '#C3C9D6');
      px(c, x + 1, y + 1, w - 2, h - 2, '#ECEFF4');
      px(c, x + 3, y + h, w - 6, 2, '#7A8296');
      px(c, x + 8, y + h, 4, 1, '#E5534B'); px(c, x + 14, y + h, 4, 1, '#5BA4E6'); px(c, x + 20, y + h, 3, 1, '#2A2B3A');
      o._whiteboard = { x: x + 1, y: y + 1, w: w - 2, h: h - 2 };
    },
    projscreen(c, d, o) {
      const x = d.x * T + 2, w = d.w * T - 4, y = d.y * T - 8;
      px(c, x - 1, y, w + 2, 4, '#3A3B4E'); px(c, x - 1, y, w + 2, 1, '#5A5C74'); px(c, x - 2, y + 1, 1, 2, '#2A2B3A'); px(c, x + w + 1, y + 1, 1, 2, '#2A2B3A');
      px(c, x, y + 4, w, 15, '#E3E5EE'); px(c, x, y + 4, w, 1, '#C9CCD8');
      px(c, x, y + 19, w, 1, '#2A2B3A'); px(c, x + (w >> 1) - 1, y + 20, 2, 1, '#2A2B3A');
      o._projscreen = { x: x + 2, y: y + 6, w: w - 4, h: 11 };
    },
    menu(c, d) {
      const x = d.x * T + 2, y = d.y * T + 1;
      px(c, x, y, 12, 11, '#5E3B22'); px(c, x + 1, y + 1, 10, 9, '#26332B');
      px(c, x + 2, y + 2, 5, 1, '#E8E4D8'); px(c, x + 2, y + 4, 7, 1, '#C9C5B8'); px(c, x + 2, y + 6, 4, 1, '#C9C5B8'); px(c, x + 2, y + 8, 6, 1, '#C9C5B8');
      px(c, x + 8, y + 6, 2, 2, '#E8955A');
    },
    neon(c, d, o) {
      const x = d.x * T + 3, y = d.y * T + 2;
      px(c, x - 1, y - 1, 12, 11, '#2A1E1A');
      o._neon = { x, y };
    },
    logo(c, d) {
      const x = d.x * T, y = d.y * T, w = d.w * T;
      px(c, x + 2, y + 2, w - 4, 10, '#3A2A1E'); px(c, x + 3, y + 3, w - 6, 8, '#4A3626');
      // Small Clawd + "PIXELQG" in gold letters.
      const gx = x + 5, gy = y + 5;
      px(c, gx, gy, 6, 3, '#D97757'); px(c, gx - 1, gy + 1, 1, 1, '#D97757'); px(c, gx + 6, gy + 1, 1, 1, '#D97757');
      px(c, gx + 1, gy + 1, 1, 1, '#1E1F2C'); px(c, gx + 4, gy + 1, 1, 1, '#1E1F2C');
      px(c, gx, gy + 3, 1, 1, '#D97757'); px(c, gx + 2, gy + 3, 1, 1, '#D97757'); px(c, gx + 3, gy + 3, 1, 1, '#D97757'); px(c, gx + 5, gy + 3, 1, 1, '#D97757');
      drawPixelText(c, 'PIXELQG', x + 14, y + 5, '#F2C14E', 1);
      px(c, x + 14, y + 11, measurePixelText('PIXELQG'), 1, '#8A6A3A');
    },
    elevator(c, d, o) {
      const x0 = d.x * T - 4, y0 = (d.y - 1) * T + 4, w = d.w * T + 8;
      // Steel frame rising above the wall face, header panel, cabin interior behind the doors.
      px(c, x0, y0, w, (d.y + 1) * T - y0, '#8A90A6');
      px(c, x0, y0, w, 1, '#C5CAD8'); px(c, x0, y0, 1, (d.y + 1) * T - y0, '#B5BACB'); px(c, x0 + w - 1, y0, 1, (d.y + 1) * T - y0, '#5C6274');
      px(c, x0 + 3, y0 + 2, w - 6, 7, '#1A1C28'); px(c, x0 + 3, y0 + 2, w - 6, 1, '#2A2C3C');
      const dx = d.x * T, dy = y0 + 10, dw = d.w * T, dh = (d.y + 1) * T - dy;
      px(c, dx, dy, dw, dh, '#D9B67A'); px(c, dx, dy, dw, 2, '#F2D7A0');
      px(c, dx + 2, dy + 9, dw - 4, 1, '#B08A50'); px(c, dx + 3, dy + 3, dw - 6, 5, '#E6C58A');
      px(c, dx, dy + dh - 3, dw, 3, '#9A7A48');
      px(c, x0 + w + 1, y0 + 14, 3, 6, '#5C6274'); px(c, x0 + w + 2, y0 + 15, 1, 1, '#F2C14E'); px(c, x0 + w + 2, y0 + 18, 1, 1, '#F2C14E');
      o._elevator = { x: dx, y: dy, w: dw, h: dh, ix: x0 + 3, iy: y0 + 2, iw: w - 6, ih: 7 };
      o._emit(x0 + 3, y0 + 2, w - 6, 7, '#F2C14E');
    },
    agents(c, d, o) {
      const x = d.x * T + 1, y = (d.y - 1) * T + 3, w = d.w * T - 2, h = 26;
      px(c, x - 1, y - 1, w + 2, h + 2, '#14151F');
      px(c, x, y, w, h, '#3A3D52'); px(c, x, y, w, 1, '#5A5E7A');
      px(c, x + 2, y + 2, w - 4, h - 4, '#0C1220');
      px(c, x + (w >> 1) - 6, y + h + 1, 12, 2, '#2A2B3A');
      o._agentsBoard = { x: x + 2, y: y + 2, w: w - 4, h: h - 4 };
      o._emit(x + 2, y + 2, w - 4, h - 4, '#5BA4E6');
    },
    vent(c, d, o) {
      const x = d.x * T + 2, y = d.y * T + 3;
      px(c, x, y, 12, 9, '#1A1F2C'); px(c, x, y, 12, 1, '#56617E');
      px(c, x + 1, y + 1, 10, 7, '#0E1118');
      o._vents.push({ cx: x + 6, cy: y + 4 });
    },
    warning(c, d) {
      const x = d.x * T + 3, y = d.y * T + 2;
      for (let j = 0; j < 9; j++) px(c, x + 4 - (j >> 1), y + j, 2 + (j >> 1) * 2, 1, '#F2C14E');
      px(c, x, y + 9, 10, 1, '#1E1F2C');
      px(c, x + 5, y + 3, 1, 2, '#1E1F2C'); px(c, x + 4, y + 5, 2, 1, '#1E1F2C'); px(c, x + 4, y + 6, 1, 2, '#1E1F2C');
    },
    breaker(c, d) {
      const x = d.x * T + 3, y = d.y * T + 2;
      px(c, x, y, 10, 10, '#56617E'); px(c, x + 1, y + 1, 8, 8, '#3A4256');
      for (let k = 0; k < 4; k++) { px(c, x + 2 + k * 2, y + 3, 1, 4, '#1A1F2C'); px(c, x + 2 + k * 2, y + 3 + (k % 2) * 2, 1, 2, '#C9CFDD'); }
    },
    testboard(c, d, o) {
      const x = d.x * T + 1, y = (d.y - 1) * T + 8, w = d.w * T - 2, h = 22;
      px(c, x - 1, y - 1, w + 2, h + 2, '#14151F');
      px(c, x, y, w, h, '#2E3B44'); px(c, x, y, w, 1, '#4E6270');
      px(c, x + 1, y + 1, w - 2, h - 2, '#0D151A');
      drawPixelText(c, 'SALLE DE TESTS', x + 3, y + 3, '#6CC28A', 1);
      px(c, x + 2, y + 9, w - 4, 1, '#1E2E36');
      o._testBoard = { x: x + 1, y: y + 1, w: w - 2, h: h - 2, lx: x + 3, ly: y + 11 };
      o._emit(x + 1, y + 1, w - 2, h - 2, '#6CC28A');
    },
    tube(c, d, o) {
      const x0 = d.x * T, y = (d.y - 1) * T + 8, x1 = 47 * T, yb = 26 * T - 15;
      // Glass pneumatic pipe running along the wall top, then down into the receiver.
      px(c, x0 - 2, y - 6, 4, 6, '#6E7389');
      px(c, x0 - 2, y - 1, x1 - x0 + 4, 5, '#5C6274');
      px(c, x0 - 2, y, x1 - x0 + 3, 3, '#9FD8F0'); px(c, x0 - 2, y, x1 - x0 + 3, 1, '#D6F2FB');
      px(c, x1 - 2, y - 1, 5, yb - y + 2, '#5C6274'); px(c, x1 - 1, y, 3, yb - y + 1, '#9FD8F0'); px(c, x1 - 1, y, 1, yb - y + 1, '#D6F2FB');
      for (let bx = x0 + 10; bx < x1 - 4; bx += 24) px(c, bx, y - 1, 2, 5, '#8A90A6');
      o._tube = { x0, y: y + 1, x1, yb };
    },
    worldmap(c, d, o) {
      const x = d.x * T + 1, y = (d.y - 1) * T + 6, w = d.w * T - 2, h = 24;
      px(c, x - 1, y - 1, w + 2, h + 2, '#14151F');
      px(c, x, y, w, h, '#2A2B3A');
      px(c, x + 2, y + 2, w - 4, h - 4, '#0E2340');
      const mx = x + 3, my = y + 3;
      WORLD_MAP.forEach((row, j) => {
        for (let i = 0; i < row.length; i++) if (row[i] === '#') px(c, mx + i * 3, my + j * 3, 3, 3, (i + j) % 3 ? '#2F7A6B' : '#2A6E61');
      });
      for (let i = 0; i < 30; i += 5) px(c, mx + i * 3, my, 1, 18, 'rgba(79,193,185,0.12)');
      px(c, x + (w >> 1) - 5, y + h + 1, 10, 2, '#2A2B3A');
      o._worldMap = { x: mx, y: my, w: 90, h: 18 };
      o._emit(x + 2, y + 2, w - 4, h - 4, '#4FC1B9');
    }
  };

  const BASE_FURN = {
    rug(c, f) {
      const x = f.x * T + 2, y = f.y * T + 2, w = f.w * T - 4, h = f.h * T - 4;
      px(c, x, y, w, h, f.border); px(c, x + 2, y + 2, w - 4, h - 4, f.color);
      px(c, x + 4, y + 4, w - 8, 1, f.border); px(c, x + 4, y + h - 5, w - 8, 1, f.border);
      px(c, x + 4, y + 4, 1, h - 8, f.border); px(c, x + w - 5, y + 4, 1, h - 8, f.border);
      for (let j = y + 8; j < y + h - 8; j += 6) for (let i = x + 8 + ((j - y) % 12 === 2 ? 3 : 0); i < x + w - 8; i += 6) px(c, i, j, 2, 2, f.border);
      for (let j = y + 1; j < y + h - 1; j += 2) { px(c, x - 2, j, 2, 1, '#D8CFB8'); px(c, x + w, j, 2, 1, '#D8CFB8'); }
    },
    chair(c, f) {
      const x = f.x * T, y = f.y * T;
      const col = f.tint || '#3C4160', hi = shadeHex(col, 0.18), lo = shadeHex(col, -0.28);
      if (f.dir === 'down') {
        px(c, x + 3, y + 1, 10, 4, col); px(c, x + 3, y + 1, 10, 1, hi);
        px(c, x + 2, y + 5, 12, 6, lo); px(c, x + 2, y + 5, 12, 1, col);
        px(c, x + 3, y + 12, 2, 2, '#1C1E2C'); px(c, x + 11, y + 12, 2, 2, '#1C1E2C');
      } else if (f.dir === 'left' || f.dir === 'right') {
        const bx = f.dir === 'right' ? x + 2 : x + 11;
        px(c, x + 3, y + 5, 10, 7, lo); px(c, x + 3, y + 5, 10, 1, col);
        px(c, bx, y + 1, 3, 11, col); px(c, bx, y + 1, 3, 1, hi);
        px(c, x + 4, y + 13, 2, 1, '#1C1E2C'); px(c, x + 10, y + 13, 2, 1, '#1C1E2C');
      } else {
        px(c, x + 3, y + 2, 10, 7, col); px(c, x + 3, y + 2, 10, 1, hi);
        px(c, x + 2, y + 9, 12, 4, lo); px(c, x + 2, y + 9, 12, 1, col);
        px(c, x + 3, y + 14, 2, 1, '#1C1E2C'); px(c, x + 11, y + 14, 2, 1, '#1C1E2C'); px(c, x + 7, y + 14, 2, 1, '#1C1E2C');
      }
    },
    stool(c, f) {
      const x = f.x * T, y = f.y * T;
      if (f.wood) {
        px(c, x + 4, y + 10, 8, 4, '#5E3B22');
        px(c, x + 3, y + 5, 10, 6, '#A87650'); px(c, x + 3, y + 5, 10, 1, '#C08A5E'); px(c, x + 3, y + 10, 10, 1, '#7A5232');
        return;
      }
      px(c, x + 5, y + 10, 6, 4, '#3A3A44');
      px(c, x + 3, y + 5, 10, 6, '#B5643C'); px(c, x + 4, y + 4, 8, 1, '#C97A4C'); px(c, x + 3, y + 10, 10, 1, '#8A4A2A');
    },
    inlay(c, f) {
      const x = f.x * T + 2, y = f.y * T + 2, w = f.w * T - 4, h = f.h * T - 4;
      px(c, x, y, w, h, '#C9A15C'); px(c, x + 1, y + 1, w - 2, h - 2, '#2C2A3E'); px(c, x + 3, y + 3, w - 6, h - 6, '#C9A15C');
      px(c, x + 4, y + 4, w - 8, h - 8, '#3A3650');
      // Big Clawd mosaic in the middle of the hall.
      const s = 3, bw = 14, cx = x + Math.round((w - bw * s) / 2), cy = y + 12;
      px(c, cx, cy, bw * s, 8 * s, '#D97757');
      px(c, cx, cy, bw * s, s, '#E89A7E');
      px(c, cx - 2 * s, cy + 3 * s, 2 * s, 2 * s, '#D97757'); px(c, cx + bw * s, cy + 3 * s, 2 * s, 2 * s, '#D97757');
      px(c, cx + 3 * s, cy + 2 * s, 2 * s, 2 * s, '#14151F'); px(c, cx + 9 * s, cy + 2 * s, 2 * s, 2 * s, '#14151F');
      for (const lx of [1, 4, 9, 12]) px(c, cx + lx * s, cy + 8 * s, s, 2 * s, '#B85E40');
      px(c, cx, cy + 7 * s, bw * s, s, '#B85E40');
      const label = 'QG';
      drawPixelText(c, label, x + Math.round((w - measurePixelText(label) * 2) / 2), y + h - 16, '#C9A15C', 2);
      for (let k = 0; k < 4; k++) {
        const sx = k % 2 ? x + w - 9 : x + 6, sy = k < 2 ? y + 6 : y + h - 9;
        px(c, sx, sy + 1, 3, 1, '#C9A15C'); px(c, sx + 1, sy, 1, 3, '#C9A15C');
      }
    }
  };

  /** Hanging room sign in the bitmap font, in the room accent colour, on the wall cap above the room. */
  function paintSign(c, room) {
    if (!room.signAt) return;
    const label = room.sign;
    const tw = measurePixelText(label);
    const w = tw + 8, h = 11;
    const x0 = Math.round(room.signAt.cx - w / 2), y0 = room.signAt.row * T + 3;
    px(c, x0 + 1, y0 + 1, w, h, 'rgba(0,0,0,0.35)');
    px(c, x0, y0, w, h, '#14151F');
    px(c, x0 + 1, y0 + 1, w - 2, h - 2, '#262839');
    px(c, x0 + 1, y0 + 1, w - 2, 1, room.accent);
    px(c, x0 + 2, y0 + 5, 2, 2, room.accent);
    drawPixelText(c, label, x0 + 5, y0 + 4, '#F5ECD7', 1);
    px(c, x0 + 3, y0 - 2, 1, 2, '#9B9CB8'); px(c, x0 + w - 4, y0 - 2, 1, 2, '#9B9CB8');
  }

  Office.prototype._emit = function (x, y, w, h, color) {
    this.emissive.push({ x: Math.round(x), y: Math.round(y), w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)), color: color || '#FFFFFF' });
  };

  Office.prototype._paintBase = function (c) {
    c.imageSmoothingEnabled = false;
    this.emissive = [];
    this._windows = []; this._sideWins = []; this._vents = []; this._facadeWins = [];
    px(c, 0, 0, WIDTH, HEIGHT, '#14151F');
    this._paintFloors(c);
    for (const f of this.furniture) if (f.layer === 'base' && (f.kind === 'rug' || f.kind === 'inlay')) BASE_FURN[f.kind](c, f);
    this._paintFloorShadows(c);
    for (const f of this.furniture) if (f.layer === 'base' && f.kind !== 'rug' && f.kind !== 'inlay' && BASE_FURN[f.kind]) BASE_FURN[f.kind](c, f);
    this._paintWalls(c);
    for (const d of this.decor) if (BASE_DECOR[d.kind]) BASE_DECOR[d.kind](c, d, this);
    for (const room of this.roomList) paintSign(c, room);
    // Spawn mat in front of the elevator.
    px(c, 26 * T + 1, 24 * T + 1, 30, 13, '#3E2A22'); px(c, 26 * T + 2, 24 * T + 2, 28, 11, '#5B3A2A');
    for (let j = 24 * T + 4; j < 24 * T + 12; j += 2) px(c, 26 * T + 4, j, 24, 1, '#6A4634');
    for (const fw of this._facadeWins) if (fw.lit) this._emit(fw.x, fw.y + 1, fw.w, fw.h - 1, fw.warm ? '#FFD98A' : '#9FD8F0');
  };

  // ------------------------------------------------------------------ furniture (depth-sorted items)
  const BOOK_COLORS = ['#C0504D', '#4F81BD', '#9BBB59', '#F2C14E', '#8064A2', '#4BACC6', '#F79646', '#E0709B', '#ECE8F4', '#7BC67E'];

  function blob(c, r, cx, cy, rx, ry, n, colors) {
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r());
      px(c, Math.round(cx + Math.cos(a) * rx * d), Math.round(cy + Math.sin(a) * ry * d), 2, 2, colors[(r() * colors.length) | 0]);
    }
  }

  /** Generic 3/4 box: top surface (lighter) + front face (darker) + contact line. */
  function box(c, x, y, w, h, top, col, depth) {
    const d = depth == null ? Math.min(6, h >> 1) : depth;
    px(c, x, y, w, d, top); px(c, x, y, w, 1, shadeHex(top, 0.18));
    px(c, x, y + d, w, h - d, col); px(c, x, y + d, w, 1, shadeHex(col, -0.25));
    px(c, x, y + h - 1, w, 1, shadeHex(col, -0.45));
  }

  function mug(c, x, y, color) {
    px(c, x, y, 3, 3, color || '#F3EFE6'); px(c, x, y, 3, 1, '#6B4226'); px(c, x + 3, y + 1, 1, 1, color || '#F3EFE6');
  }

  /** Each painter draws into an item canvas; the footprint top is at y = R (rise). */
  const FURN = {
    desk(c, f, w, h, R) {
      const top = R - 1;
      px(c, 0, top, 32, 10, '#B07A4C'); px(c, 0, top, 32, 1, '#C99460'); px(c, 0, top + 9, 32, 1, '#946540');
      px(c, 0, R + 9, 32, 6, '#7D5232'); px(c, 0, R + 15, 32, 1, '#4A3020');
      px(c, 1, R + 10, 1, 4, '#6A4428'); px(c, 30, R + 10, 1, 4, '#6A4428');
      // Monitor (screen content is animated).
      px(c, 2, 0, 16, 12, '#1B1C27'); px(c, 2, 0, 16, 1, '#3A3C50'); px(c, 2, 11, 16, 1, '#2A2B3A');
      px(c, 3, 1, 14, 10, '#0C111E');
      px(c, 8, 12, 4, 2, '#2B2D3D'); px(c, 6, 14, 8, 1, '#2B2D3D');
      // Keyboard, mouse, cable.
      px(c, 4, R + 3, 12, 3, '#D8D4CC'); px(c, 4, R + 5, 12, 1, '#B5B0A6');
      for (let i = 0; i < 6; i++) px(c, 5 + i * 2, R + 4, 1, 1, '#A8A39A');
      px(c, 18, R + 4, 2, 2, '#D8D4CC'); px(c, 18, R + 3, 1, 1, '#2A2B3A');
      px(c, 17, 13, 1, 2, '#2A2B3A'); px(c, 18, 14, 3, 1, '#2A2B3A');
      const r = rng(f.seed * 7 + 11);
      const deco = (r() * 5) | 0;
      if (deco === 0) mug(c, 26, R, ['#F3EFE6', '#E0709B', '#5BA4E6'][(r() * 3) | 0]);
      else if (deco === 1) { px(c, 25, R + 1, 5, 4, '#B0643C'); px(c, 25, R + 1, 5, 1, '#C97A4C'); blob(c, r, 27, R - 2, 4, 3, 14, ['#4E9A55', '#6CC28A', '#3E8E4E']); }
      else if (deco === 2) { px(c, 28, R + 3, 3, 2, '#3A3A44'); px(c, 29, R - 4, 1, 7, '#3A3A44'); px(c, 25, R - 6, 6, 3, '#F2C14E'); px(c, 25, R - 4, 6, 1, '#B8923A'); }
      else if (deco === 3) { px(c, 25, R - 3, 6, 6, '#3A3B4E'); px(c, 26, R - 2, 4, 4, ['#7BC67E', '#F2C14E', '#E0709B'][(r() * 3) | 0]); px(c, 26, R, 4, 2, '#5BA4E6'); }
      else { px(c, 24, R - 1, 7, 5, '#2A2B3A'); px(c, 25, R, 2, 3, BOOK_COLORS[(r() * BOOK_COLORS.length) | 0]); px(c, 27, R, 2, 3, BOOK_COLORS[(r() * BOOK_COLORS.length) | 0]); px(c, 29, R + 1, 1, 2, '#ECE8F4'); }
      if (r() < 0.5) { px(c, 21, R - 2, 2, 3, '#F2C14E'); px(c, 22, R - 3, 1, 1, '#F2C14E'); }
      f.emit = [[3, 1, 14, 10, '#8FA8FF']];
    },
    cooler(c) {
      px(c, 4, 0, 8, 9, '#7FB8E8'); px(c, 5, 1, 2, 6, '#B9DCF7'); px(c, 6, 9, 4, 1, '#4F81BD');
      px(c, 3, 10, 10, 17, '#E6E6EE'); px(c, 3, 10, 10, 1, '#FFFFFF'); px(c, 12, 11, 1, 16, '#B5B8C8');
      px(c, 5, 15, 2, 2, '#5BA4E6'); px(c, 9, 15, 2, 2, '#E5534B'); px(c, 5, 21, 6, 1, '#9B9CB8');
      px(c, 4, 27, 8, 1, '#7A7F8C');
    },
    printer(c, f, w, h, R) {
      px(c, 4, 0, 8, 4, '#FFFFFF'); px(c, 5, 1, 6, 1, '#C9C5B8');
      box(c, 1, 3, 14, h - 4, '#F0F0F5', '#C8C8D2', 5);
      px(c, 3, 5, 10, 1, '#3A3A44'); px(c, 11, 10, 2, 1, '#6CC28A');
      px(c, 3, R + 4, 10, 2, '#EFEFF4');
    },
    filecab(c, f, w, h) {
      box(c, 1, 0, 14, h - 1, '#9AA0B5', '#7E8498', 4);
      for (let k = 0; k < 3; k++) { const yy = 6 + k * 6; px(c, 2, yy, 12, 1, '#5C6274'); px(c, 6, yy + 2, 4, 1, '#C9CFDD'); }
      px(c, 3, 1, 5, 2, '#F3EFE6');
    },
    plant(c, f) {
      const r = rng(f.seed * 31 + 7);
      const v = f.v !== undefined ? f.v : f.seed % 3;
      if (v === 0) blob(c, r, 8, 11, 6, 7, 72, ['#3E8E4E', '#58B068', '#7BC67E', '#2F6E3C']);
      else if (v === 1) {
        for (let k = 0; k < 6; k++) {
          const x = 3 + k * 2, top = 2 + ((r() * 8) | 0);
          px(c, x, top, 2, 19 - top, k % 2 ? '#3E8E4E' : '#58B068'); px(c, x, top, 1, 1, '#9BD39A');
        }
      } else {
        blob(c, r, 5, 10, 4, 5, 30, ['#2F7A45', '#4E9A55']);
        blob(c, r, 11, 8, 4, 5, 30, ['#3E8E4E', '#6CC28A']);
        blob(c, r, 8, 14, 6, 3, 20, ['#2F6E3C', '#58B068']);
        px(c, 7, 6, 2, 2, '#F2C14E'); px(c, 4, 12, 1, 1, '#E0709B');
      }
      px(c, 3, 19, 10, 2, '#C97A4C'); px(c, 4, 21, 8, 6, '#B0643C'); px(c, 10, 21, 2, 6, '#8A4A2A'); px(c, 4, 27, 8, 1, '#5E3220');
    },
    tree(c, f, w, h) {
      const r = rng(f.seed * 17 + 5);
      const v = f.v || 0;
      px(c, 7, 14, 2, h - 26, '#6B4A2E');
      if (v === 1) {
        for (let k = 0; k < 7; k++) {
          const a = -Math.PI / 2 + (k - 3) * 0.42;
          for (let s = 2; s < 13; s++) px(c, Math.round(8 + Math.cos(a) * s * 0.8), Math.round(14 + Math.sin(a) * s), 2, 1, s % 3 ? '#3E8E4E' : '#58B068');
        }
      } else {
        blob(c, r, 8, 9, 7, 8, 120, ['#2F6E3C', '#3E8E4E', '#58B068', '#7BC67E']);
        blob(c, r, 6, 5, 4, 3, 20, ['#7BC67E', '#9BD39A']);
      }
      px(c, 2, h - 13, 12, 2, '#D6CFC4'); px(c, 3, h - 11, 10, 10, '#9AA0B5'); px(c, 3, h - 11, 10, 1, '#C9CFDD'); px(c, 11, h - 11, 2, 10, '#7E8498');
      px(c, 3, h - 1, 10, 1, '#4A4E5E');
    },
    beanbag(c, f, w, h) {
      const col = f.color || '#E0709B';
      px(c, 2, 4, 12, 11, col); px(c, 1, 6, 14, 8, col); px(c, 3, 3, 10, 1, shadeHex(col, 0.25));
      px(c, 4, 5, 8, 4, shadeHex(col, -0.18)); px(c, 1, 13, 14, 2, shadeHex(col, -0.35)); px(c, 3, 15, 10, 1, shadeHex(col, -0.5));
    },
    lowtable(c) {
      box(c, 2, 4, 28, 12, '#8A5A36', '#5E3B22', 8);
      px(c, 6, 6, 6, 3, '#ECE8DD'); px(c, 7, 7, 4, 1, '#9C9585'); mug(c, 18, 5, '#5BA4E6'); px(c, 23, 6, 4, 2, '#F2C14E');
      px(c, 3, 16, 2, 2, '#3E2716'); px(c, 27, 16, 2, 2, '#3E2716');
    },
    shelf(c, f, w, h) {
      const r = rng(f.seed * 13 + 1);
      px(c, 0, 0, 32, h, '#4A2F1C'); px(c, 2, 3, 28, h - 6, '#2E1D12');
      px(c, 0, 0, 32, 3, '#7A5232'); px(c, 0, 0, 32, 1, '#9A6E44');
      for (const by of [11, 19, 27]) {
        let x = 3;
        while (x < 28) {
          const bw = 2 + ((r() * 2) | 0), bh = 5 + ((r() * 3) | 0);
          if (r() < 0.1) { x += 2; continue; }
          const col = BOOK_COLORS[(r() * BOOK_COLORS.length) | 0];
          if (r() < 0.08 && x < 24) { px(c, x, by - 2, 5, 2, col); px(c, x, by - 2, 5, 1, '#F5F0E6'); x += 5; continue; }
          px(c, x, by - bh, Math.min(bw, 29 - x), bh, col);
          px(c, x, by - bh + 1, 1, 1, '#F5F0E6');
          px(c, x, by - bh + 3, Math.min(bw, 29 - x), 1, shadeHex(col, -0.3));
          x += bw;
        }
        px(c, 1, by, 30, 2, '#7A5232'); px(c, 1, by, 30, 1, '#94683F');
      }
      px(c, 0, h - 3, 32, 3, '#3A2416');
      if (f.ladder) {
        // Rolling library ladder leaning on the shelf + its rail.
        px(c, 0, 2, 32, 1, '#C9A15C');
        for (let y = 2; y < h - 1; y++) {
          const lx = 20 + Math.round((y - 2) * 0.22);
          px(c, lx, y, 1, 1, '#B08850'); px(c, lx + 7, y, 1, 1, '#B08850');
          if ((y - 2) % 5 === 4) px(c, lx + 1, y, 6, 1, '#C99E62');
        }
        px(c, 20, 2, 1, 2, '#C9A15C'); px(c, 27, 2, 1, 2, '#C9A15C');
      }
    },
    statue(c, f, w, h) {
      box(c, 2, h - 12, 12, 12, '#E6E1F0', '#B5AFC6', 3);
      px(c, 4, h - 6, 8, 1, '#C9A15C');
      const y = h - 23;
      px(c, 2, y + 3, 12, 6, '#E2B04A'); px(c, 2, y + 3, 12, 1, '#F8DA88');
      px(c, 0, y + 5, 2, 2, '#E2B04A'); px(c, 14, y + 5, 2, 2, '#E2B04A');
      px(c, 4, y + 5, 2, 2, '#5A4018'); px(c, 10, y + 5, 2, 2, '#5A4018');
      for (const lx of [3, 6, 9, 12]) px(c, lx, y + 9, 1, 2, '#C08A30');
      px(c, 2, y + 8, 12, 1, '#C08A30');
    },
    readtable(c, f, w, h, R) {
      px(c, 1, R + 1, 62, 25, '#8A5A36'); px(c, 1, R + 1, 62, 1, '#A06B42');
      px(c, 1, R + 26, 62, 4, '#5E3B22');
      px(c, 3, R + 30, 3, 2, '#3E2716'); px(c, 58, R + 30, 3, 2, '#3E2716');
      px(c, 26, R + 9, 12, 7, '#EFE9DC'); px(c, 31, R + 9, 2, 7, '#C9BFA8');
      for (let k = 0; k < 3; k++) { px(c, 27, R + 10 + k * 2, 3, 1, '#9C9585'); px(c, 34, R + 10 + k * 2, 3, 1, '#9C9585'); }
      px(c, 46, R + 12, 10, 3, '#4F81BD'); px(c, 47, R + 9, 9, 3, '#C0504D'); px(c, 46, R + 6, 8, 3, '#9BBB59');
      // Green banker's lamp.
      px(c, 14, R + 15, 8, 2, '#C9A15C'); px(c, 17, R + 8, 2, 7, '#C9A15C'); px(c, 12, R + 4, 12, 5, '#2F7A45'); px(c, 12, R + 4, 12, 1, '#58B068'); px(c, 12, R + 8, 12, 1, '#1E5A30');
      mug(c, 6, R + 18, '#E8E2D6');
      px(c, 40, R + 20, 8, 1, '#3A3A44'); px(c, 48, R + 19, 2, 3, '#3A3A44');
    },
    globe(c) {
      px(c, 7, 17, 2, 4, '#5E3B22'); px(c, 4, 21, 8, 2, '#5E3B22');
      px(c, 4, 6, 8, 10, '#3F7FBF'); px(c, 3, 8, 10, 6, '#3F7FBF'); px(c, 5, 5, 6, 12, '#3F7FBF');
      px(c, 5, 7, 3, 3, '#6CC28A'); px(c, 9, 10, 2, 4, '#6CC28A'); px(c, 6, 12, 2, 2, '#6CC28A');
      px(c, 2, 10, 1, 2, '#C9A15C'); px(c, 13, 10, 1, 2, '#C9A15C'); px(c, 7, 4, 2, 1, '#C9A15C');
    },
    cardcat(c, f, w, h) {
      box(c, 1, 0, 14, h - 1, '#A06B42', '#7A5232', 4);
      for (let j = 0; j < 4; j++) for (let i = 0; i < 2; i++) {
        const x = 2 + i * 6, y = 6 + j * 5;
        px(c, x, y, 5, 4, '#8A5A36'); px(c, x + 2, y + 1, 1, 1, '#E8D6A8'); px(c, x + 1, y + 2, 3, 1, '#F5ECD7');
      }
    },
    floorlamp(c, f, w, h) {
      px(c, 7, 8, 2, h - 12, '#3A3A44'); px(c, 4, h - 4, 8, 3, '#2A2A33'); px(c, 4, h - 4, 8, 1, '#4A4A56');
      px(c, 2, 0, 12, 8, '#E8C35A'); px(c, 3, 0, 10, 1, '#F5DA8A'); px(c, 2, 7, 12, 1, '#B8923A');
      px(c, 6, 8, 4, 1, '#F8E6A0');
    },
    sidetable(c) {
      px(c, 2, 4, 12, 6, '#8A5A36'); px(c, 2, 4, 12, 1, '#A06B42'); px(c, 3, 10, 10, 3, '#5E3B22');
      px(c, 7, 13, 2, 5, '#3E2716');
      px(c, 3, 2, 6, 3, '#C0504D'); px(c, 4, 1, 5, 1, '#4F81BD'); mug(c, 10, 2, '#F3EFE6');
    },
    armchair(c, f) {
      const col = f.color || '#8E3B46', hi = shadeHex(col, 0.18), lo = shadeHex(col, -0.25);
      px(c, 1, 0, 14, 9, col); px(c, 1, 0, 14, 1, hi); px(c, 3, 2, 10, 5, shadeHex(col, 0.08));
      px(c, 2, 8, 12, 9, shadeHex(col, 0.06)); px(c, 2, 8, 12, 1, hi);
      px(c, 0, 5, 3, 13, lo); px(c, 13, 5, 3, 13, lo); px(c, 0, 5, 3, 1, col); px(c, 13, 5, 3, 1, col);
      px(c, 1, 18, 2, 3, '#3E2716'); px(c, 13, 18, 2, 3, '#3E2716'); px(c, 2, 17, 12, 1, lo);
    },
    meettable(c, f, w, h, R) {
      px(c, 2, R + 2, 124, 28, '#6E4A33'); px(c, 2, R + 2, 124, 1, '#8A5E42');
      for (let x = 10; x < 124; x += 18) px(c, x, R + 4, 9, 1, '#7A5238');
      px(c, 2, R + 30, 124, 4, '#4E321F'); px(c, 4, R + 34, 3, 1, '#2E1D12'); px(c, 121, R + 34, 3, 1, '#2E1D12');
      const laptops = [[14, R + 4], [46, R + 4], [78, R + 4], [30, R + 20], [62, R + 20], [94, R + 20]];
      laptops.forEach((p, k) => {
        const up = k < 3;
        px(c, p[0], p[1], 12, 7, '#3A3F52');
        px(c, p[0] + 1, p[1] + (up ? 1 : 0), 10, 5, k % 2 ? '#2B4A7A' : '#2E5E58');
        px(c, p[0] - 1, up ? p[1] + 7 : p[1] - 3, 14, 3, '#9AA0B5');
      });
      px(c, 64, R + 10, 7, 9, '#ECE8DD'); px(c, 66, R + 12, 4, 1, '#9C9585');
      px(c, 110, R + 8, 7, 9, '#ECE8DD'); px(c, 111, R + 10, 4, 1, '#9C9585');
      px(c, 36, R + 12, 2, 3, '#9FD8F0'); px(c, 88, R + 16, 2, 3, '#9FD8F0'); px(c, 8, R + 22, 2, 3, '#9FD8F0');
      // Projector aimed at the screen (beam drawn when the room is busy).
      px(c, 104, R + 18, 12, 6, '#D8D8E0'); px(c, 104, R + 18, 12, 1, '#F0F0F5'); px(c, 113, R + 19, 3, 3, '#3A3A44'); px(c, 114, R + 20, 1, 1, '#9FD8F0');
      px(c, 52, R + 13, 6, 4, '#B0643C'); px(c, 51, R + 9, 8, 4, '#58B068'); px(c, 53, R + 7, 4, 2, '#7BC67E');
    },
    credenza(c, f, w, h) {
      box(c, 0, 6, 32, h - 6, '#A06B42', '#7A5232', 5);
      px(c, 15, 12, 1, h - 14, '#5E3B22'); px(c, 12, 15, 2, 1, '#E8D6A8'); px(c, 18, 15, 2, 1, '#E8D6A8');
      px(c, 4, 1, 4, 7, '#9FD8F0'); px(c, 4, 1, 4, 1, '#D6F2FB'); px(c, 5, 0, 2, 1, '#8E94A3');
      px(c, 10, 5, 2, 3, '#C9E4F0'); px(c, 13, 5, 2, 3, '#C9E4F0');
      px(c, 23, 3, 5, 4, '#B0643C'); px(c, 22, 0, 7, 4, '#58B068'); px(c, 24, -1, 3, 2, '#7BC67E');
    },
    counter(c, f, w, h, R) {
      px(c, 0, R, 80, 7, '#D6CFC4'); px(c, 0, R, 80, 1, '#ECE6DC');
      px(c, 0, R + 7, 80, 9, '#8C5E3E'); for (let x = 15; x < 80; x += 16) px(c, x, R + 8, 1, 7, '#6E4A30');
      px(c, 0, R + 15, 80, 1, '#4A3020');
      // Espresso machine.
      px(c, 2, 0, 22, R + 4, '#2E2F3A'); px(c, 3, 1, 20, 2, '#45475A'); px(c, 2, 0, 22, 1, '#5A5C70');
      px(c, 5, 5, 16, 5, '#1E1F28'); px(c, 7, 6, 3, 2, '#E5534B'); px(c, 12, 6, 2, 2, '#9B9CB8');
      px(c, 7, 10, 3, 2, '#45475A'); px(c, 15, 10, 3, 2, '#45475A');
      mug(c, 7, R, '#F3EFE6'); mug(c, 15, R, '#F3EFE6');
      // Cups, pastries under a glass dome, register.
      for (let k = 0; k < 3; k++) mug(c, 30 + k * 5, R + 1, ['#E0709B', '#5BA4E6', '#F2C14E'][k]);
      px(c, 48, R - 6, 12, 9, '#C9E4F0'); px(c, 48, R - 7, 12, 1, '#8E94A3'); px(c, 49, R - 1, 10, 3, '#F3EFE6');
      px(c, 50, R - 3, 3, 2, '#C98E55'); px(c, 54, R - 3, 3, 2, '#E0709B'); px(c, 52, R - 5, 3, 2, '#F2C14E');
      px(c, 66, R - 5, 10, 7, '#3A3B4E'); px(c, 67, R - 4, 8, 3, '#6CC28A'); px(c, 66, R + 2, 10, 2, '#2A2B3A');
      f.emit = [[7, 6, 3, 2, '#E5534B'], [67, R - 4, 8, 3, '#6CC28A']];
    },
    fridge(c, f, w, h) {
      px(c, 1, 0, 14, h - 1, '#D9DDE6'); px(c, 1, 0, 14, 1, '#F0F2F7'); px(c, 14, 1, 1, h - 2, '#AEB3C0');
      px(c, 1, 12, 14, 1, '#B5BAC6'); px(c, 12, 3, 1, 6, '#8E94A3'); px(c, 12, 15, 1, 10, '#8E94A3');
      px(c, 4, 4, 2, 2, '#E5534B'); px(c, 7, 16, 2, 2, '#5BA4E6'); px(c, 4, 20, 3, 2, '#F2C14E'); px(c, 3, 26, 4, 3, '#F3EFE6');
      px(c, 1, h - 1, 14, 1, '#7A7F8C');
    },
    vending(c, f, w, h) {
      px(c, 0, 0, 16, h - 1, '#B8463F'); px(c, 0, 0, 16, 1, '#D45A52'); px(c, 15, 1, 1, h - 2, '#8A2E28');
      px(c, 2, 2, 9, 24, '#1C2A44');
      const cols = ['#F2C14E', '#7BC67E', '#5BA4E6', '#E0709B'];
      for (let row = 0; row < 5; row++) for (let k = 0; k < 3; k++) px(c, 3 + k * 3, 3 + row * 5, 2, 3, cols[(row + k) % 4]);
      px(c, 12, 4, 3, 12, '#2A2A33'); px(c, 13, 5, 1, 1, '#6CC28A'); px(c, 13, 8, 1, 1, '#F2C14E');
      px(c, 3, 29, 8, 4, '#14151F'); px(c, 0, h - 1, 16, 1, '#6E2A26');
      f.emit = [[2, 2, 9, 24, '#9FD8F0']];
    },
    arcade(c, f, w, h) {
      const body = f.hue ? '#3E4FB8' : '#7A3FB0', hi = shadeHex(body, 0.25), lo = shadeHex(body, -0.3);
      px(c, 1, 0, 14, h - 1, body); px(c, 1, 0, 14, 1, hi); px(c, 14, 1, 1, h - 2, lo);
      px(c, 2, 1, 12, 4, '#F2C14E'); px(c, 3, 2, 10, 2, f.hue ? '#E5534B' : '#4FC1B9');
      px(c, 2, 6, 12, 11, '#14151F'); px(c, 3, 7, 10, 9, '#0A0E1A');
      px(c, 1, 18, 14, 5, lo); px(c, 1, 18, 14, 1, hi);
      px(c, 4, 19, 2, 2, '#E5534B'); px(c, 9, 20, 1, 1, '#F2C14E'); px(c, 11, 20, 1, 1, '#5BA4E6');
      px(c, 6, 27, 4, 3, '#14151F'); px(c, 7, 28, 2, 1, '#F2C14E');
      px(c, 1, h - 1, 14, 1, '#14151F');
      f.emit = [[3, 7, 10, 9, '#B07CFF']];
    },
    bistro(c) {
      px(c, 7, 9, 2, 8, '#3A3A44'); px(c, 4, 17, 8, 2, '#2A2A33');
      px(c, 3, 2, 10, 7, '#E8E2D6'); px(c, 2, 3, 12, 5, '#E8E2D6'); px(c, 3, 8, 10, 1, '#B9B2A4'); px(c, 3, 2, 10, 1, '#F8F4EC');
      mug(c, 5, 3, '#F3EFE6'); px(c, 10, 4, 2, 2, '#C98E55');
    },
    couch(c, f) {
      const col = f.color || '#5D4E8A', hi = shadeHex(col, 0.18), lo = shadeHex(col, -0.2);
      px(c, 0, 0, 64, 10, col); px(c, 0, 0, 64, 1, hi);
      for (const x of [16, 32, 48]) px(c, x, 1, 1, 8, lo);
      px(c, 4, 10, 56, 10, shadeHex(col, 0.1)); px(c, 4, 10, 56, 1, hi);
      for (const x of [18, 32, 46]) px(c, x, 11, 1, 8, col);
      px(c, 0, 4, 5, 20, lo); px(c, 59, 4, 5, 20, lo);
      px(c, 0, 4, 5, 1, col); px(c, 59, 4, 5, 1, col);
      px(c, 4, 20, 56, 4, lo); px(c, 0, 24, 64, 1, shadeHex(col, -0.5));
      px(c, 8, 4, 8, 6, '#F2C14E'); px(c, 48, 4, 8, 6, '#4FC1B9');
      px(c, 2, 25, 2, 1, '#2A1E18'); px(c, 60, 25, 2, 1, '#2A1E18');
    },
    coffeetable(c) {
      px(c, 1, 3, 30, 9, '#8A5A36'); px(c, 1, 3, 30, 1, '#A06B42'); px(c, 1, 12, 30, 3, '#5E3B22');
      px(c, 5, 5, 8, 5, '#5BA4E6'); px(c, 6, 6, 6, 1, '#ECE8F4'); mug(c, 20, 5, '#F3EFE6');
      px(c, 2, 15, 2, 3, '#3E2716'); px(c, 28, 15, 2, 3, '#3E2716');
    },
    babyfoot(c, f, w, h, R) {
      px(c, 0, R, 48, 26, '#7A5232'); px(c, 0, R, 48, 1, '#9A6E44');
      px(c, 3, R + 3, 42, 20, '#3E8E4E'); px(c, 3, R + 3, 42, 1, '#58B068');
      px(c, 23, R + 3, 1, 20, '#ECE8F4'); px(c, 20, R + 10, 7, 6, '#58B068'); px(c, 21, R + 11, 5, 4, '#3E8E4E');
      px(c, 3, R + 10, 2, 6, '#ECE8F4'); px(c, 43, R + 10, 2, 6, '#ECE8F4');
      for (let k = 0; k < 6; k++) {
        const x = 6 + k * 7;
        px(c, x, R - 1, 1, 28, '#C9CFDD');
        px(c, x - 1, R - 2, 3, 1, '#2A2B3A'); px(c, x - 1, R + 27, 3, 1, '#2A2B3A');
        const col = k % 2 ? '#E5534B' : '#5BA4E6';
        for (let p = 0; p < 2; p++) px(c, x - 1, R + 7 + p * 8, 3, 3, col);
      }
      px(c, 0, R + 26, 48, 4, '#5E3B22');
      px(c, 2, R + 30, 3, h - R - 30, '#3E2716'); px(c, 43, R + 30, 3, h - R - 30, '#3E2716');
    },
    reception(c, f, w, h, R) {
      px(c, 0, R - 2, 64, 8, '#E6E1F0'); px(c, 0, R - 2, 64, 1, '#FFFFFF');
      px(c, 0, R + 6, 64, 9, '#8A5A36'); px(c, 0, R + 6, 64, 1, '#6E4528'); px(c, 0, R + 9, 64, 2, '#C9A15C');
      px(c, 0, R + 15, 64, 1, '#3E2716');
      px(c, 24, R + 7, 16, 2, '#F2C14E');
      px(c, 6, 0, 14, 10, '#1B1C27'); px(c, 7, 1, 12, 7, '#2B4A7A'); px(c, 8, 2, 6, 1, '#9FD8F0'); px(c, 12, 10, 2, 2, '#2B2D3D');
      px(c, 30, R - 4, 5, 3, '#C9A15C'); px(c, 32, R - 5, 1, 1, '#F5DA8A');
      px(c, 44, R - 7, 6, 5, '#B0643C'); px(c, 43, R - 12, 8, 6, '#58B068'); px(c, 45, R - 14, 4, 2, '#7BC67E');
      px(c, 54, R - 3, 7, 4, '#ECE8DD'); px(c, 55, R - 2, 5, 1, '#9C9585');
      f.emit = [[7, 1, 12, 7, '#5BA4E6']];
    },
    sofa(c, f) { FURN.couch(c, { color: '#7A4A3A' }); },
    bench(c, f, w) {
      if (f.wood) {
        px(c, 0, 1, w, 3, '#A87650'); px(c, 0, 1, w, 1, '#C08A5E'); px(c, 0, 5, w, 3, '#9C6B45');
        px(c, 0, 9, w, 4, '#B5835A'); px(c, 0, 9, w, 1, '#C99A6E'); px(c, 0, 13, w, 2, '#7A5232');
        px(c, 2, 1, 2, 18, '#3A3A44'); px(c, w - 4, 1, 2, 18, '#3A3A44');
        return;
      }
      px(c, 0, 6, w, 7, '#4E5470'); px(c, 0, 6, w, 1, '#6E7590'); px(c, 0, 13, w, 2, '#2E3248');
      for (let x = 6; x < w; x += 12) px(c, x, 7, 1, 6, '#3A3F58');
      px(c, 2, 15, 2, 5, '#2A2B3A'); px(c, w - 4, 15, 2, 5, '#2A2B3A');
    },
    trophy(c, f, w, h) {
      px(c, 0, 0, 16, h - 1, '#5E3B22'); px(c, 0, 0, 16, 2, '#7A5232'); px(c, 15, 2, 1, h - 3, '#3E2716');
      px(c, 2, 2, 12, h - 6, '#2A3550'); px(c, 2, 2, 1, h - 6, '#4A5A80');
      for (const sy of [12, 22, 31]) px(c, 2, sy, 12, 1, '#7A5232');
      px(c, 5, 5, 6, 4, '#E2B04A'); px(c, 4, 5, 1, 2, '#E2B04A'); px(c, 11, 5, 1, 2, '#E2B04A'); px(c, 7, 9, 2, 2, '#C08A30'); px(c, 6, 11, 4, 1, '#C08A30');
      px(c, 4, 16, 3, 5, '#C9CFDD'); px(c, 9, 15, 3, 6, '#E2B04A'); px(c, 5, 26, 6, 4, '#C98E55'); px(c, 7, 24, 2, 2, '#E2B04A');
      px(c, 0, h - 4, 16, 3, '#3E2716');
    },
    kiosk(c, f, w, h) {
      px(c, 6, 12, 4, h - 15, '#5C6274'); px(c, 3, h - 3, 10, 2, '#3A3F52');
      px(c, 1, 0, 14, 13, '#2A2B3A'); px(c, 2, 1, 12, 10, '#12203A');
      f.emit = [[2, 1, 12, 10, '#5BA4E6']];
    },
    planter(c, f, w, h) {
      const r = rng(f.seed * 19 + 3);
      const fl = f.flowers === 1 ? ['#E0709B', '#F2C14E'] : f.flowers === 2 ? ['#B48EE0', '#ECE8F4'] : ['#F07C6C', '#F2C14E'];
      blob(c, r, 16, 6, 14, 5, 60, ['#3E8E4E', '#58B068', '#2F6E3C']);
      for (let k = 0; k < 12; k++) px(c, 3 + ((r() * 26) | 0), 2 + ((r() * 7) | 0), 2, 2, fl[k % 2]);
      px(c, 1, 10, 30, 3, '#A87650'); px(c, 1, 10, 30, 1, '#C08A5E');
      px(c, 2, 13, 28, h - 14, '#8A5A36'); for (let x = 7; x < 30; x += 6) px(c, x, 14, 1, h - 16, '#7A4E2E');
      px(c, 2, h - 1, 28, 1, '#4E321E');
    },
    parasol(c, f, w, h) {
      const cx = w >> 1;
      px(c, cx - 1, 8, 2, h - 12, '#C9CFDD');
      px(c, cx - 7, h - 12, 14, 6, '#E8E2D6'); px(c, cx - 6, h - 13, 12, 1, '#F8F4EC'); px(c, cx - 7, h - 6, 14, 1, '#B9B2A4');
      px(c, cx - 1, h - 6, 2, 5, '#3A3A44'); px(c, cx - 4, h - 1, 8, 1, '#2A2A33');
      mug(c, cx - 5, h - 11, '#F3EFE6'); mug(c, cx + 2, h - 11, '#E0709B');
      // Canopy (striped).
      for (let j = 0; j < 9; j++) {
        const half = 4 + j * 1.6;
        for (let i = -Math.round(half); i <= Math.round(half); i++) {
          const stripe = Math.floor((i + 40) / 4) % 2;
          px(c, cx + i, j, 1, 1, stripe ? '#F07C6C' : '#F8F4EC');
        }
      }
      px(c, cx - 18, 9, 36, 1, '#B85E50');
      px(c, cx - 1, 0, 2, 1, '#C9CFDD');
    },
    transat(c, f) {
      const col = f.color || '#E8955A';
      px(c, 2, 0, 12, 9, col); for (let x = 3; x < 14; x += 3) px(c, x, 0, 1, 9, '#F8F4EC');
      px(c, 2, 9, 12, 7, shadeHex(col, -0.08)); for (let x = 3; x < 14; x += 3) px(c, x, 9, 1, 7, '#ECE4D8');
      px(c, 1, 0, 1, 18, '#8A5A36'); px(c, 14, 0, 1, 18, '#8A5A36'); px(c, 1, 16, 14, 1, '#6E4528');
      px(c, 3, 17, 1, 3, '#6E4528'); px(c, 12, 17, 1, 3, '#6E4528');
    },
    telescope(c, f, w, h) {
      px(c, 7, h - 14, 2, 12, '#3A3A44'); px(c, 3, h - 3, 2, 3, '#3A3A44'); px(c, 11, h - 3, 2, 3, '#3A3A44');
      px(c, 4, h - 6, 1, 4, '#3A3A44'); px(c, 11, h - 6, 1, 4, '#3A3A44');
      for (let k = 0; k < 10; k++) px(c, 2 + k, h - 15 - Math.round(k * 0.9), 4, 3, k > 7 ? '#E6E1F0' : '#C9CFDD');
      px(c, 11, h - 25, 4, 3, '#2A2B3A');
      px(c, 6, h - 16, 4, 3, '#8A90A6');
    },
    rack(c, f, w, h) {
      const accent = f.row ? '#4FC1B9' : '#5BA4E6';
      px(c, 1, 2, 14, h - 3, '#1C202C'); px(c, 1, 2, 14, 1, '#3A4256');
      px(c, 1, 3, 1, h - 4, '#2B3142'); px(c, 14, 3, 1, h - 4, '#12151E');
      // Cable tray above the rack.
      px(c, 0, 0, 16, 2, '#4A5068'); px(c, 2, 0, 2, 1, '#E5534B'); px(c, 6, 0, 3, 1, '#F2C14E'); px(c, 11, 0, 2, 1, accent);
      f.leds = [];
      for (let y = 5; y + 4 < h - 2; y += 5) {
        px(c, 3, y, 10, 4, '#262B3A'); px(c, 3, y, 10, 1, '#323849');
        px(c, 4, y + 1, 5, 1, '#151821'); px(c, 4, y + 3, 5, 1, '#151821');
        f.leds.push([11, y + 1], [12, y + 2], [10, y + 3]);
      }
      px(c, 3, h - 6, 10, 3, accent); px(c, 4, h - 5, 8, 1, shadeHex(accent, -0.4));
      px(c, 1, h - 1, 14, 1, '#0B0D13');
      f.emit = [[10, 5, 3, h - 12, '#5CF08A']];
    },
    crac(c, f, w, h) {
      box(c, 0, 0, 32, h - 1, '#C9CFDD', '#9AA0B5', 4);
      px(c, 2, 6, 28, 2, '#7E8498');
      px(c, 6, 10, 20, 18, '#3A3F52'); px(c, 7, 11, 18, 16, '#1A1F2C');
      px(c, 3, 31, 10, 4, '#14151F'); px(c, 4, 32, 4, 1, '#5BE0FF'); px(c, 9, 32, 3, 1, '#6CC28A');
      for (let x = 16; x < 30; x += 3) px(c, x, 31, 2, 5, '#7E8498');
      f.emit = [[4, 32, 8, 1, '#5BE0FF']];
    },
    console(c, f, w, h, R) {
      px(c, 0, R + 1, 32, 9, '#4A5068'); px(c, 0, R + 1, 32, 1, '#5E6684'); px(c, 0, R + 10, 32, 5, '#323749'); px(c, 0, R + 15, 32, 1, '#1E2130');
      for (const sx of [2, 17]) { px(c, sx, 0, 13, 11, '#2E3346'); px(c, sx + 1, 1, 11, 8, '#06120A'); px(c, sx + 5, 11, 3, 2, '#2E3346'); }
      px(c, 6, R + 4, 20, 3, '#2A2E3E'); px(c, 27, R + 3, 3, 2, '#E5534B');
      f.emit = [[3, 1, 11, 8, '#5CF08A'], [18, 1, 11, 8, '#5CF08A']];
    },
    extinguisher(c) {
      px(c, 5, 3, 6, 15, '#D33A32'); px(c, 5, 3, 6, 1, '#F06058'); px(c, 10, 4, 1, 14, '#9A2620');
      px(c, 6, 1, 4, 2, '#2A2B3A'); px(c, 9, 0, 4, 1, '#2A2B3A'); px(c, 3, 6, 2, 8, '#2A2B3A');
      px(c, 6, 8, 4, 4, '#F3EFE6'); px(c, 5, 18, 6, 2, '#2A2B3A');
    },
    testbench(c, f, w, h, R) {
      box(c, 0, R - 1, 48, 17, '#B9C2CC', '#7E8A96', 9);
      px(c, 2, R + 12, 2, 4, '#5C6274'); px(c, 44, R + 12, 2, 4, '#5C6274');
      // Laptop (screen animated).
      px(c, 3, 0, 16, 11, '#2A2B3A'); px(c, 4, 1, 14, 8, '#0B1418'); px(c, 2, 11, 18, 3, '#9AA0B5'); px(c, 2, 11, 18, 1, '#C9CFDD');
      if (f.variant) {
        // Bug jar + multimeter.
        px(c, 26, 1, 8, 12, '#BFE6F0'); px(c, 26, 1, 8, 1, '#E6F8FB'); px(c, 25, 0, 10, 2, '#8A90A6');
        px(c, 29, 6, 3, 3, '#3A3A44'); px(c, 28, 7, 1, 1, '#3A3A44'); px(c, 32, 7, 1, 1, '#3A3A44');
        px(c, 38, 3, 8, 10, '#F2C14E'); px(c, 39, 4, 6, 3, '#1E2A22'); px(c, 41, 8, 2, 2, '#2A2B3A');
        px(c, 40, 13, 1, 3, '#E5534B'); px(c, 44, 13, 1, 3, '#2A2B3A');
      } else {
        // Oscilloscope (wave animated).
        px(c, 25, 0, 20, 13, '#4A5068'); px(c, 25, 0, 20, 1, '#6E7590'); px(c, 26, 1, 13, 10, '#06140C');
        px(c, 40, 3, 3, 2, '#C9CFDD'); px(c, 40, 7, 3, 2, '#C9CFDD');
      }
      f.emit = [[4, 1, 14, 8, '#6CF09A']];
    },
    conveyor(c, f, w, h, R) {
      px(c, 0, R - 2, 96, 4, '#5C6274'); px(c, 0, R - 2, 96, 1, '#8A90A6');
      px(c, 0, R + 2, 96, 8, '#26282F');
      px(c, 0, R + 10, 96, 4, '#4A5068'); px(c, 0, R + 13, 96, 1, '#2A2B3A');
      for (let x = 4; x < 96; x += 12) px(c, x, R + 14, 2, 2, '#2A2B3A');
      // Scanner arch over the middle of the belt.
      px(c, 40, 0, 3, R + 12, '#8A90A6'); px(c, 55, 0, 3, R + 12, '#8A90A6'); px(c, 40, 0, 18, 4, '#9AA0B5'); px(c, 40, 0, 18, 1, '#C9CFDD');
      px(c, 43, 4, 12, 1, '#3A3F52');
      px(c, 0, R - 1, 2, 12, '#F2C14E'); px(c, 94, R - 1, 2, 12, '#F2C14E');
    },
    toolcart(c, f, w, h) {
      box(c, 1, 2, 14, h - 6, '#D33A32', '#A82A24', 4);
      for (let k = 0; k < 3; k++) px(c, 3, 8 + k * 5, 10, 1, '#7A1E1A');
      px(c, 3, 0, 4, 2, '#9AA0B5'); px(c, 9, 0, 1, 3, '#C9CFDD');
      px(c, 2, h - 4, 3, 3, '#2A2B3A'); px(c, 11, h - 4, 3, 3, '#2A2B3A');
    },
    pigeonholes(c, f, w, h) {
      const r = rng(f.seed * 23 + 9);
      px(c, 0, 0, w, h, '#7A5232'); px(c, 0, 0, w, 2, '#9A6E44'); px(c, w - 1, 2, 1, h - 3, '#4E321F');
      const cols = (w / 8) | 0;
      for (let j = 0; j < 5; j++) for (let i = 0; i < cols; i++) {
        const x = 2 + i * 8, y = 3 + j * 6;
        px(c, x, y, 6, 5, '#2E1D12');
        const n = (r() * 3) | 0;
        for (let k = 0; k < n; k++) px(c, x + 1 + k, y + 1 + k, 4, 3 - k, k ? '#E8E2D6' : ['#F3EFE6', '#F2C14E', '#9FD8F0', '#F3EFE6'][(r() * 4) | 0]);
      }
      px(c, 0, h - 3, w, 3, '#4E321F');
    },
    receiver(c, f, w, h, R) {
      box(c, 2, R - 2, 28, 18, '#C9A15C', '#9A7640', 5);
      px(c, 12, 0, 8, R, '#9FD8F0'); px(c, 12, 0, 2, R, '#D6F2FB'); px(c, 11, R - 3, 10, 2, '#5C6274'); px(c, 11, 0, 10, 2, '#5C6274');
      px(c, 4, R + 5, 9, 6, '#6B4A2E'); px(c, 5, R + 4, 3, 2, '#E5534B'); px(c, 8, R + 4, 3, 2, '#5BA4E6');
      px(c, 22, R + 6, 6, 3, '#1E1F28'); px(c, 23, R + 7, 1, 1, '#6CC28A');
    },
    sortingtable(c, f, w, h, R) {
      px(c, 1, R + 1, 62, 25, '#A87650'); px(c, 1, R + 1, 62, 1, '#C08A5E');
      px(c, 1, R + 26, 62, 4, '#6E4528'); px(c, 3, R + 30, 3, 2, '#3E2716'); px(c, 58, R + 30, 3, 2, '#3E2716');
      const r = rng(f.seed * 29 + 1);
      for (let k = 0; k < 14; k++) {
        const x = 4 + ((r() * 50) | 0), y = R + 3 + ((r() * 18) | 0);
        px(c, x, y, 7, 5, r() < 0.7 ? '#F3EFE6' : '#E8D6A8'); px(c, x, y, 7, 1, '#C9C1AE'); px(c, x + 5, y + 1, 1, 1, '#E5534B');
      }
      px(c, 44, R + 14, 12, 8, '#C98E55'); px(c, 44, R + 14, 12, 2, '#E0A86E'); px(c, 49, R + 14, 2, 8, '#F2E2B8');
      px(c, 8, R + 18, 8, 5, '#5C6274'); px(c, 9, R + 17, 6, 1, '#9AA0B5'); px(c, 11, R + 19, 2, 1, '#6CC28A');
    },
    mailboxes(c, f, w, h) {
      px(c, 0, 0, w, h - 1, '#8A90A6'); px(c, 0, 0, w, 1, '#C5CAD8'); px(c, w - 1, 1, 1, h - 2, '#5C6274');
      let n = 1;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 8; i++) {
        const x = 1 + i * 8, y = 2 + j * 7;
        px(c, x, y, 7, 6, '#C9A15C'); px(c, x, y, 7, 1, '#E8C982'); px(c, x + 5, y + 3, 1, 1, '#3E2716');
        px(c, x + 1, y + 2, 2, 1, '#7A5A2A');
        n++;
      }
      px(c, 0, h - 2, w, 1, '#3A3F52');
    },
    laposte(c, f, w, h) {
      px(c, 7, 12, 2, h - 13, '#3A3F52'); px(c, 5, h - 2, 6, 2, '#2A2B3A');
      px(c, 1, 0, 14, 13, '#F2C14E'); px(c, 1, 0, 14, 2, '#F8DA78'); px(c, 14, 1, 1, 12, '#C99A2A');
      px(c, 4, 4, 8, 1, '#2A2B3A');
      px(c, 5, 7, 6, 3, '#2E4FA8'); px(c, 6, 8, 4, 1, '#F2C14E');
    },
    parcels(c, f, w, h) {
      box(c, 1, h - 16, 18, 15, '#D0A060', '#B07E40', 5); px(c, 9, h - 16, 2, 15, '#E8D6A8');
      box(c, 16, h - 12, 15, 11, '#C99050', '#A06E34', 4);
      box(c, 4, h - 28, 13, 12, '#D8AE70', '#B88A4C', 4); px(c, 9, h - 28, 2, 12, '#E8D6A8');
      px(c, 21, h - 9, 6, 3, '#F3EFE6'); px(c, 22, h - 8, 4, 1, '#E5534B');
    },
    holotable(c, f, w, h) {
      px(c, 2, h - 12, 28, 8, '#2B3550'); px(c, 2, h - 12, 28, 1, '#4FC1B9');
      px(c, 2, h - 4, 28, 3, '#1C2338'); px(c, 13, h - 14, 6, 2, '#4FC1B9');
      f.emit = [[13, h - 14, 6, 2, '#4FC1B9']];
    },
    webdesk(c, f, w, h, R) {
      const top = R - 1;
      px(c, 0, top, 32, 10, '#3A4A5A'); px(c, 0, top, 32, 1, '#5A6E80');
      px(c, 0, R + 9, 32, 6, '#24303C'); px(c, 0, R + 15, 32, 1, '#141A22');
      px(c, 1, 0, 26, 12, '#1B1C27'); px(c, 1, 0, 26, 1, '#3A3C50');
      px(c, 2, 1, 24, 10, '#0E1A28');
      px(c, 12, 12, 4, 2, '#2B2D3D'); px(c, 10, 14, 8, 1, '#2B2D3D');
      px(c, 4, R + 3, 14, 3, '#C9CFDD'); px(c, 21, R + 4, 2, 2, '#C9CFDD');
      if (f.variant) { px(c, 27, R - 1, 4, 5, '#3A3B4E'); px(c, 28, R, 2, 2, '#4FC1B9'); }
      else mug(c, 27, R, '#4FC1B9');
      f.emit = [[2, 1, 24, 10, '#9FF5EC']];
    },
    dish(c, f, w, h) {
      px(c, 13, h - 18, 6, 14, '#5C6274'); px(c, 8, h - 5, 16, 4, '#3A3F52'); px(c, 8, h - 5, 16, 1, '#5C6274');
      // Dish: an ellipse tilted toward the sky.
      for (let j = 0; j < 16; j++) {
        const half = Math.round(Math.sqrt(Math.max(0, 1 - Math.pow((j - 8) / 8.5, 2))) * 14);
        px(c, 16 - half + 2, 6 + j, half * 2 - 4, 1, j < 3 ? '#F0F2F7' : j < 10 ? '#D9DDE6' : '#B5BAC6');
      }
      px(c, 6, 13, 20, 1, '#9AA0B5');
      px(c, 15, 0, 2, 12, '#8A90A6'); px(c, 14, 0, 4, 2, '#5C6274');
      px(c, 5, 8, 11, 1, '#8A90A6'); px(c, 17, 8, 11, 1, '#8A90A6');
    },
    aquarium(c, f, w, h, R) {
      box(c, 0, R + 2, w, 14, '#6B4A2E', '#4A2F1C', 3);
      px(c, 4, R + 8, 18, 1, '#3A2416'); px(c, 26, R + 8, 18, 1, '#3A2416'); px(c, 12, R + 10, 2, 2, '#C9A15C'); px(c, 34, R + 10, 2, 2, '#C9A15C');
      px(c, 0, 0, w, R + 3, '#2A2B3A'); px(c, 0, 0, w, 1, '#C9CFDD');
      px(c, 1, 1, w - 2, 4, '#5BB8E6'); px(c, 1, 5, w - 2, 6, '#2E8FC8'); px(c, 1, 11, w - 2, R - 10, '#21709F');
      px(c, 1, R - 1, w - 2, 3, '#C9A15C');
      for (let x = 2; x < w - 2; x += 3) px(c, x, R - 1, 1, 1, '#E8C982');
      for (const sx of [5, 9, 38, 42]) for (let y = 4; y < R - 1; y++) px(c, sx + ((y >> 1) & 1), y, 1, 1, y % 3 ? '#3E8E4E' : '#58B068');
      px(c, 20, R - 7, 8, 6, '#8A90A6'); px(c, 20, R - 9, 2, 2, '#8A90A6'); px(c, 26, R - 9, 2, 2, '#8A90A6'); px(c, 23, R - 4, 2, 3, '#2A2B3A');
      px(c, 1, 1, 1, R + 1, 'rgba(255,255,255,0.25)');
      f.emit = [[1, 1, w - 2, R + 1, '#5BE0FF']];
    },
    router(c, f, w, h) {
      box(c, 1, 0, 14, h - 1, '#3A3F52', '#262B3A', 3);
      for (let k = 0; k < 4; k++) { px(c, 3, 6 + k * 6, 10, 4, '#1A1F2C'); px(c, 3, 6 + k * 6, 10, 1, '#4A5068'); }
      px(c, 4, -0, 1, 1, '#8A90A6');
      f.emit = [[3, 6, 10, 22, '#5CF08A']];
    }
  };

  // ------------------------------------------------------------------ ambient animation (per frame)
  const CODE_COLORS = ['#C9D3F5', '#9BE3C8', '#F2C14E', '#E0709B', '#8FB8FF'];

  /** Cached shades of a desk owner's colour + its nameplate canvas (rebuilt when name/colour change). */
  function deskPlate(d) {
    const name = d.name ? String(d.name) : '';
    const color = d.color || '#9BE3C8';
    const k = name + '|' + color;
    if (d.plateKey === k) return d.plate;
    d.plateKey = k;
    d.shadeLite = shadeHex(color, 0.45);
    d.shadeDark = shadeHex(color, -0.45);
    if (!name) { d.plate = null; return null; }
    const text = fitPixelText(name, 24);
    const w = measurePixelText(text) + 4, h = 7;
    const cv = makeCanvas(w, h);
    if (!cv) { d.plate = null; return null; }
    const c = cv.getContext('2d');
    px(c, 0, 0, w, h, '#151622'); px(c, 0, 0, w, 1, color); px(c, 0, h - 1, w, 1, '#0B0C14');
    drawPixelText(c, text, 2, 1, d.shadeLite, 1);
    d.plate = cv;
    return cv;
  }

  const ANIM = {
    shelf(ctx, it, t, office, reduced) { office._drawLibraryBooks(ctx, it, t, reduced); },
    desk(ctx, it, t, office) {
      const d = office.desks[it.f.desk];
      if (!d) return;
      const sx = it.x + 3, sy = it.y + 1;
      const R = it.f.rise;
      const mode = t - d.modeAt < 0.35 ? d.mode : 'off';
      const plate = d.owner !== null ? deskPlate(d) : null;
      if (mode === 'type') {
        px(ctx, sx, sy, 14, 10, '#0B1222');
        const tick = Math.floor(t * 7);
        for (let i = 0; i < 5; i++) {
          const line = tick + i;
          const indent = ((hash(it.f.desk, line, 5) * 4) | 0);
          const len = 2 + ((hash(it.f.desk, line, 3) * 9) | 0);
          const hc = hash(it.f.desk, line, 4);
          const col = hc < 0.38 ? (d.color || '#9BE3C8') : hc < 0.6 ? d.shadeLite || '#C9D3F5' : CODE_COLORS[(hc * 10 | 0) % CODE_COLORS.length];
          px(ctx, sx + 1 + indent, sy + 1 + i * 2, Math.min(len, 12 - indent), 1, col);
        }
        if (Math.floor(t * 3) % 2) px(ctx, sx + 11, sy + 8, 2, 1, '#FFFFFF');
      } else if (mode === 'think') {
        px(ctx, sx, sy, 14, 10, '#141C36');
        const ph = Math.floor(t * 3) % 4;
        for (let k = 0; k < 3; k++) px(ctx, sx + 3 + k * 3, sy + 5, 2, 2, k < ph ? (d.shadeLite || '#C9D3F5') : '#2C3760');
      } else if (d.owner !== null && d.color) {
        // Owner away: lock screen with a tiny Clawd in the owner's colour.
        px(ctx, sx, sy, 14, 10, '#0E1220');
        px(ctx, sx + 4, sy + 3, 6, 3, d.shadeDark || '#3A4060'); px(ctx, sx + 5, sy + 4, 1, 1, '#0E1220'); px(ctx, sx + 8, sy + 4, 1, 1, '#0E1220');
        px(ctx, sx + 4, sy + 6, 1, 1, d.shadeDark || '#3A4060'); px(ctx, sx + 9, sy + 6, 1, 1, d.shadeDark || '#3A4060');
      } else {
        px(ctx, it.x + 16, it.y + 10, 1, 1, Math.floor(t * 0.8 + it.f.desk) % 2 ? '#F2A35A' : '#5A3A20');
      }
      if (d.papers > 0) {
        const n = Math.min(6, d.papers);
        for (let k = 0; k < n; k++) px(ctx, it.x + 20 + (k & 1), it.y + R + 6 - k, 7, 1, k % 2 ? '#D9D3C6' : '#F3EFE6');
        px(ctx, it.x + 21 + (n & 1), it.y + R + 6 - n, 5, 1, '#F8F6F0');
        px(ctx, it.x + 22 + (n & 1), it.y + R + 7 - n, 3, 1, '#B9B3A6');
      }
      if (plate) ctx.drawImage(plate, it.x + 16 - (plate.width >> 1), it.y + R + 9);
    },
    rack(ctx, it, t, office) {
      const leds = it.f.leds || [];
      const storm = t - office.amb.servers.burst < 1.2;
      const colors = ['#5CF08A', '#5BA4E6', '#F2C14E'];
      for (let k = 0; k < leds.length; k++) {
        const rate = storm ? 14 : 1.5 + hash(it.f.seed, k, 9) * 5;
        const on = hash(it.f.seed, k, Math.floor(t * rate)) > 0.3;
        px(ctx, it.x + leds[k][0], it.y + leds[k][1], 1, 1, on ? colors[k % 3] : '#1E2A2A');
      }
    },
    crac(ctx, it, t, office, reduced) {
      const cx = it.x + 16, cy = it.y + 19;
      const a = reduced ? 0 : t * 9;
      for (let b = 0; b < 4; b++) {
        const ang = a + b * Math.PI / 2;
        for (let s = 1; s < 8; s++) px(ctx, Math.round(cx + Math.cos(ang) * s), Math.round(cy + Math.sin(ang) * s * 0.85), 1, 1, s < 3 ? '#8A90A6' : '#5C6274');
      }
      px(ctx, cx - 1, cy - 1, 2, 2, '#C9CFDD');
    },
    console(ctx, it, t) {
      const tick = Math.floor(t * 4);
      for (const ox of [3, 18]) {
        for (let i = 0; i < 4; i++) px(ctx, it.x + ox + 1, it.y + 2 + i * 2, 1 + ((hash(i + tick, ox, 5) * 8) | 0), 1, '#5CF08A');
        if (Math.floor(t * 2) % 2) px(ctx, it.x + ox + 8, it.y + 8, 2, 1, '#B6FFC8');
      }
    },
    testbench(ctx, it, t, office) {
      const res = office.amb.tests.results;
      const last = res.length ? res[res.length - 1] : true;
      const sx = it.x + 4, sy = it.y + 1;
      const tick = Math.floor(t * 5);
      for (let i = 0; i < 4; i++) {
        const okLine = i < 3 || last;
        px(ctx, sx + 1, sy + 1 + i * 2, 2, 1, okLine ? '#6CF09A' : '#FF5A4E');
        px(ctx, sx + 4, sy + 1 + i * 2, 2 + ((hash(i, tick, 7) * 7) | 0), 1, '#9FB8C0');
      }
      if (!it.f.variant) {
        for (let x = 0; x < 13; x++) {
          const yy = Math.round(5 + Math.sin(x * 0.9 + t * 6) * 3);
          px(ctx, it.x + 26 + x, it.y + 1 + yy, 1, 1, '#6CF09A');
        }
      } else if (Math.floor(t * 1.3) % 3 === 0) {
        px(ctx, it.x + 30, it.y + 6, 1, 1, '#3A3A44');
      }
    },
    conveyor(ctx, it, t, office, reduced) {
      const R = it.f.rise;
      const speed = reduced ? 6 : 14;
      const off = Math.floor(t * speed) % 6;
      for (let x = -off; x < 96; x += 6) if (x >= 0) px(ctx, it.x + x, it.y + R + 3, 2, 6, '#33363F');
      const res = office.amb.tests.results;
      const last = res.length ? res[res.length - 1] : true;
      for (let k = 0; k < 3; k++) {
        const p = ((t * speed * 0.5 + k * 32) % 108) - 10;
        if (p < -8 || p > 94) continue;
        const bx = it.x + Math.round(p), by = it.y + R - 3;
        const passed = p > 50;
        px(ctx, bx, by, 8, 7, '#C99050'); px(ctx, bx, by, 8, 2, '#E0A86E'); px(ctx, bx + 3, by, 2, 7, '#E8D6A8');
        if (passed) px(ctx, bx + 6, by - 2, 2, 2, last ? '#6CF09A' : '#FF5A4E');
      }
      const flash = t - office.amb.tests.flashAt < 1.2;
      const col = last ? '#6CF09A' : '#FF5A4E';
      px(ctx, it.x + 44, it.y + 4, 10, 1, flash && Math.floor(t * 10) % 2 ? '#FFFFFF' : col);
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * 0.22;
      px(ctx, it.x + 43, it.y + 5, 12, R + 6, col);
      ctx.globalAlpha = a;
    },
    receiver(ctx, it, t, office) {
      const T0 = office.amb.tube;
      const dt = t - T0.arriveAt;
      if (dt >= 0 && dt < 0.6) {
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * (1 - dt / 0.6);
        px(ctx, it.x + 10, it.y + 2, 12, it.f.rise - 2, '#FFFFFF');
        for (let k = 0; k < 4; k++) px(ctx, it.x + 6 + k * 6, it.y - 2 - Math.round(dt * 14) - (k % 2) * 2, 2, 1, '#D6F2FB');
        ctx.globalAlpha = a;
      }
    },
    holotable(ctx, it, t) {
      const h = it.img.height;
      const cx = it.x + 16, cy = it.y + h - 22;
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * 0.16;
      px(ctx, it.x + 10, cy - 7, 12, h - 14 - (cy - 7 - it.y), '#4FC1B9');
      ctx.globalAlpha = a * 0.85;
      for (let m = 0; m < 4; m++) {
        const ang = t * 1.2 + m * Math.PI / 4;
        const dx = Math.cos(ang);
        for (let k = -3; k <= 3; k++) {
          const yy = cy + k * 2;
          const rr = Math.sqrt(Math.max(0, 49 - (k * 2) * (k * 2)));
          px(ctx, Math.round(cx + dx * rr) - 1, yy, 1, 1, '#9FF5EC');
        }
      }
      px(ctx, cx - 7, cy, 14, 1, '#4FC1B9');
      ctx.globalAlpha = a;
    },
    webdesk(ctx, it, t) {
      const sx = it.x + 2, sy = it.y + 1;
      px(ctx, sx, sy, 24, 2, '#24364A');
      px(ctx, sx + 1, sy, 5, 1, '#4FC1B9'); px(ctx, sx + 7, sy, 5, 1, '#2E4A64');
      const tick = Math.floor(t * 2 + it.f.seed);
      for (let i = 0; i < 4; i++) {
        const hc = hash(it.f.seed, tick + i, 8);
        px(ctx, sx + 2, sy + 3 + i * 2, 4 + ((hc * 16) | 0), 1, i === 0 ? '#9FF5EC' : '#5E7E96');
      }
      const lp = (t * 0.7 + it.f.seed * 0.1) % 1;
      px(ctx, sx, sy + 9, Math.round(24 * lp), 1, '#4FC1B9');
    },
    dish(ctx, it, t, office, reduced) {
      px(ctx, it.x + 15, it.y, 2, 2, Math.floor(t * 1.5) % 2 === 0 ? '#FF5A4E' : '#6E2A26');
      if (reduced) return;
      const burst = t - office.amb.web.burst < 2;
      const p = (t * (burst ? 1.6 : 0.7)) % 1;
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * (1 - p) * 0.8;
      const r = 3 + Math.round(p * 9);
      px(ctx, it.x + 16 - r, it.y - r + 2, 1, 2, '#4FC1B9'); px(ctx, it.x + 16 + r, it.y - r + 2, 1, 2, '#4FC1B9');
      px(ctx, it.x + 15, it.y - r - 1, 2, 1, '#4FC1B9');
      ctx.globalAlpha = a;
    },
    aquarium(ctx, it, t, office, reduced) {
      const R = it.f.rise;
      const sp = reduced ? 0.35 : 1;
      const cols = ['#F2A35A', '#F2C14E', '#E0709B', '#9FF5EC'];
      for (let k = 0; k < 4; k++) {
        const span = 38;
        const ph = (t * (4 + k * 1.7) * sp + k * 13) % (span * 2);
        const dir = ph < span ? 1 : -1;
        const fx = Math.round(it.x + 4 + (dir > 0 ? ph : span * 2 - ph));
        const fy = it.y + 3 + k * 3 + Math.round(Math.sin(t * 2 + k));
        px(ctx, fx, fy, 3, 2, cols[k]);
        px(ctx, dir > 0 ? fx - 1 : fx + 3, fy, 1, 2, shadeHex(cols[k], -0.3));
        px(ctx, dir > 0 ? fx + 2 : fx, fy, 1, 1, '#14151F');
      }
      if (!reduced) for (let k = 0; k < 3; k++) {
        const p = (t * 0.6 + k / 3) % 1;
        px(ctx, it.x + 33 + k, Math.round(it.y + R - 3 - p * (R - 4)), 1, 1, '#D6F2FB');
      }
    },
    router(ctx, it, t) {
      for (let k = 0; k < 4; k++) for (let j = 0; j < 4; j++) {
        const on = hash(k, j, Math.floor(t * (3 + j))) > 0.4;
        px(ctx, it.x + 4 + j * 2, it.y + 8 + k * 6, 1, 1, on ? (j === 3 ? '#F2C14E' : '#5CF08A') : '#1E2A2A');
      }
    },
    meettable(ctx, it, t, office, reduced) {
      if (office.amb.meeting.occ <= 0) return;
      const R = it.f.rise;
      const lx = it.x + 115, ly = it.y + R + 20;
      const sc = office._projscreen;
      if (!sc) return;
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * (reduced ? 0.1 : 0.08 + 0.02 * Math.sin(t * 7));
      ctx.fillStyle = '#E8F0FF';
      ctx.beginPath();
      ctx.moveTo(lx, ly); ctx.lineTo(sc.x, sc.y + sc.h); ctx.lineTo(sc.x + sc.w, sc.y + sc.h); ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = a;
      px(ctx, lx - 1, ly - 1, 2, 2, '#FFFFFF');
    },
    counter(ctx, it, t, office, reduced) {
      px(ctx, it.x + 12, it.y + 7, 2, 1, Math.floor(t * 1.2) % 2 ? '#5CF08A' : '#1E3A2A');
      const C = office.amb.coffee;
      const strong = C.busy || t - C.boost < 4;
      const n = reduced ? 2 : strong ? 9 : 3;
      const R = it.f.rise;
      const a = ctx.globalAlpha;
      for (let k = 0; k < n; k++) {
        const p = (t * (strong ? 0.8 : 0.45) + k / n) % 1;
        ctx.globalAlpha = a * (1 - p) * (strong ? 0.75 : 0.45);
        const sxx = it.x + (k % 2 ? 16 : 8) + Math.round(Math.sin(p * 7 + k) * 2);
        px(ctx, sxx, Math.round(it.y + R - 2 - p * (strong ? 18 : 12)), strong && p < 0.5 ? 2 : 1, 2, '#F3F1FA');
      }
      ctx.globalAlpha = a;
    },
    arcade(ctx, it, t, office) {
      const sx = it.x + 3, sy = it.y + 7;
      const busy = office.amb.arcade.busy;
      const sp = busy ? 3 : 1.2;
      px(ctx, sx, sy, 10, 9, '#0A0E1A');
      const tick = Math.floor(t * sp * 2);
      if (it.f.hue) {
        // Little falling-blocks game.
        for (let k = 0; k < 4; k++) {
          const col = ['#E5534B', '#F2C14E', '#5BA4E6', '#7BC67E'][k];
          px(ctx, sx + 1 + ((k * 3 + tick) % 8), sy + 1 + ((tick + k * 2) % 7), 2, 1, col);
        }
        px(ctx, sx, sy + 8, 10, 1, '#4FC1B9');
      } else {
        // Invaders marching over a cannon.
        const ox = Math.floor(Math.sin(t * sp) * 2);
        for (let k = 0; k < 3; k++) px(ctx, sx + 2 + k * 3 + ox, sy + 2, 2, 1, '#9FF5EC');
        for (let k = 0; k < 2; k++) px(ctx, sx + 3 + k * 3 + ox, sy + 4, 2, 1, '#E0709B');
        px(ctx, sx + 4 + Math.round(Math.sin(t * 2) * 3), sy + 7, 2, 1, '#F2C14E');
        if (tick % 3 === 0) px(ctx, sx + 5, sy + 5, 1, 1, '#FFFFFF');
      }
    },
    vending(ctx, it, t) {
      if (Math.floor(t * 0.5 + it.f.seed) % 7 === 0) px(ctx, it.x + 2, it.y + 2, 9, 1, '#9FD8F0');
    },
    kiosk(ctx, it, t) {
      const slide = Math.floor(t / 3) % 3;
      const sx = it.x + 2, sy = it.y + 1;
      const cols = ['#F2C14E', '#4FC1B9', '#E0709B'];
      px(ctx, sx + 1, sy + 1, 10, 2, cols[slide]);
      px(ctx, sx + 1, sy + 4, 7, 1, '#9FD8F0'); px(ctx, sx + 1, sy + 6, 9, 1, '#5E7E96'); px(ctx, sx + 1, sy + 8, 5, 1, '#5E7E96');
    },
    floorlamp(ctx, it, t, office) {
      if (office.tod && office.tod.lamp > 0.3) { px(ctx, it.x + 4, it.y + 7, 8, 2, '#FFF6C8'); px(ctx, it.x + 6, it.y + 8, 4, 1, '#FFFFFF'); }
    },
    readtable(ctx, it, t, office) {
      if (office.tod && office.tod.lamp > 0.3) px(ctx, it.x + 13, it.y + it.f.rise + 9, 10, 1, '#FFF6C8');
    },
    statue(ctx, it, t, office, reduced) {
      if (reduced) return;
      const ph = (t * 0.6 + 0.3) % 3;
      if (ph < 0.25) px(ctx, it.x + 3 + Math.floor(ph * 30) % 10, it.y + 2, 1, 1, '#FFFFFF');
    },
    trophy(ctx, it, t, office, reduced) {
      if (reduced) return;
      const ph = (t * 0.7) % 2.5;
      if (ph < 0.2) { px(ctx, it.x + 6, it.y + 5, 1, 1, '#FFFFFF'); px(ctx, it.x + 10, it.y + 16, 1, 1, '#FFFFFF'); }
    },
    parasol(ctx, it, t, office) {
      if (office.tod && office.tod.lamp > 0.3) {
        const cx = it.x + (it.img.width >> 1);
        px(ctx, cx - 1, it.y + 10, 2, 3, '#FFE6A0');
        px(ctx, cx, it.y + 11, 1, 1, '#FFFFFF');
      }
    },
    printer(ctx, it, t) {
      const p = (t * 0.25 + it.f.seed * 0.13) % 3;
      if (p < 0.6) px(ctx, it.x + 4, it.y + it.f.rise + 4 + Math.round(p * 5), 8, 2, '#FFFFFF');
    },
    cooler(ctx, it, t, office, reduced) {
      if (reduced) return;
      const p = (t * 0.5 + 0.2) % 4;
      if (p < 1) px(ctx, it.x + 6 + Math.round(p * 2) % 2, it.y + 7 - Math.round(p * 5), 1, 1, '#E6F4FF');
    }
  };

  // ------------------------------------------------------------------ sky, skyline, railing (terrace)
  const SKY_X = 39 * T;
  const SKY_H = 4 * T;

  /** Pre-renders the terrace railing (glass panels, posts, handrail, wooden sign) once. */
  Office.prototype._buildRailing = function () {
    const w = WIDTH - SKY_X, h = 16;
    const cv = makeCanvas(w + 2, h + 7 * T);
    if (!cv) return;
    const c = cv.getContext('2d');
    // Top railing along the terrace edge (y 0..15 of this canvas = world y 52..67).
    c.fillStyle = 'rgba(159,216,240,0.28)'; c.fillRect(0, 3, w - 16, 10);
    px(c, 0, 2, w - 15, 2, '#A87650'); px(c, 0, 2, w - 15, 1, '#C99A6E');
    px(c, 0, 13, w - 15, 2, '#5C6274');
    for (let x = 0; x < w - 14; x += 24) { px(c, x, 2, 2, 13, '#8A90A6'); px(c, x, 2, 1, 13, '#C9CFDD'); }
    // Right railing (vertical, along x = 63).
    c.fillStyle = 'rgba(159,216,240,0.28)'; c.fillRect(w - 15, 4, 4, h + 7 * T - 6);
    px(c, w - 16, 2, 2, h + 7 * T - 2, '#A87650'); px(c, w - 12, 2, 2, h + 7 * T - 2, '#5C6274');
    for (let y = 2; y < h + 7 * T; y += 24) px(c, w - 16, y, 6, 2, '#8A90A6');
    // Wooden "TERRASSE" sign hanging on the railing.
    const label = 'TERRASSE';
    const tw = measurePixelText(label);
    const sw = tw + 8, sx = Math.round(52 * T - (SKY_X - 1) - sw / 2);
    px(c, sx, 3, sw, 10, '#6B4A2E'); px(c, sx + 1, 4, sw - 2, 8, '#8A5E3A'); px(c, sx + 1, 4, sw - 2, 1, '#C9D86B');
    drawPixelText(c, label, sx + 4, 6, '#F5ECD7', 1);
    this._railing = cv;
    // Skyline: a far and a near row of buildings with window slots (lit at night).
    const B = [];
    const r = rng(4242);
    for (let x = 0; x < w; ) {
      const bw = 10 + ((r() * 18) | 0), bh = 10 + ((r() * 26) | 0);
      B.push({ x, w: bw, h: bh, far: true });
      x += bw + ((r() * 4) | 0);
    }
    for (let x = 4; x < w; ) {
      const bw = 8 + ((r() * 14) | 0), bh = 6 + ((r() * 16) | 0);
      B.push({ x, w: bw, h: bh, far: false, spire: r() < 0.15 });
      x += bw + 6 + ((r() * 18) | 0);
    }
    const wins = [];
    for (const b of B) {
      for (let yy = 3; yy < b.h - 2; yy += 4) for (let xx = 2; xx < b.w - 2; xx += 3) {
        if (r() < 0.35) wins.push({ x: b.x + xx, y: SKY_H - 2 - b.h + yy, warm: r() < 0.75, far: b.far, ph: r() * 10 });
      }
    }
    this._skyB = B;
    this._skyWins = wins;
  };

  Office.prototype._drawSky = function (ctx, t, reduced) {
    const tod = this.tod;
    const w = WIDTH - SKY_X;
    const bh = SKY_H / 7;
    for (let j = 0; j < 7; j++) px(ctx, SKY_X, Math.floor(j * bh), w, Math.ceil(bh) + 1, tod.bands[j]);
    px(ctx, 63 * T, SKY_H, 16, 7 * T, tod.bands[6]);
    ctx.save();
    ctx.beginPath();
    ctx.rect(SKY_X, 0, w, SKY_H);
    ctx.clip();
    const a0 = ctx.globalAlpha;
    // Stars.
    if (tod.stars > 0.04) {
      for (let k = 0; k < 46; k++) {
        const tw = reduced ? 1 : 0.55 + 0.45 * Math.sin(t * (1 + hash(k, 3, 93) * 2) + k);
        ctx.globalAlpha = a0 * tod.stars * tw;
        px(ctx, SKY_X + ((hash(k, 1, 91) * w) | 0), ((hash(k, 2, 92) * (SKY_H - 20)) | 0), 1, 1, k % 9 ? '#FFFFFF' : '#FFE6A0');
      }
      ctx.globalAlpha = a0;
    }
    // Sun or moon on its arc.
    const bx = Math.round(SKY_X + 14 + tod.bodyFrac * (w - 36));
    const by = Math.round(40 - Math.sin(tod.bodyFrac * Math.PI) * 30);
    if (tod.body === 'sun') {
      ctx.globalAlpha = a0 * 0.25; px(ctx, bx - 7, by - 5, 14, 10, tod.sunColor); px(ctx, bx - 5, by - 7, 10, 14, tod.sunColor);
      ctx.globalAlpha = a0;
      px(ctx, bx - 4, by - 3, 8, 6, '#FFF6CC'); px(ctx, bx - 3, by - 4, 6, 8, '#FFF6CC'); px(ctx, bx - 2, by - 3, 3, 2, '#FFFFFF');
    } else {
      ctx.globalAlpha = a0 * 0.18; px(ctx, bx - 6, by - 6, 12, 12, '#DDE6FF'); ctx.globalAlpha = a0;
      px(ctx, bx - 3, by - 4, 7, 8, '#F3EFD8'); px(ctx, bx - 4, by - 3, 9, 6, '#F3EFD8');
      px(ctx, bx, by - 4, 5, 6, tod.bands[1]); px(ctx, bx + 1, by - 3, 4, 6, tod.bands[1]);
      px(ctx, bx - 2, by + 1, 1, 1, '#D8D2B8');
    }
    // Drifting clouds.
    const nC = reduced ? 2 : 4;
    for (let k = 0; k < nC; k++) {
      const span = w + 70;
      const cx = SKY_X - 35 + ((t * (1.6 + k * 0.7) + k * 131) % span);
      const cy = 8 + k * 11 + ((k * 7) % 5);
      const cw = 16 + ((k * 9) % 14);
      ctx.globalAlpha = a0 * (0.85 - tod.night * 0.45);
      px(ctx, Math.round(cx), cy, cw, 4, tod.cloud); px(ctx, Math.round(cx) + 4, cy - 3, cw - 9, 3, tod.cloud);
      px(ctx, Math.round(cx) + 2, cy + 3, cw - 3, 2, tod.cloudShade);
    }
    ctx.globalAlpha = a0;
    // Birds during the day.
    if (!reduced && tod.sun > 0.5) {
      for (let k = 0; k < 2; k++) {
        const bxx = SKY_X + ((t * 9 + k * 211) % (w + 40)) - 20, byy = 14 + k * 9 + Math.round(Math.sin(t * 2 + k) * 2);
        const flap = Math.floor(t * 6 + k) % 2;
        px(ctx, Math.round(bxx), byy + flap, 2, 1, '#2A2B3A'); px(ctx, Math.round(bxx) + 2, byy + 1 - flap, 1, 1, '#2A2B3A'); px(ctx, Math.round(bxx) + 3, byy + flap, 2, 1, '#2A2B3A');
      }
    }
    // Skyline silhouettes, windows lit at night.
    const B = this._skyB || [];
    for (let i = 0; i < B.length; i++) {
      const b = B[i];
      px(ctx, SKY_X + b.x, SKY_H - 2 - b.h, b.w, b.h + 2, b.far ? tod.skylineFar : tod.skyline);
      if (b.spire) px(ctx, SKY_X + b.x + (b.w >> 1), SKY_H - 8 - b.h, 1, 6, tod.skyline);
    }
    if (tod.lamp > 0.15) {
      const W2 = this._skyWins || [];
      for (let i = 0; i < W2.length; i++) {
        const wn = W2[i];
        const flick = reduced ? 1 : (Math.sin(t * 0.2 + wn.ph) > -0.85 ? 1 : 0);
        if (!flick) continue;
        ctx.globalAlpha = a0 * tod.lamp * (wn.far ? 0.55 : 0.9);
        px(ctx, SKY_X + wn.x, wn.y, 1, 1, wn.warm ? '#FFD98A' : '#9FD8F0');
      }
      ctx.globalAlpha = a0;
    }
    ctx.restore();
    if (this._railing) ctx.drawImage(this._railing, SKY_X - 1, SKY_H - 12);
    // String-light bulbs on the railing wire.
    const on = tod.lamp > 0.25;
    for (let x = SKY_X + 8, k = 0; x < WIDTH - 16; x += 16, k++) {
      const sag = (k % 2) ? 1 : 0;
      px(ctx, x, SKY_H - 9 + sag, 1, 1, '#3A3A44');
      const col = ['#FFC46A', '#F07C6C', '#9FF5EC', '#C9D86B'][k % 4];
      px(ctx, x, SKY_H - 8 + sag, 2, 2, on ? col : shadeHex(col, -0.45));
      if (on && !reduced && hash(k, Math.floor(t * 2), 94) < 0.05) px(ctx, x, SKY_H - 8 + sag, 2, 2, '#FFFFFF');
    }
  };

  // ------------------------------------------------------------------ whiteboard scribbles
  function makeStrokes(seed, w, h) {
    const r = rng(seed * 977 + 13);
    const pts = [];
    const ink = ['#2F5FB8', '#2A2B3A', '#C0392B', '#2E8B57'];
    const run = (x, y, len, col) => { for (let i = 0; i < len; i++) pts.push(x + i, y, col); };
    // Title.
    run(2, 1, 14 + ((r() * 16) | 0), ink[0]);
    // Text-ish lines with word gaps.
    for (let line = 0; line < 3; line++) {
      let x = 2;
      const y = 4 + line * 2 + (line > 1 ? 1 : 0);
      const end = 22 + ((r() * 14) | 0);
      while (x < end) { const wl = 2 + ((r() * 5) | 0); run(x, y, Math.min(wl, end - x), ink[1]); x += wl + 1; }
    }
    // Box diagram with an arrow.
    const bx = 42 + ((r() * 6) | 0), by = 1;
    const box2 = (x0, y0, bw, bh, col) => {
      run(x0, y0, bw, col); for (let j = 1; j < bh - 1; j++) { pts.push(x0, y0 + j, col); pts.push(x0 + bw - 1, y0 + j, col); } run(x0, y0 + bh - 1, bw, col);
    };
    box2(bx, by, 9, 5, ink[2]);
    run(bx + 9, by + 2, 6, ink[2]); pts.push(bx + 14, by + 1, ink[2]); pts.push(bx + 14, by + 3, ink[2]);
    box2(bx + 15, by, 9, 5, ink[3]);
    // Tiny bar chart.
    for (let k = 0; k < 5; k++) {
      const bhh = 1 + ((r() * 4) | 0);
      for (let j = 0; j < bhh; j++) { pts.push(bx + 2 + k * 3, h - 2 - j, ink[3]); pts.push(bx + 3 + k * 3, h - 2 - j, ink[3]); }
    }
    // Clip to the board.
    const out = [];
    for (let i = 0; i < pts.length; i += 3) if (pts[i] >= 0 && pts[i] < w && pts[i + 1] >= 0 && pts[i + 1] < h) out.push(pts[i], pts[i + 1], pts[i + 2]);
    return out;
  }

  Office.prototype._drawWhiteboard = function (ctx) {
    const wb = this._whiteboard;
    if (!wb) return;
    const M = this.amb.meeting;
    if (!M.canvas) { M.canvas = makeCanvas(wb.w, wb.h); M.drawn = 0; }
    if (!M.canvas) return;
    const c = M.canvas.getContext('2d');
    if (!M.strokes) { M.strokes = makeStrokes(M.seed, wb.w, wb.h); c.clearRect(0, 0, wb.w, wb.h); M.drawn = 0; }
    const total = M.strokes.length / 3;
    const target = Math.floor(M.prog * total);
    while (M.drawn < target) {
      const i = M.drawn * 3;
      px(c, M.strokes[i], M.strokes[i + 1], 1, 1, M.strokes[i + 2]);
      M.drawn++;
    }
    if (M.drawn > 0) ctx.drawImage(M.canvas, wb.x, wb.y);
  };

  Office.prototype._drawProjector = function (ctx, t) {
    const sc = this._projscreen;
    if (!sc || this.amb.meeting.occ <= 0) return;
    const slide = Math.floor(t / 4) % 3;
    px(ctx, sc.x, sc.y, sc.w, sc.h, '#F4F6FB');
    px(ctx, sc.x, sc.y, sc.w, 2, ['#B48EE0', '#5BA4E6', '#D97757'][slide]);
    if (slide === 0) {
      for (let k = 0; k < 6; k++) px(ctx, sc.x + 4 + k * 8, sc.y + sc.h - 1 - (2 + ((k * 5) % 7)), 5, 2 + ((k * 5) % 7), k % 2 ? '#5BA4E6' : '#B48EE0');
    } else if (slide === 1) {
      for (let k = 0; k < 3; k++) { px(ctx, sc.x + 3, sc.y + 4 + k * 2, 2, 1, '#D97757'); px(ctx, sc.x + 7, sc.y + 4 + k * 2, 18 + k * 7, 1, '#6A6F86'); }
    } else {
      px(ctx, sc.x + 6, sc.y + 4, 9, 5, '#7BC67E'); px(ctx, sc.x + 15, sc.y + 6, 10, 1, '#6A6F86'); px(ctx, sc.x + 25, sc.y + 4, 9, 5, '#F2C14E');
      px(ctx, sc.x + 34, sc.y + 6, 8, 1, '#6A6F86'); px(ctx, sc.x + 42, sc.y + 4, 9, 5, '#E0709B');
    }
  };

  // ------------------------------------------------------------------ boards (tests, agents, world map)
  Office.prototype._drawTestBoard = function (ctx, t) {
    const b = this._testBoard;
    if (!b) return;
    const ts = this.amb.tests;
    const res = ts.results;
    const n = res.length;
    for (let k = 0; k < 24; k++) {
      const row = k < 12 ? 0 : 1;
      const col = k % 12;
      const idx = n - 24 + k;
      const x = b.lx + col * 8, y = b.ly + row * 4;
      if (idx < 0) { px(ctx, x, y, 6, 3, '#1A262C'); continue; }
      const ok = res[idx];
      px(ctx, x, y, 6, 3, ok ? '#2FA860' : '#C0392B');
      px(ctx, x + 1, y, 4, 1, ok ? '#8CF5B0' : '#FF8A80');
    }
    const last = n ? res[n - 1] : null;
    const sx = b.x + b.w - 11, sy = b.ly - 1;
    if (last === null) px(ctx, sx, sy, 9, 9, '#1A262C');
    else {
      px(ctx, sx, sy, 9, 9, last ? '#2FA860' : '#C0392B');
      if (last) { px(ctx, sx + 2, sy + 4, 1, 2, '#FFFFFF'); px(ctx, sx + 3, sy + 5, 1, 2, '#FFFFFF'); px(ctx, sx + 4, sy + 4, 1, 2, '#FFFFFF'); px(ctx, sx + 5, sy + 3, 1, 2, '#FFFFFF'); px(ctx, sx + 6, sy + 2, 1, 2, '#FFFFFF'); }
      else for (let k = 0; k < 5; k++) { px(ctx, sx + 2 + k, sy + 2 + k, 1, 1, '#FFFFFF'); px(ctx, sx + 6 - k, sy + 2 + k, 1, 1, '#FFFFFF'); }
    }
    const ft = t - ts.flashAt;
    if (ft >= 0 && ft < 1.2 && Math.floor(ft * 8) % 2 === 0) {
      const col = ts.flashOk ? '#6CF09A' : '#FF5A4E';
      px(ctx, b.x - 1, b.y - 1, b.w + 2, 1, col); px(ctx, b.x - 1, b.y + b.h, b.w + 2, 1, col);
      px(ctx, b.x - 1, b.y - 1, 1, b.h + 2, col); px(ctx, b.x + b.w, b.y - 1, 1, b.h + 2, col);
    }
  };

  const STATUS_DOT = { working: '#6CC28A', starting: '#F2C14E', waiting: '#F2C14E', done: '#6AA9FF', error: '#E5534B', stopped: '#8A8FA8' };

  Office.prototype._renderAgentsBoard = function () {
    const b = this._agentsBoard;
    const B = this.amb.board;
    if (!b) return;
    if (!B.canvas) B.canvas = makeCanvas(b.w, b.h);
    if (!B.canvas) return;
    const c = B.canvas.getContext('2d');
    c.clearRect(0, 0, b.w, b.h);
    const n = B.n || 0;
    drawPixelText(c, 'AGENTS', 2, 1, '#F2C14E', 1);
    drawPixelText(c, String(n), 2 + measurePixelText('AGENTS') + 4, 1, '#ECE8F4', 1);
    px(c, 1, 7, b.w - 2, 1, '#1E2A40');
    if (n === 0) {
      const msg = 'AUCUN AGENT';
      drawPixelText(c, msg, Math.round((b.w - measurePixelText(msg)) / 2), 12, '#4A5578', 1);
    } else {
      const colW = Math.floor((b.w - 2) / 3);
      const show = n > 6 ? 5 : Math.min(6, n);
      for (let i = 0; i < show; i++) {
        const e = B.entries[i];
        const cx = 2 + (i % 3) * colW, cy = 10 + ((i / 3) | 0) * 7;
        px(c, cx, cy + 1, 2, 3, STATUS_DOT[e.status] || '#6CC28A');
        drawPixelText(c, fitPixelText(e.name, colW - 6), cx + 4, cy, e.color, 1);
      }
      if (n > 6) drawPixelText(c, '+' + (n - 5), 2 + 2 * colW + 4, 17, '#9B9CB8', 1);
    }
    B.dirty = false;
  };

  Office.prototype._drawAgentsBoard = function (ctx, t, reduced) {
    const b = this._agentsBoard;
    if (!b) return;
    const B = this.amb.board;
    if (B.dirty || !B.canvas) this._renderAgentsBoard();
    if (B.canvas) ctx.drawImage(B.canvas, b.x, b.y);
    // Digital clock (re-rendered once a minute).
    const now = new Date();
    const hh = now.getHours(), mm = now.getMinutes();
    const ck = hh * 60 + mm;
    if (this._clockKey !== ck) {
      this._clockKey = ck;
      if (!this._clockCv) this._clockCv = makeCanvas(20, 5);
      if (this._clockCv) {
        const c = this._clockCv.getContext('2d');
        c.clearRect(0, 0, 20, 5);
        const s = (hh < 10 ? '0' : '') + hh + ' ' + (mm < 10 ? '0' : '') + mm;
        drawPixelText(c, s, 0, 0, '#9FD8F0', 1);
      }
    }
    if (this._clockCv) {
      const cx = b.x + b.w - 21;
      ctx.drawImage(this._clockCv, cx, b.y + 1);
      if (reduced || Math.floor(t * 2) % 2) { px(ctx, cx + 9, b.y + 2, 1, 1, '#9FD8F0'); px(ctx, cx + 9, b.y + 4, 1, 1, '#9FD8F0'); }
    }
    if (!reduced) {
      const scan = Math.floor((t * 12) % (b.h + 6)) - 3;
      if (scan >= 0 && scan < b.h) {
        const a = ctx.globalAlpha;
        ctx.globalAlpha = a * 0.08;
        px(ctx, b.x, b.y + scan, b.w, 2, '#9FD8F0');
        ctx.globalAlpha = a;
      }
    }
  };

  Office.prototype._drawWorldMap = function (ctx, t, reduced) {
    const m = this._worldMap;
    if (!m) return;
    if (!this._cities) {
      const cities = [];
      WORLD_MAP.forEach((row, j) => { for (let i = 0; i < row.length; i++) if (row[i] === '#' && hash(i, j, 91) < 0.2) cities.push([m.x + i * 3 + 1, m.y + j * 3 + 1]); });
      this._cities = cities;
    }
    const cities = this._cities;
    for (let k = 0; k < cities.length; k++) {
      const on = Math.sin(t * 2 + k * 1.7) > -0.2;
      px(ctx, cities[k][0], cities[k][1], 1, 1, on ? '#7FF0D8' : '#3E9C8A');
    }
    if (cities.length > 3) {
      const burst = t - this.amb.web.burst < 3;
      const arcs = reduced ? 1 : burst ? 6 : 3;
      for (let a = 0; a < arcs; a++) {
        const p0 = cities[(a * 5) % cities.length], p1 = cities[(a * 7 + 3) % cities.length];
        const p = (t * (burst ? 0.6 : 0.3) + a / arcs) % 1;
        for (let s = 0; s < 4; s++) {
          const q = p - s * 0.03;
          if (q < 0) continue;
          const bx = p0[0] + (p1[0] - p0[0]) * q;
          const by = p0[1] + (p1[1] - p0[1]) * q - Math.sin(q * Math.PI) * 7;
          px(ctx, Math.round(bx), Math.round(by), 1, 1, s === 0 ? '#F2C14E' : '#8A6E2A');
        }
      }
    }
    const scan = Math.floor((t * 20) % m.w);
    const a = ctx.globalAlpha;
    ctx.globalAlpha = a * 0.12;
    px(ctx, m.x + scan, m.y, 2, m.h, '#7FF0D8');
    ctx.globalAlpha = a;
  };

  // ------------------------------------------------------------------ elevator, tube, vents, neon, windows
  Office.prototype._drawElevator = function (ctx, t) {
    const e = this._elevator;
    if (!e) return;
    const E = this.amb.elevator;
    const open = E.open;
    const half = e.w >> 1;
    const slide = Math.round(open * (half - 1));
    if (open > 0.02) {
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * 0.25 * open;
      px(ctx, e.x, e.y + e.h, e.w, 6, '#FFE2A8');
      ctx.globalAlpha = a;
    }
    const dw = half - slide;
    if (dw > 0) {
      px(ctx, e.x, e.y, dw, e.h, '#B5BACB'); px(ctx, e.x + e.w - dw, e.y, dw, e.h, '#B5BACB');
      px(ctx, e.x, e.y, dw, 1, '#DDE1EA'); px(ctx, e.x + e.w - dw, e.y, dw, 1, '#DDE1EA');
      px(ctx, e.x + dw - 1, e.y, 1, e.h, '#7E8498'); px(ctx, e.x + e.w - dw, e.y, 1, e.h, '#9AA0B5');
      if (dw > 6) { px(ctx, e.x + 3, e.y + 3, 1, e.h - 6, '#C9CFDD'); px(ctx, e.x + e.w - 4, e.y + 3, 1, e.h - 6, '#C9CFDD'); }
    }
    // Floor indicator: "QG" + a down arrow blinking right after a ding.
    const ding = t - E.ding < 2.4;
    drawPixelText(ctx, 'QG', e.ix + (e.iw >> 1) - 3, e.iy + 1, ding ? '#FFD36A' : '#B8923A', 1);
    if (ding && Math.floor(t * 5) % 2 === 0) {
      const ax = e.ix + 3, ay = e.iy + 2;
      px(ctx, ax, ay, 5, 1, '#FFD36A'); px(ctx, ax + 1, ay + 1, 3, 1, '#FFD36A'); px(ctx, ax + 2, ay + 2, 1, 1, '#FFD36A');
      px(ctx, e.ix + e.iw - 7, e.iy + 1, 4, 4, '#FFD36A');
    }
  };

  Office.prototype._drawTube = function (ctx, t) {
    const tb = this._tube;
    const T0 = this.amb.tube;
    if (!tb || !T0.caps.length) return;
    const L1 = tb.x1 - tb.x0, L2 = tb.yb - tb.y, L = L1 + L2;
    for (let i = T0.caps.length - 1; i >= 0; i--) {
      const cap = T0.caps[i];
      const p = (t - cap.t0) / 0.9;
      if (p >= 1 || p < 0) {
        if (p >= 1 && cap.dir > 0) T0.arriveAt = t;
        T0.caps.splice(i, 1);
        continue;
      }
      const q = cap.dir > 0 ? p : 1 - p;
      for (let s = 0; s < 4; s++) {
        const d = (q - s * 0.025 * cap.dir) * L;
        if (d < 0 || d > L) continue;
        let x, y;
        if (d <= L1) { x = tb.x0 + d; y = tb.y; } else { x = tb.x1 - 1; y = tb.y + (d - L1); }
        if (s === 0) { px(ctx, Math.round(x) - 2, Math.round(y), 4, 2, '#E5534B'); px(ctx, Math.round(x) - 2, Math.round(y), 1, 2, '#C9CFDD'); }
        else { const a = ctx.globalAlpha; ctx.globalAlpha = a * (0.6 - s * 0.15); px(ctx, Math.round(x), Math.round(y), 1, 1, '#FFFFFF'); ctx.globalAlpha = a; }
      }
    }
  };

  Office.prototype._drawVents = function (ctx, t, reduced) {
    const v = this._vents;
    if (!v) return;
    const f = reduced ? 0 : Math.floor(t * 14) % 2;
    for (let i = 0; i < v.length; i++) {
      const cx = v[i].cx, cy = v[i].cy;
      if (f) { px(ctx, cx - 3, cy, 7, 1, '#5C6274'); px(ctx, cx, cy - 3, 1, 7, '#5C6274'); }
      else { for (let k = -2; k <= 2; k++) { px(ctx, cx + k, cy + k, 1, 1, '#5C6274'); px(ctx, cx + k, cy - k, 1, 1, '#5C6274'); } }
      px(ctx, cx, cy, 1, 1, '#9AA0B5');
    }
  };

  Office.prototype._drawNeon = function (ctx, t, reduced) {
    const n = this._neon;
    if (!n) return;
    const night = this.tod ? this.tod.night : 0;
    const off = !reduced && hash(Math.floor(t * 8), 3, 95) < 0.03;
    const col = off ? '#5A2E3A' : night > 0.4 ? '#FF9AD0' : '#E0709B';
    // Coffee cup outline in neon tubes.
    px(ctx, n.x + 1, n.y + 3, 7, 1, col); px(ctx, n.x + 1, n.y + 3, 1, 5, col); px(ctx, n.x + 7, n.y + 3, 1, 5, col);
    px(ctx, n.x + 2, n.y + 8, 5, 1, col); px(ctx, n.x + 8, n.y + 4, 2, 1, col); px(ctx, n.x + 9, n.y + 4, 1, 3, col); px(ctx, n.x + 8, n.y + 6, 1, 1, col);
    const s = off ? '#3A2A2A' : '#FFE6A0';
    px(ctx, n.x + 3, n.y + (Math.floor(t * 2) % 2), 1, 2, s); px(ctx, n.x + 5, n.y + 1 - (Math.floor(t * 2) % 2), 1, 2, s);
  };

  Office.prototype._drawWindows = function (ctx, t, reduced) {
    const tod = this.tod;
    const ws = this._windows || [];
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      px(ctx, w.x, w.y, w.w, 3, tod.glassTop); px(ctx, w.x, w.y + 3, w.w, 3, tod.glassMid); px(ctx, w.x, w.y + 6, w.w, w.h - 6, tod.glassBot);
      if (tod.stars > 0.2) {
        for (let k = 0; k < 3; k++) {
          if (!reduced && hash(w.seed, k, Math.floor(t * 0.7 + k)) < 0.4) continue;
          px(ctx, w.x + 1 + ((hash(w.seed, k, 81) * (w.w - 2)) | 0), w.y + 1 + ((hash(w.seed, k, 82) * 5) | 0), 1, 1, '#FFFFFF');
        }
        if (i === 1) { px(ctx, w.x + 4, w.y + 1, 3, 3, '#F3EFD8'); px(ctx, w.x + 6, w.y + 1, 2, 2, tod.glassTop); }
      } else if (tod.sun > 0.3) {
        const cx = w.x + ((t * 1.2 + w.seed * 7) % (w.w + 8)) - 6;
        const x0 = Math.max(w.x, Math.round(cx)), x1 = Math.min(w.x + w.w, Math.round(cx) + 6);
        if (x1 > x0) px(ctx, x0, w.y + 2, x1 - x0, 2, tod.cloud);
      }
      // Glass reflection + centre mullion.
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * 0.22;
      for (let k = 0; k < 4; k++) px(ctx, w.x + 2 + k, w.y + w.h - 2 - k, 1, 1, '#FFFFFF');
      ctx.globalAlpha = a;
      px(ctx, w.x + (w.w >> 1), w.y, 1, w.h, '#D9D4E8');
    }
    const sw = this._sideWins || [];
    for (let i = 0; i < sw.length; i++) {
      const w = sw[i];
      const third = Math.floor(w.h / 3);
      px(ctx, w.x, w.y, w.w, third, tod.glassTop); px(ctx, w.x, w.y + third, w.w, third, tod.glassMid); px(ctx, w.x, w.y + 2 * third, w.w, w.h - 2 * third, tod.glassBot);
      px(ctx, w.x + (w.side === 'left' ? 0 : w.w - 1), w.y, 1, w.h, 'rgba(255,255,255,0.25)');
    }
    // Lit facade windows at night.
    if (tod.lamp > 0.2) {
      const fw = this._facadeWins || [];
      const a = ctx.globalAlpha;
      ctx.globalAlpha = a * Math.min(1, tod.lamp);
      for (let i = 0; i < fw.length; i++) if (fw[i].lit) px(ctx, fw[i].x, fw[i].y + 1, fw[i].w, fw[i].h - 1, fw[i].warm ? '#E8C27A' : '#8FC4DC');
      ctx.globalAlpha = a;
    }
  };

  Office.prototype._drawClocks = function (ctx) {
    const now = new Date();
    for (const d of this.decor) {
      if (d.kind !== 'clock') continue;
      const cx = d.x * T + 8, cy = d.y * T + 7;
      const hA = ((now.getHours() % 12) + now.getMinutes() / 60) / 12 * Math.PI * 2 - Math.PI / 2;
      const mA = (now.getMinutes() + now.getSeconds() / 60) / 60 * Math.PI * 2 - Math.PI / 2;
      for (let s = 0; s <= 2; s++) px(ctx, Math.round(cx - 0.5 + Math.cos(hA) * s), Math.round(cy - 0.5 + Math.sin(hA) * s), 1, 1, '#14151F');
      for (let s = 0; s <= 3; s++) px(ctx, Math.round(cx - 0.5 + Math.cos(mA) * s), Math.round(cy - 0.5 + Math.sin(mA) * s), 1, 1, '#3A3B4E');
      const sA = now.getSeconds() / 60 * Math.PI * 2 - Math.PI / 2;
      px(ctx, Math.round(cx - 0.5 + Math.cos(sA) * 3), Math.round(cy - 0.5 + Math.sin(sA) * 3), 1, 1, '#E5534B');
    }
  };

  /** Ambient bits painted on walls / sky before characters (drawn every frame over the pre-rendered base). */
  Office.prototype.drawUnder = function (ctx, t, reduced) {
    this._drawSky(ctx, t, reduced);
    this._drawWindows(ctx, t, reduced);
    this._drawClocks(ctx);
    this._drawWhiteboard(ctx);
    this._drawProjector(ctx, t);
    this._drawTestBoard(ctx, t);
    this._drawWorldMap(ctx, t, reduced);
    this._drawAgentsBoard(ctx, t, reduced);
    this._drawElevator(ctx, t);
    this._drawTube(ctx, t);
    this._drawVents(ctx, t, reduced);
    this._drawNeon(ctx, t, reduced);
  };

  // ------------------------------------------------------------------ linked library repos (books + plaques)
  const LIB_SHELVES = [1, 3, 5, 9, 11, 13];      // x tile of each library shelf, left to right
  const LIB_MAX = 6;
  const LIB_BOOKS = ['#FF6B6B', '#4DABF7', '#69DB7C', '#FFD43B', '#DA77F2', '#3BC9DB', '#FF922B', '#F783AC', '#A9E34B', '#9775FA'];

  /** Linked repos of the Library object (≤ 6 shown, the rest counted in libMore). Safe with any input. */
  Office.prototype.setLibrary = function (lib) {
    const repos = lib && Array.isArray(lib.repos) ? lib.repos.filter((r) => r && typeof r === 'object') : [];
    const list = [];
    for (const r of repos) {
      const name = String(r.repo || r.id || '?');
      const full = r.owner && r.repo ? String(r.owner) + '/' + String(r.repo) : name;
      let h = 0;
      for (let i = 0; i < full.length; i++) h = (Math.imul(h, 31) + full.charCodeAt(i)) | 0;
      list.push({
        name, full,
        color: LIB_BOOKS[Math.abs(h) % LIB_BOOKS.length],
        status: String(r.status || ''),
        enabled: r.enabled !== false,
        seed: Math.abs(h)
      });
    }
    this.libRepos = list.slice(0, LIB_MAX);
    this.libMore = Math.max(0, list.length - LIB_MAX);
  };

  /** Plaque anchors (world px, centre-top) for the shown repos: one per shelf, zig-zag rows. */
  Office.prototype.libraryPlaques = function () {
    const list = this.libRepos || [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const sx = LIB_SHELVES[i % LIB_SHELVES.length];
      out.push({
        x: (sx + 1) * T, y: 3 * T - 8 + (i % 2) * 12, text: list[i].name, color: list[i].color, full: list[i].full,
        dim: !list[i].enabled || list[i].status === 'error', busy: list[i].status === 'cloning' || list[i].status === 'updating'
      });
    }
    if (this.libMore > 0) out.push({ x: 8 * T, y: 3 * T + 6, text: '+' + this.libMore, color: '#C9A15C', more: true });
    return out;
  };

  /** Extra colourful books on the shelf of each linked repo (repo i → shelf i). */
  Office.prototype._drawLibraryBooks = function (ctx, it, t, reduced) {
    const list = this.libRepos;
    if (!list || !list.length) return;
    const shelf = LIB_SHELVES.indexOf(it.f.x);
    if (shelf < 0 || shelf >= list.length) return;
    const r = list[shelf];
    const by = it.y + 19;                       // middle shelf board of the tall shelf
    const x0 = it.x + 4 + ((r.seed >> 2) % 8);
    const busy = r.status === 'cloning' || r.status === 'updating';
    const a = ctx.globalAlpha;
    if (busy && !reduced && Math.floor(t * 3) % 2) ctx.globalAlpha = a * 0.35;
    else if (!r.enabled || r.status === 'error') ctx.globalAlpha = a * 0.45;
    px(ctx, x0 - 1, by - 8, 16, 8, '#2E1D12');
    const widths = [3, 2, 3, 2, 3, 2];
    const heights = [7, 6, 8, 6, 7, 5];
    let x = x0;
    for (let b = 0; b < widths.length; b++) {
      const col = b % 2 ? LIB_BOOKS[(r.seed + b * 3) % LIB_BOOKS.length] : r.color;
      const bh = Math.min(8, heights[(b + r.seed) % heights.length]);
      px(ctx, x, by - bh, widths[b], bh, col);
      px(ctx, x, by - bh, widths[b], 1, '#FFF4D6');
      px(ctx, x, by - bh + 3, widths[b], 1, '#C9A15C');
      x += widths[b];
    }
    ctx.globalAlpha = a;
    if (!reduced && r.status === 'ready' && r.enabled) {
      const ph = (t * 0.8 + r.seed * 0.37) % 4;
      if (ph < 0.35) px(ctx, x0 + ((r.seed >> 3) % 12), by - 10, 1, 1, '#FFFFFF');
    }
  };

  // ------------------------------------------------------------------ build + draw
  const SWAY = { plant: 9, tree: 13 };

  /** Pre-renders the static base layer and every furniture item once. Returns false without a DOM. */
  Office.prototype.build = function () {
    if (this.built) return true;
    const base = makeCanvas(WIDTH, HEIGHT);
    if (!base) return false;
    const bctx = base.getContext('2d');
    if (!bctx) return false;
    this._paintBase(bctx);
    this.base = base;
    this._buildRailing();
    this.items = [];
    const office = this;
    for (const f of this.furniture) {
      if (f.layer !== 'sorted' || !FURN[f.kind]) continue;
      const pad = f.kind === 'parasol' ? 10 : 0;
      const w = f.w * T + pad * 2, h = f.h * T + f.rise;
      const cv = makeCanvas(w, h);
      if (!cv) continue;
      const c = cv.getContext('2d');
      FURN[f.kind](c, f, w, h, f.rise);
      const anim = ANIM[f.kind] || null;
      const sway = SWAY[f.kind] ? h - SWAY[f.kind] : 0;
      const swaySeed = f.seed * 0.37;
      const it = {
        kind: f.kind, f, img: cv, x: f.x * T - pad, y: f.y * T - f.rise,
        sortY: f.seat ? f.y * T + 2 : (f.y + f.h) * T,
        draw(ctx, t, reduced) {
          if (sway > 0 && !reduced) {
            const off = Math.round(Math.sin(t * 1.1 + swaySeed) * 0.75);
            if (off !== 0) {
              ctx.drawImage(this.img, 0, 0, w, sway, this.x + off, this.y, w, sway);
              ctx.drawImage(this.img, 0, sway, w, h - sway, this.x, this.y + sway, w, h - sway);
            } else ctx.drawImage(this.img, this.x, this.y);
          } else ctx.drawImage(this.img, this.x, this.y);
          if (anim) anim(ctx, this, t, office, reduced);
        }
      };
      if (Array.isArray(f.emit)) for (const e of f.emit) this._emit(it.x + e[0], it.y + e[1], e[2], e[3], e[4]);
      this.items.push(it);
    }
    this.items.sort((a, b) => a.sortY - b.sortY);
    this.built = true;
    this.lightVersion++;
    return true;
  };

  /** Draws the pre-rendered base layer (floor, walls, rugs, signs) plus wall / sky ambient bits. */
  Office.prototype.drawBase = function (ctx, t, reduced) {
    if (!this.built && !this.build()) return;
    this._t = t;
    this.reduced = !!reduced;
    ctx.drawImage(this.base, 0, 0);
    this.drawUnder(ctx, t, reduced);
  };

  /** Light layer (lighting.js). Drawn after characters; no-op when lighting.js is not loaded. */
  Office.prototype.drawLighting = function (ctx, t, view) {
    const L = global.HQLighting;
    if (L && typeof L.draw === 'function') L.draw(this, ctx, t, view);
  };

  /**
   * Minimap: rooms as flat coloured blocks with tiny labels, drawn at (0, 0) into w × h (cached per size).
   * Returns the mapping { scale, sx, sy } (minimap px per world px) so callers can place dots.
   */
  Office.prototype.drawMinimap = function (ctx, w, h) {
    w = Math.max(1, Math.round(Number(w) || 0)); h = Math.max(1, Math.round(Number(h) || 0));
    const sx = w / WIDTH, sy = h / HEIGHT;
    const k = w + 'x' + h;
    if (!this._mini || this._miniKey !== k) {
      const cv = makeCanvas(w, h);
      if (!cv) return { scale: Math.min(sx, sy), sx, sy };
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;
      px(c, 0, 0, w, h, '#1A1B27');
      const X = (tx) => Math.round(tx * T * sx), Y = (ty) => Math.round(ty * T * sy);
      px(c, X(39), 0, w - X(39), Y(4), '#2B3568');
      px(c, X(63), Y(4), w - X(63), Y(11) - Y(4), '#2B3568');
      for (const r of this.roomList) {
        const x0 = X(r.x), y0 = Y(r.y), x1 = X(r.x + r.w), y1 = Y(r.y + r.h);
        px(c, x0, y0, x1 - x0, y1 - y0, mixHex(r.accent, '#1D1F2E', 0.62));
        px(c, x0, y0, x1 - x0, 1, mixHex(r.accent, '#1D1F2E', 0.3));
      }
      for (let ty = 0; ty < ROWS; ty++) for (let tx = 0; tx < COLS; tx++) {
        const i = ty * COLS + tx;
        if (this.door[i] === 1) px(c, X(tx), Y(ty), Math.max(1, X(tx + 1) - X(tx)), Math.max(1, Y(ty + 1) - Y(ty)), '#4E536E');
      }
      c.fillStyle = 'rgba(10,10,20,0.28)';
      for (const f of this.furniture) {
        if (!f.block) continue;
        c.fillRect(X(f.x), Y(f.y), Math.max(1, X(f.x + f.w) - X(f.x)), Math.max(1, Y(f.y + f.h) - Y(f.y)));
      }
      const s = w >= 420 ? 2 : 1;
      for (const r of this.roomList) {
        const x0 = X(r.x), y0 = Y(r.y), rw = X(r.x + r.w) - x0, rh = Y(r.y + r.h) - y0;
        const text = fitPixelText(r.short, Math.floor((rw - 4) / s));
        if (!text || rh < 7 * s) continue;
        const tw = measurePixelText(text) * s;
        const lx = x0 + Math.round((rw - tw) / 2), ly = y0 + Math.round((rh - 5 * s) / 2);
        drawPixelText(c, text, lx + s, ly + s, 'rgba(0,0,0,0.6)', s);
        drawPixelText(c, text, lx, ly, shadeHex(r.accent, 0.35), s);
      }
      this._mini = cv;
      this._miniKey = k;
    }
    ctx.drawImage(this._mini, 0, 0);
    return { scale: Math.min(sx, sy), sx, sy };
  };

  global.HQOffice = {
    TILE: T, COLS, ROWS, WIDTH, HEIGHT,
    create: () => new Office(),
    Office,
    drawPixelText, measurePixelText, fitPixelText, hash,
    computeTod, mixHex, shadeHex, hexToRgb
  };
})(typeof window !== 'undefined' ? window : globalThis);
