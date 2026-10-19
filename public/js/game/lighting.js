/* PixelQG — lighting.js
 * The light layer, drawn after the characters (office.drawLighting → HQLighting.draw):
 *   1. a multiply layer that darkens the office at night (bluish ambient, darker outdoors) with warm holes
 *      under every lamp and full brightness on emissive things (screens, LEDs, neon, lit facade windows);
 *   2. an additive layer with warm pools under lamps, soft halos around screens and daylight shafts from the
 *      windows (slanted with the sun, golden at the end of the day);
 *   3. per-frame glows: monitors of occupied desks (owner colour), the open elevator, the test board flash,
 *      the arcade and the meeting-room projector.
 * Layers 1 and 2 are pre-rendered once per quarter-hour bucket of the time of day (office.todBucket) and only
 * blitted per frame; light pools are dithered, banded ellipses so they stay crisp pixel art when scaled up.
 * Exposes window.HQLighting ({ draw, render, invalidate }).
 */
(function (global) {
  'use strict';

  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  function makeCanvas(w, h) {
    w = Math.max(1, Math.ceil(w)); h = Math.max(1, Math.ceil(h));
    if (global.HQSprites && global.HQSprites.makeCanvas) return global.HQSprites.makeCanvas(w, h);
    if (global.document && typeof global.document.createElement === 'function') {
      const c = global.document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    }
    if (typeof global.OffscreenCanvas === 'function') return new global.OffscreenCanvas(w, h);
    return null;
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  function rgb(hex) {
    const h = String(hex || '').replace('#', '');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return [255, 255, 255];
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbStr(m) {
    return 'rgb(' + Math.round(clamp(m[0], 0, 1) * 255) + ',' + Math.round(clamp(m[1], 0, 1) * 255) + ',' + Math.round(clamp(m[2], 0, 1) * 255) + ')';
  }

  // ------------------------------------------------------------------ light stamps (cached)
  const stamps = new Map();

  /**
   * A dithered light pool: an ellipse flattened for the 3/4 view whose colour fades in four bands
   * (ordered 4x4 Bayer dithering between bands). alpha = intensity at the centre.
   */
  function stamp(r, color, alpha) {
    r = Math.max(3, Math.round(r));
    const a100 = Math.round(clamp(alpha, 0, 1) * 100);
    const key = r + '|' + color + '|' + a100;
    let cv = stamps.get(key);
    if (cv) return cv;
    if (stamps.size > 260) stamps.clear();
    const rx = r, ry = Math.max(3, Math.round(r * 0.72));
    const w = rx * 2 + 1, h = ry * 2 + 1;
    cv = makeCanvas(w, h);
    if (!cv) return null;
    const c = cv.getContext('2d');
    if (!c || typeof c.createImageData !== 'function') { stamps.set(key, cv); return cv; }
    const img = c.createImageData(w, h);
    const d = img.data;
    const col = rgb(color);
    const A = a100 / 100;
    for (let y = 0; y < h; y++) {
      const dy = (y - ry) / ry;
      for (let x = 0; x < w; x++) {
        const dx = (x - rx) / rx;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist >= 1) continue;
        const f = Math.pow(1 - dist, 1.15);
        const th = (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;
        const level = Math.min(4, Math.floor(f * 4 + th)) / 4;
        if (level <= 0) continue;
        const o = (y * w + x) * 4;
        d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = Math.round(255 * A * level);
      }
    }
    c.putImageData(img, 0, 0);
    stamps.set(key, cv);
    return cv;
  }

  function blit(ctx, sp, x, y) {
    if (sp) ctx.drawImage(sp, Math.round(x - (sp.width >> 1)), Math.round(y - (sp.height >> 1)));
  }

  // ------------------------------------------------------------------ pre-rendered layers
  function shaftPoly(ctx, x0, y0, x1, y1, dx, len, alpha, color) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x1 + dx * len, y1 + len); ctx.lineTo(x0 + dx * len, y0 + len);
    ctx.closePath();
    ctx.fill();
  }

  function render(office, st) {
    const W = office.width, H = office.height, T = office.tile || 16;
    const tod = office.tod;
    if (!st.mul) { st.mul = makeCanvas(W, H); st.add = makeCanvas(W, H); }
    if (!st.mul || !st.add) return;
    const lights = office.lights || [];
    const emissive = office.emissive || [];
    // ---- 1. multiply layer
    const m = st.mul.getContext('2d');
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.globalAlpha = 1;
    const amb = tod.amb, out = tod.out;
    st.mulOn = Math.min(amb[0], amb[1], amb[2]) < 0.985;
    if (st.mulOn) {
      m.fillStyle = rgbStr(amb);
      m.fillRect(0, 0, W, H);
      m.fillStyle = rgbStr(out);
      const ter = office.rooms && office.rooms.terrace;
      if (ter) m.fillRect(ter.x * T, ter.y * T, ter.w * T, ter.h * T);
      m.fillRect(0, (office.rows - 1) * T, W, T);
      // The sky already carries its own night colours: never darken it twice.
      m.fillStyle = '#FFFFFF';
      m.fillRect(39 * T, 0, W - 39 * T, 4 * T);
      m.fillRect(63 * T, 4 * T, W - 63 * T, 7 * T);
      m.globalCompositeOperation = 'lighter';
      for (let i = 0; i < lights.length; i++) {
        const L = lights[i];
        const s = tod.lamp * L.power * (L.kind === 'ceil' ? 0.9 : 1);
        if (s <= 0.02) continue;
        blit(m, stamp(L.r, L.color, Math.min(1, 0.6 * s)), L.x, L.y);
      }
      m.globalCompositeOperation = 'source-over';
      m.fillStyle = '#FFFFFF';
      for (let i = 0; i < emissive.length; i++) { const e = emissive[i]; m.fillRect(e.x, e.y, e.w, e.h); }
    }
    // ---- 2. additive layer
    const a = st.add.getContext('2d');
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.globalCompositeOperation = 'source-over';
    a.globalAlpha = 1;
    a.clearRect(0, 0, W, H);
    a.globalCompositeOperation = 'lighter';
    for (let i = 0; i < lights.length; i++) {
      const L = lights[i];
      const s = tod.lamp * L.power;
      if (s <= 0.05) continue;
      const str = L.kind === 'string';
      blit(a, stamp(Math.round(L.r * (str ? 1.1 : 0.75)), L.color, Math.min(0.5, (str ? 0.3 : L.kind === 'lamp' ? 0.2 : 0.12) * s)), L.x, L.y);
    }
    const halo = 0.05 + 0.15 * tod.night;
    for (let i = 0; i < emissive.length; i++) {
      const e = emissive[i];
      const r = Math.min(34, Math.max(7, Math.round(Math.max(e.w, e.h) * 0.75 + 5)));
      blit(a, stamp(r, e.color, halo), e.x + e.w / 2, e.y + e.h / 2);
    }
    // Daylight shafts from the windows (north wall: falling down; side walls: across the rooms).
    if (tod.sun > 0.05) {
      const frac = clamp((tod.hours - 6.6) / 13, 0, 1);
      const elev = Math.sin(frac * Math.PI);
      const slant = Math.cos(frac * Math.PI) * -0.75;          // morning leans one way, evening the other
      const len = Math.round(34 + (1 - elev) * 70);
      const col = tod.sunColor;
      a.globalCompositeOperation = 'lighter';
      const wins = office._windows || [];
      for (let i = 0; i < wins.length; i++) {
        const w = wins[i];
        const y0 = 2 * T;
        shaftPoly(a, w.x, y0, w.x + w.w, y0, slant, len, 0.08 * tod.sun, col);
        shaftPoly(a, w.x + 2, y0, w.x + w.w - 2, y0, slant, Math.round(len * 0.6), 0.06 * tod.sun, col);
      }
      const side = office._sideWins || [];
      const westK = clamp((tod.hours - 11) / 5, 0.2, 1), eastK = clamp((13 - tod.hours) / 5, 0.2, 1);
      for (let i = 0; i < side.length; i++) {
        const w = side[i];
        const left = w.side === 'left';
        const k = (left ? westK : eastK) * tod.sun;
        const x0 = left ? T : (office.cols - 1) * T;
        const dir = left ? 1 : -1;
        const L2 = Math.round(len * 0.9);
        a.globalAlpha = 0.07 * k;
        a.fillStyle = col;
        a.beginPath();
        a.moveTo(x0, w.y); a.lineTo(x0, w.y + w.h);
        a.lineTo(x0 + dir * L2, w.y + w.h + L2 * 0.45); a.lineTo(x0 + dir * L2, w.y + L2 * 0.45);
        a.closePath();
        a.fill();
      }
      // Daylight spilling through the terrace door into the open space.
      a.globalAlpha = 1;
      blit(a, stamp(26, col, 0.14 * tod.sun), 37.4 * T, 7 * T);
      a.globalAlpha = 1;
    }
    a.globalCompositeOperation = 'source-over';
    a.globalAlpha = 1;
    st.bucket = office.todBucket;
    st.ver = office.lightVersion;
  }

  // ------------------------------------------------------------------ per frame
  /**
   * Draws the light layer in world coordinates (the caller's transform maps world px to the screen).
   * view (optional) = { x, y, w, h } visible world rect, used to blit only what is on screen.
   */
  function draw(office, ctx, t, view) {
    if (!office || !ctx || !office.tod || !office.built) return;
    const st = office._lightState || (office._lightState = { bucket: -2, ver: -1, mul: null, add: null, mulOn: false });
    if (st.bucket !== office.todBucket || st.ver !== office.lightVersion) render(office, st);
    if (!st.add) return;
    const W = office.width, H = office.height;
    let sx = 0, sy = 0, sw = W, sh = H;
    if (view && isFinite(view.x) && isFinite(view.y) && view.w > 0 && view.h > 0) {
      sx = clamp(Math.floor(view.x) - 2, 0, W); sy = clamp(Math.floor(view.y) - 2, 0, H);
      sw = clamp(Math.ceil(view.x + view.w) + 2, 0, W) - sx; sh = clamp(Math.ceil(view.y + view.h) + 2, 0, H) - sy;
      if (sw <= 0 || sh <= 0) return;
    }
    const prevOp = ctx.globalCompositeOperation, prevA = ctx.globalAlpha;
    if (st.mulOn) {
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(st.mul, sx, sy, sw, sh, sx, sy, sw, sh);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(st.add, sx, sy, sw, sh, sx, sy, sw, sh);
    const n = typeof office.dynamicGlows === 'function' ? office.dynamicGlows(t) : 0;
    if (n > 0) {
      const k = 0.4 + 0.6 * office.tod.night;
      const pool = office._glowPool;
      for (let i = 0; i < n; i++) {
        const g = pool[i];
        if (g.x < sx - 60 || g.x > sx + sw + 60 || g.y < sy - 60 || g.y > sy + sh + 60) continue;
        ctx.globalAlpha = prevA * clamp(g.a * k, 0, 1);
        blit(ctx, stamp(g.r, g.color, 0.6), g.x, g.y);
      }
    }
    ctx.globalCompositeOperation = prevOp;
    ctx.globalAlpha = prevA;
  }

  function invalidate(office) { if (office && office._lightState) office._lightState.ver = -1; }

  global.HQLighting = {
    draw,
    render(office) {
      if (!office || !office.tod) return;
      const st = office._lightState || (office._lightState = { bucket: -2, ver: -1, mul: null, add: null, mulOn: false });
      render(office, st);
    },
    invalidate
  };
})(typeof window !== 'undefined' ? window : globalThis);
