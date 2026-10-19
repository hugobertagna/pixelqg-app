/* PixelQG — sprites.js
 * Procedural PixelQG robot sprites (the screen-headed office bot: monitor head with a dark screen face,
 * gold antenna, small body with a chest light, two legs) tinted per agent in 8 facing directions,
 * held / used items (book, magnifier, laptop, letter, paper, mug, marker, tablet, globe) cached per colour,
 * a pixel drop shadow, a selection spotlight and the static avatar renderer used by the HUD.
 * Everything is generated with fillRect into cached offscreen canvases: no image files.
 * Exposes window.HQSprites.
 */
(function (global) {
  'use strict';

  const W = 20;            // frame width in world pixels (12 px head + raised arms + outline)
  const H = 16;            // frame height in world pixels; feet touch the bottom row
  // Fixed robot colours (same family as the PixelQG site mascot).
  const INK = '#0A0B16';       // outline and legs
  const SCREEN = '#141A33';    // screen face
  const EYE = '#A6FFF2';       // eye glow
  const EYE_DIM = '#5F9E98';   // eyes of a sleeping / stopped bot
  const EYE_ERR = '#FF6B5E';   // "x" eyes
  const ANTENNA = '#FFC84A';
  const ANTENNA_DIM = '#9A7A3A';
  const STALK = '#8790B0';
  const FALLBACK = '#FF8A5B';
  const DIRS = ['down', 'up', 'left', 'right', 'downleft', 'downright', 'upleft', 'upright'];
  const FRAME_COUNTS = { idle: 2, walk: 4, work: 2, reach: 2, sit: 2, cheer: 2, carry: 4 };
  const EYES = ['open', 'blink', 'closed', 'x', 'happy'];

  // ------------------------------------------------------------------ colour helpers
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function normHex(hex) {
    if (typeof hex !== 'string') return FALLBACK;
    let h = hex.trim();
    if (/^#[0-9a-fA-F]{3}$/.test(h)) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    return /^#[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : FALLBACK;
  }

  function hexToRgb(hex) {
    const h = normHex(hex);
    return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) };
  }

  function rgbToHsl(c) {
    const r = c.r / 255, g = c.g / 255, b = c.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h, s, l };
  }

  function hslToHex(h, s, l) {
    function hue(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    }
    let r, g, b;
    if (s === 0) { r = g = b = l; } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3);
    }
    const x = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
    return ('#' + x(r) + x(g) + x(b)).toUpperCase();
  }

  /** Shift lightness (and optionally saturation) of a hex colour. */
  function shade(hex, dl, ds) {
    const c = rgbToHsl(hexToRgb(hex));
    return hslToHex(c.h, clamp(c.s + (ds || 0), 0, 1), clamp(c.l + dl, 0, 1));
  }

  function rgba(hex, a) {
    const c = hexToRgb(hex);
    return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')';
  }

  /** Relative luminance (0..1) used to pick readable text over an agent colour. */
  function luminance(hex) {
    const c = hexToRgb(hex);
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  const paletteCache = new Map();
  /** Flat pixel-shading palette derived from one agent colour via HSL. */
  function palette(hex) {
    const key = normHex(hex);
    let p = paletteCache.get(key);
    if (p) return p;
    const hsl = rgbToHsl(hexToRgb(key));
    p = {
      base: key,
      light: shade(key, 0.11),
      lighter: shade(key, 0.2),
      dark: shade(key, -0.12, 0.03),
      darker: shade(key, -0.21, 0.05),
      leg: shade(key, -0.16, 0.04),
      outline: hslToHex(hsl.h, clamp(hsl.s * 0.75, 0, 1), clamp(hsl.l * 0.36, 0.06, 0.2))
    };
    paletteCache.set(key, p);
    return p;
  }

  const botPaletteCache = new Map();
  /**
   * Robot shading derived from one agent colour via HSL: casing = the colour, top highlight and chest
   * light pushed toward white, body and side faces darkened (a floor keeps very dark colours readable).
   */
  function botPalette(hex) {
    const key = normHex(hex);
    let p = botPaletteCache.get(key);
    if (p) return p;
    const c = rgbToHsl(hexToRgb(key));
    const toWhite = (k) => hslToHex(c.h, c.s, c.l + (1 - c.l) * k);
    const darker = (k, ds, floor) => hslToHex(c.h, clamp(c.s * ds, 0, 1), Math.max(floor, c.l * k));
    p = {
      head: key,
      hi: toWhite(0.45),
      side: darker(0.8, 0.95, 0.2),
      body: darker(0.68, 0.72, 0.17),
      bodySide: darker(0.52, 0.72, 0.13),
      chest: toWhite(0.7)
    };
    botPaletteCache.set(key, p);
    return p;
  }

  // ------------------------------------------------------------------ canvas helpers
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

  /** Small indexed pixel buffer: lets us compute outlines/mirrors in JS, then paint run-length rects. */
  function PixelBuf(w, h) { this.w = w; this.h = h; this.p = new Array(w * h).fill(null); }
  PixelBuf.prototype.set = function (x, y, c) {
    if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.p[y * this.w + x] = c;
  };
  PixelBuf.prototype.get = function (x, y) {
    return (x >= 0 && y >= 0 && x < this.w && y < this.h) ? this.p[y * this.w + x] : null;
  };
  PixelBuf.prototype.rect = function (x, y, w, h, c) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c);
  };
  /** 1 px outline (4-neighbourhood) around every filled pixel. */
  PixelBuf.prototype.outline = function (c) {
    const src = this.p.slice();
    const w = this.w, h = this.h;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (src[y * w + x] !== null) continue;
        if ((x > 0 && src[y * w + x - 1] !== null) || (x < w - 1 && src[y * w + x + 1] !== null) ||
            (y > 0 && src[(y - 1) * w + x] !== null) || (y < h - 1 && src[(y + 1) * w + x] !== null)) {
          this.p[y * w + x] = c;
        }
      }
    }
    return this;
  };
  PixelBuf.prototype.mirror = function () {
    const out = new Array(this.p.length);
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) out[y * this.w + x] = this.p[y * this.w + (this.w - 1 - x)];
    this.p = out;
    return this;
  };
  /** Paint with one fillRect per horizontal run of identical colour. */
  PixelBuf.prototype.paint = function (ctx, ox, oy) {
    for (let y = 0; y < this.h; y++) {
      let x = 0;
      while (x < this.w) {
        const c = this.p[y * this.w + x];
        if (c === null) { x++; continue; }
        let e = x + 1;
        while (e < this.w && this.p[y * this.w + e] === c) e++;
        ctx.fillStyle = c;
        ctx.fillRect(ox + x, oy + y, e - x, 1);
        x = e;
      }
    }
  };
  PixelBuf.prototype.toCanvas = function () {
    const c = makeCanvas(this.w, this.h);
    if (!c) return null;
    const ctx = c.getContext('2d');
    if (ctx) this.paint(ctx, 0, 0);
    return c;
  };

  /** Build a buffer from ASCII rows + a char→colour map, with an automatic outline. */
  function fromRows(rows, colors, outlineColor) {
    const w = rows[0].length + 2, h = rows.length + 2;
    const b = new PixelBuf(w, h);
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = colors[row[x]];
        if (c) b.set(x + 1, y + 1, c);
      }
    });
    if (outlineColor) b.outline(outlineColor);
    return b;
  }

  // ------------------------------------------------------------------ robot generator
  /** View family + mirroring for each of the 8 facing directions. */
  function viewOf(dir) {
    switch (dir) {
      case 'up': return 'back';
      case 'left': case 'right': return 'side';
      case 'downleft': case 'downright': return 'front34';
      case 'upleft': case 'upright': return 'back34';
      default: return 'front';
    }
  }
  function mirrored(dir) { return dir === 'left' || dir === 'downleft' || dir === 'upleft'; }

  /** Vertical body offset of a pose frame (items held by the character follow it). */
  function bobOf(pose, frame) {
    const f = frame | 0;
    switch (pose) {
      case 'walk': case 'carry': return (f & 1) ? 1 : 0;
      case 'sit': return 2;
      case 'work': case 'reach': return 0;
      default: return f & 1;
    }
  }

  /**
   * Screen layout per view, drawn facing right (left-facing variants are mirrors).
   * s0..s1: screen columns; eyes: eye columns; hl: first column of the 2 px top highlight;
   * flank: shaded side column of the casing (or -1); chest: chest light columns; stalk: antenna stalk column.
   */
  const VIEW_LAYOUT = {
    front: { s0: 6, s1: 13, eyes: [8, 11], hl: 6, flank: -1, chest: [9, 10], stalk: 10 },
    front34: { s0: 7, s1: 13, eyes: [9, 12], hl: 7, flank: 5, chest: [10, 11], stalk: 10 },
    side: { s0: 10, s1: 13, eyes: [11, 13], hl: 6, flank: 5, chest: [12], stalk: 10 },
    back: { s0: -1, s1: -1, eyes: [], hl: 6, flank: -1, chest: [], stalk: 9 },
    back34: { s0: -1, s1: -1, eyes: [], hl: 6, flank: 14, chest: [], stalk: 9 }
  };

  /**
   * Builds one robot frame: a 12x8 monitor head (casing in the agent colour, 2 px highlight, dark
   * screen with two tall glowing eyes), a gold antenna, a darker body with a chest light, thin arms
   * and two short ink legs, with a 1 px ink outline (4-neighbourhood, so corners come out rounded).
   * dir: one of 8 directions. down = front, up = back of the head (casing panel + vents, no face),
   * left/right = side (screen pushed to the front edge), downleft/downright = 3/4 front (face shifted,
   * one flank in shade), upleft/upright = 3/4 back. Left variants are mirrors.
   * pose: idle | walk | work | reach | sit | cheer (both arms up) | carry (walking, arms steady holding an item).
   */
  function buildRobot(color, pose, dir, frame, eyes) {
    const pal = botPalette(color);
    const b = new PixelBuf(W, H);
    const view = viewOf(dir);
    const L = VIEW_LAYOUT[view];
    const back = view === 'back' || view === 'back34';
    let bob = 0, armL = 0, armR = 0, raiseR = false, raiseL = false;
    let lifted = [false, false];
    const f = frame | 0;

    switch (pose) {
      case 'walk':
        if ((f & 3) === 0) { lifted = [true, false]; armL = -1; armR = 1; }
        else if ((f & 3) === 2) { lifted = [false, true]; armL = 1; armR = -1; }
        else bob = 1;
        break;
      case 'carry':
        if ((f & 3) === 0) lifted = [true, false];
        else if ((f & 3) === 2) lifted = [false, true];
        else bob = 1;
        break;
      case 'work':
        armL = (f & 1) ? 0 : -1;
        armR = (f & 1) ? -1 : 0;
        break;
      case 'reach':
        raiseR = true;
        break;
      case 'cheer':
        raiseR = raiseL = true;
        bob = f & 1;
        break;
      case 'sit':
        bob = 2;
        armL = armR = -(f & 1);
        break;
      default:
        bob = f & 1;
    }

    const top = 3 + bob;          // head outline row
    const hy = top + 1;           // first casing row
    const sy = top + 2;           // first screen row (screen is 4 rows tall)
    const ny = top + 8;           // neck row
    const by = top + 9;           // first body row (body is 2 rows tall)

    // Head casing.
    b.rect(5, hy, 10, 6, pal.head);
    b.rect(L.hl, hy, 2, 1, pal.hi);
    if (L.flank >= 0) b.rect(L.flank, hy + 1, 1, 5, pal.side);
    if (L.s0 >= 0) b.rect(L.s0, sy, L.s1 - L.s0 + 1, 4, SCREEN);
    if (view === 'back') {
      // Back of the monitor: a recessed panel with two vent slits.
      b.rect(7, sy, 6, 4, pal.side);
      b.rect(8, sy + 1, 4, 1, pal.body); b.rect(8, sy + 3, 4, 1, pal.body);
    } else if (view === 'back34') {
      b.rect(6, sy, 5, 4, pal.side);
      b.rect(7, sy + 1, 3, 1, pal.body); b.rect(7, sy + 3, 3, 1, pal.body);
    } else if (view === 'side') {
      // Side of the casing: a small round bolt.
      b.rect(7, sy + 1, 1, 2, pal.side);
    }

    // Neck and body.
    b.rect(8, ny, 4, 1, pal.body);
    b.rect(7, by, 6, 2, pal.body);
    if (view === 'front34' || view === 'side') b.rect(7, by, 1, 2, pal.bodySide);
    else if (view === 'back34') b.rect(12, by, 1, 2, pal.bodySide);
    for (const cx of L.chest) b.set(cx, by, pal.chest);
    if (back) b.rect(view === 'back' ? 9 : 8, by, 2, 1, pal.bodySide);

    // Arms: thin 1 px arms hanging just under the head (they never reach the leg row, so the bot
    // always stands on exactly two legs), or raised beside the head with the hand above it.
    // off -1 folds the arm up to a single pixel (swing / typing), 0 lets it hang.
    function arm(x, off) {
      const len = off < 0 ? 1 : 2;
      b.rect(x, ny, 1, len, pal.body);
      b.set(x, ny + len - 1, pal.head);
    }
    function raised(x, toward) {
      const hand = top - 1 + (f & 1);
      b.rect(x, hand, 1, ny - hand + 1, pal.body);
      b.set(x, hand, pal.head);
      b.rect(Math.min(x + toward, x + 2 * toward), ny, 2, 1, pal.body);
    }
    if (raiseL) raised(3, 1); else arm(5, armL);
    if (raiseR) raised(16, -1); else arm(14, armR);

    b.outline(INK);

    // Legs: ink stumps; the row under the body is their top, the gap between them stays open.
    const legRow = by + 2;
    if (legRow < H) {
      b.rect(9, legRow, 2, 1, null);
      const legX = [7, 11];
      for (let i = 0; i < 2; i++) {
        const bottom = lifted[i] ? legRow : H - 1;
        for (let y = legRow; y <= bottom; y++) b.rect(legX[i], y, 2, 1, INK);
      }
    }

    // Face.
    if (!back) {
      const e0 = sy + 1, e1 = sy + 2;
      const xs = L.eyes;
      if (eyes === 'x') {
        for (const x of view === 'side' ? [11] : [L.s0, L.s1 - 2]) {
          b.set(x, sy, EYE_ERR); b.set(x + 2, sy, EYE_ERR); b.set(x + 1, sy + 1, EYE_ERR);
          b.set(x, sy + 2, EYE_ERR); b.set(x + 2, sy + 2, EYE_ERR);
        }
      } else if (eyes === 'closed') {
        // Sleepy dashes, each eye stretched outward by one pixel.
        xs.forEach((x, i) => {
          const nx = i === 0 ? x - 1 : x + 1;
          b.set(x, e1, EYE_DIM);
          if (nx >= L.s0 && nx <= L.s1) b.set(nx, e1, EYE_DIM);
        });
      } else if (eyes === 'blink') {
        for (const x of xs) b.set(x, e1, EYE);
      } else {
        for (const x of xs) { b.set(x, e0, EYE); b.set(x, e1, EYE); }
        if (eyes === 'happy') {
          const m = Math.round((xs[0] + xs[xs.length - 1]) / 2 - 0.5);
          b.rect(view === 'side' ? 12 : m, sy + 3, 2, 1, EYE);
        }
      }
    }

    // Antenna (no outline, like the site mascot): gold ball on a grey stalk.
    const ball = eyes === 'x' ? EYE_ERR : eyes === 'closed' ? ANTENNA_DIM : ANTENNA;
    b.set(L.stalk, top - 1, STALK);
    b.rect(9, top - 2, 2, 1, ball);

    if (mirrored(dir)) b.mirror();
    return b;
  }

  const spriteCache = new Map();

  /** Cached robot frame canvas (W x H) for a colour / pose / direction / frame / eyes combo. */
  function get(color, pose, dir, frame, eyes) {
    const c = normHex(color);
    const p = FRAME_COUNTS[pose] ? pose : 'idle';
    const d = DIRS.indexOf(dir) >= 0 ? dir : 'down';
    const n = FRAME_COUNTS[p];
    const fr = (((frame | 0) % n) + n) % n;
    const ey = EYES.indexOf(eyes) >= 0 ? eyes : 'open';
    // Seen from behind there is no face; only the antenna colour still tells error / sleep apart.
    const e = (d === 'up' || d === 'upleft' || d === 'upright') ? (ey === 'x' || ey === 'closed' ? ey : 'open') : ey;
    const key = c + '|' + p + '|' + d + '|' + fr + '|' + e;
    let cv = spriteCache.get(key);
    if (cv === undefined) {
      if (spriteCache.size > 9000) spriteCache.clear();
      cv = buildRobot(c, p, d, fr, e).toCanvas();
      spriteCache.set(key, cv);
    }
    return cv;
  }

  // ------------------------------------------------------------------ items (carried / used), cached per colour
  // Colour keys: C/L/D = agent base / light / dark, everything else fixed. An outline is added automatically.
  const ACC_DEFS = {
    book: { rows: ['DCCCCC', 'DCCYCC', 'DCCCCC', 'DCCCCC', 'Dwwwww'], colors: { Y: '#F2C14E', w: '#EFE9DC' }, outline: '#2A1A1A' },
    bookopen: { rows: ['CwwwDwwwC', 'CwgwDwgwC', 'CwwwDwwwC', 'CCCCDCCCC'], colors: { w: '#F3EFE6', g: '#9A9488' }, outline: '#2A1A1A' },
    magnifier: { rows: ['.rrr..', 'rbwbr.', 'rbbbr.', 'rbbbr.', '.rrrD.', '....DD'], colors: { r: '#C9CCD8', b: '#9FD3F0', w: '#FFFFFF' }, outline: '#1C1C26' },
    laptop: { rows: ['.kkkkkk.', '.ksLLsk.', '.ksLssk.', '.kkkkkk.', 'gggggggg', 'gddddddg'],
      colors: { k: '#2A2D3A', s: '#1E3A5F', g: '#A0A7B8', d: '#6E7489' }, outline: '#14151F' },
    laptopclosed: { rows: ['CCCCCCCC', 'CCLLCCCC', 'kkkkkkkk'], colors: { k: '#2A2D3A' }, outline: '#14151F' },
    letter: { rows: ['wwwwww', 'wlwwlw', 'wwllww', 'wwwwCw'], colors: { w: '#F7F4EC', l: '#B9B2A2' }, outline: '#2A2A33' },
    paper: { rows: ['wwwwg', 'wCCCw', 'wwwww', 'wgggw', 'wwwww', 'wggww'], colors: { w: '#F7F4EC', g: '#A9A496' }, outline: '#2A2A33' },
    mug: { rows: ['CbbC.', 'CCCCL', 'CLCCL', 'DDDD.'], colors: { b: '#6B4226' }, outline: '#2A1F1A' },
    marker: { rows: ['CC', 'ww', 'ww', 'ww', 'kk'], colors: { w: '#F3EFE6', k: '#2A2A33' }, outline: '#1C1C26' },
    tablet: { rows: ['kkkkkk', 'kbbgbk', 'kbgggk', 'kbbgbk', 'kbbbbk', 'kkCkkk'], colors: { k: '#2A2D3A', b: '#2E6FA8', g: '#7BC67E' }, outline: '#14151F' },
    globe: { rows: ['.bbbb.', 'bggbbb', 'bbggbb', 'bbbggb', '.bbbb.', '..DD..', '.DDDD.'], colors: { b: '#3D7FD0', g: '#6CC28A' }, outline: '#14151F' }
  };
  /** Item shown while walking with it (closed variants), keyed by the "used" item. */
  const CARRY_FORM = { bookopen: 'book', laptop: 'laptopclosed', globe: 'tablet' };
  const accCache = new Map();

  function accessory(name, color) {
    const d = ACC_DEFS[name];
    if (!d) return null;
    const c = normHex(color || FALLBACK);
    const key = name + '|' + c;
    let a = accCache.get(key);
    if (a === undefined) {
      const pal = palette(c);
      const colors = Object.assign({ C: pal.base, L: pal.lighter, D: pal.dark }, d.colors);
      const buf = fromRows(d.rows, colors, d.outline);
      a = { img: buf.toCanvas(), w: buf.w, h: buf.h };
      if (accCache.size > 800) accCache.clear();
      accCache.set(key, a);
    }
    return a;
  }

  /**
   * Where an item sits relative to the sprite's top-left corner (bob excluded) for a facing direction,
   * or null when hidden. Also says whether it is drawn behind the body. "lift" raises a mug to sip /
   * bobs the marker toward the board. Items are held low, at hand height, so the screen face stays
   * visible. pose (optional) puts the marker in the raised hand for reach / cheer.
   */
  function accessoryPlacement(name, dir, lift, color, pose) {
    const a = accessory(name, color);
    if (!a) return null;
    const view = viewOf(dir);
    const mir = mirrored(dir);
    const flip = (x) => (mir ? W - x - a.w : x);
    const back = view === 'back' || view === 'back34';
    if (name === 'marker') {
      if (pose === 'reach' || pose === 'cheer') return { x: flip(15), y: -1 + (lift ? 1 : 0), behind: back };
      return { x: flip(14), y: 8, behind: back };
    }
    // Bottom edge on (or one pixel past) the feet line, never higher than the screen's bottom row.
    let y = name === 'mug' ? (lift ? 6 : 10) : clamp(17 - a.h, 8, 10);
    if (back) {
      // Seen from behind: the item peeks out at the near hand, behind the body.
      if (name === 'mug' && lift) return null;
      return { x: flip(view === 'back' ? 14 : 13), y, behind: true };
    }
    if (view === 'front') return { x: Math.round(10 - a.w / 2) + (name === 'mug' ? 5 : 0), y, behind: false };
    if (view === 'front34') return { x: flip(Math.round(12 - a.w / 2) + (name === 'mug' ? 4 : 0)), y, behind: false };
    return { x: flip(name === 'mug' ? 15 : 13), y, behind: false };
  }

  let shadowCanvas;
  /** 14x4 pixel ellipse drop shadow. */
  function shadow() {
    if (shadowCanvas === undefined) {
      const b = new PixelBuf(14, 4);
      const c = 'rgba(6,6,14,0.34)';
      b.rect(2, 0, 10, 1, c); b.rect(1, 1, 12, 2, c); b.rect(2, 3, 10, 1, c);
      shadowCanvas = b.toCanvas();
    }
    return shadowCanvas;
  }

  let spotCanvas;
  /**
   * Soft pixel-stepped spotlight (light cone + floor pool), 40 x 72, feet at (20, 66).
   * Meant to be drawn with globalCompositeOperation "lighter" at a low alpha.
   */
  function spotlight() {
    if (spotCanvas === undefined) {
      const w = 40, h = 72;
      spotCanvas = makeCanvas(w, h);
      const c = spotCanvas ? spotCanvas.getContext('2d') : null;
      if (c) {
        // Cone: widening bands, brighter toward the floor.
        for (let y = 0; y < 62; y += 2) {
          const k = y / 62;
          const half = Math.round(5 + k * 13);
          c.fillStyle = 'rgba(255,244,214,' + (0.05 + k * 0.16).toFixed(3) + ')';
          c.fillRect(20 - half, y, half * 2, 2);
        }
        // Floor pool: three stepped ellipses.
        const rings = [[19, 6, 0.22], [14, 4, 0.22], [8, 2.5, 0.25]];
        for (const r of rings) {
          c.fillStyle = 'rgba(255,246,220,' + r[2] + ')';
          for (let j = -Math.ceil(r[1]); j <= Math.ceil(r[1]); j++) {
            const half = Math.round(r[0] * Math.sqrt(Math.max(0, 1 - (j * j) / (r[1] * r[1]))));
            if (half > 0) c.fillRect(20 - half, 66 + j, half * 2, 1);
          }
        }
      }
    }
    return spotCanvas;
  }

  /**
   * Draws a character with its feet at world pixel (fx, fy) (integers for crisp output).
   * opts: { pose, dir, frame, eyes, accessory, lift, alpha, shadow, yOffset }
   */
  function drawCharacter(ctx, color, fx, fy, opts) {
    const o = opts || {};
    const x0 = Math.round(fx) - (W >> 1);
    const y0 = Math.round(fy) - H + (o.yOffset | 0);
    const prevAlpha = ctx.globalAlpha;
    if (o.alpha !== undefined && o.alpha < 1) ctx.globalAlpha = prevAlpha * Math.max(0, o.alpha);
    if (o.shadow !== false) {
      const s = shadow();
      if (s) ctx.drawImage(s, Math.round(fx) - 7, Math.round(fy) - 3);
    }
    const dir = DIRS.indexOf(o.dir) >= 0 ? o.dir : 'down';
    const pose = o.pose || 'idle';
    const img = get(color, pose, dir, o.frame || 0, o.eyes || 'open');
    const accName = o.accessory && ACC_DEFS[o.accessory] ? o.accessory : null;
    const place = accName ? accessoryPlacement(accName, dir, o.lift, color, pose) : null;
    const acc = place ? accessory(accName, color) : null;
    const bob = bobOf(pose, o.frame || 0);
    if (acc && acc.img && place.behind) ctx.drawImage(acc.img, x0 + place.x, y0 + place.y + bob);
    if (img) ctx.drawImage(img, x0, y0);
    if (acc && acc.img && !place.behind) ctx.drawImage(acc.img, x0 + place.x, y0 + place.y + bob);
    ctx.globalAlpha = prevAlpha;
  }

  // ------------------------------------------------------------------ HUD avatar
  /**
   * Static mini sprite for cards / roster / drawer. Sets the canvas pixel size itself
   * (CSS size = size, backing store = size x devicePixelRatio) and draws crisp integer-scaled pixels.
   */
  function drawAvatar(canvas, color, opts) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const o = opts || {};
    const size = Math.max(8, Math.min(512, Number(o.size) || 48));
    const status = typeof o.status === 'string' ? o.status : 'working';
    const frame = Number(o.frame) | 0;
    const dpr = Math.max(1, Number(global.devicePixelRatio) || 1);
    const px = Math.max(1, Math.round(size * dpr));
    if (canvas.width !== px) canvas.width = px;
    if (canvas.height !== px) canvas.height = px;
    if (canvas.style) {
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
      canvas.style.imageRendering = 'pixelated';
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, px, px);
    ctx.imageSmoothingEnabled = false;

    let pose = 'idle', eyes = 'open';
    if (status === 'working' || status === 'starting') pose = 'work';
    else if (status === 'error') eyes = 'x';
    else if (status === 'stopped') eyes = 'closed';
    else if (status === 'waiting') eyes = (frame % 6 === 5) ? 'blink' : 'open';

    // The standing robot covers columns 3..16 and rows 1..15 (antenna to feet) plus the shadow down to
    // row 16: fit that 14 x 16 box, centred.
    const scale = Math.max(1, Math.floor((px * 0.94) / 16));
    const ox = Math.round(px / 2 - 10 * scale);
    const oy = Math.round(px / 2 - 8.5 * scale);
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
    const s = shadow();
    if (s) ctx.drawImage(s, 3, 13);
    const img = get(color, pose, 'down', frame, eyes);
    if (img) ctx.drawImage(img, 0, 0);
    ctx.restore();
  }

  function clearCache() {
    spriteCache.clear();
    accCache.clear();
    paletteCache.clear();
    botPaletteCache.clear();
    shadowCanvas = undefined;
    spotCanvas = undefined;
  }

  global.HQSprites = {
    W, H, DIRS, FRAME_COUNTS,
    get, frameCount: (pose) => FRAME_COUNTS[pose] || 2, bobOf, viewOf,
    accessory, accessoryPlacement, CARRY_FORM, ITEMS: Object.keys(ACC_DEFS), shadow, spotlight, drawCharacter, drawAvatar,
    palette, shade, rgba, luminance, normHex, hexToRgb,
    makeCanvas, PixelBuf, fromRows, clearCache
  };
})(typeof window !== 'undefined' ? window : globalThis);
