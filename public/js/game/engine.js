/* PixelQG — engine.js
 * Canvas loop, camera (integer zoom fit, wheel zoom around the cursor, drag pan, smooth follow, guided tour),
 * input (hover / click / double-click hit-testing, room + character tooltips, pet clicks), DPR-correct sizing,
 * minimap, coin flights into the HUD counter, 8-bit WebAudio sounds and the public window.HQGame API.
 * World pixels are drawn crisp: integer zooms render directly with nearest-neighbour; fractional zooms
 * (small viewports, zoom easing) render at the next integer scale into a buffer that is then downsampled.
 * Overlays (names, bubbles, popups, coins) are drawn in screen space at device pixels so they stay sharp.
 * Render order: base → under → furniture/characters/pets (y-sorted) → particles → lighting → overlays → coins/fx.
 * Every call into office.js / lighting.js / characters.js / pets.js / progression.js is guarded: if one of them
 * is missing or throws, the page keeps working (the office simply shows less).
 */
(function (global) {
  'use strict';

  const doc = global.document;
  const S = global.HQSprites || null;
  const O = global.HQOffice || null;
  const C = global.HQCharacters || null;
  const BG = '#0F1018';
  const DRAG_THRESHOLD = 4;      // CSS px before a press becomes a drag
  const MAX_BUFFER = 4096;
  const TOUR_PERIOD = 8;         // seconds between two guided-tour targets
  const ROOM_TIP_DELAY = 0.5;    // seconds of hovering an empty spot before the room tooltip shows
  const MAX_COINS = 48;
  const TEST_RE = /test|jest|vitest|pytest|mocha|spec|lint|tsc|build|compile/i;
  const GIT_RE = /\bgit\b|commit|push|pull|merge|rebase/i;
  const FAIL_RE = /\b(?:fail(?:ed|ure|s)?|error|erreur|échec|echec)\b|✗/i;
  const EMPTY = [];

  function logErr(what, err) {
    if (global.console) global.console.error('[PixelQG] ' + what, err);
  }

  let office = null;
  let world = null;
  try { if (O && typeof O.create === 'function') office = O.create(); } catch (err) { logErr('Le plan du bureau n\'a pas pu être créé.', err); }
  try { if (office && C && typeof C.World === 'function') world = new C.World(office); } catch (err) { logErr('Les personnages n\'ont pas pu être créés.', err); }

  const st = {
    canvas: null, ctx: null, onSelect: null, onHover: null,
    W: 0, H: 0, dpr: 1, rect: { left: 0, top: 0 },
    ins: { t: 0, r: 0, b: 0, l: 0 },           // HUD-covered margins (CSS px) the camera keeps the office out of
    cam: { x: 0, y: 0, z: 1, tx: null, ty: null, tz: null },
    fitMode: true, follow: null, followZoomPending: false, selected: null, hovered: null, extHover: null,
    reduced: false, userReduced: null, sysReduced: false,
    raf: 0, running: false, last: 0, inited: false, initAt: 0,
    ptr: { down: false, id: null, sx: 0, sy: 0, lx: 0, ly: 0, x: 0, y: 0, cx: 0, cy: 0, inside: false, dragging: false, touch: false },
    buffer: null, bctx: null,
    fontReady: false,
    wheelAcc: 0,
    ro: null, mqReduced: null, mqDpr: null,
    sortList: [], overlayList: [],
    listeners: [],
    view: { ox: 0, oy: 0, z: 1 },
    lightView: { x: 0, y: 0, w: 0, h: 0, z: 1, reduced: false, dpr: 1, hours: 12 },
    shake: { t: 0, dur: 0, amp: 0 },
    tour: { on: false, timer: 0, idx: -1 },
    hours: 12, timeOverride: null, todTimer: 0,
    pets: null, petsOwned: false,
    statuses: new Map(), levels: new Map(),
    coinTarget: null,
    charsPing: false, testPending: new Set(),
    typists: 0, typistTimer: 0, tickTimer: 0
  };
  const evListeners = [];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function isInt(z) { return Math.abs(z - Math.round(z)) < 1e-6; }
  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  function safe(fn) {
    return function () {
      try { return fn.apply(null, arguments); } catch (err) {
        logErr('Erreur dans le bureau :', err);
        return undefined;
      }
    };
  }
  function now() { return global.performance && global.performance.now ? global.performance.now() : Date.now(); }
  function listen(target, type, fn, opts, bucket) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, fn, opts);
    (bucket || st.listeners).push(() => { try { target.removeEventListener(type, fn, opts); } catch (e) { /* ignore */ } });
  }
  function WW() { return num(office && office.width) || num(O && O.WIDTH) || 1024; }
  function WH() { return num(office && office.height) || num(O && O.HEIGHT) || 640; }
  function TILE() { return num(O && O.TILE) || num(office && office.tile) || 16; }
  function ready() { return !!(office && world); }
  function chars() { return world && world.chars instanceof Map ? world.chars : null; }
  function getChar(id) {
    if (!world || typeof id !== 'string') return null;
    try { return typeof world.get === 'function' ? world.get(id) : null; } catch (e) { return null; }
  }
  function alive(ch) { return !!ch && ch.state !== 'gone'; }
  function tokensTotal(agent) {
    const t = agent && agent.tokens;
    if (!t) return 0;
    return num(t.total) || num(t.input) + num(t.output) + num(t.cacheRead) + num(t.cacheWrite);
  }
  function localHours() {
    const d = new Date();
    return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  }

  // ------------------------------------------------------------------ events
  function emit(ev) {
    if (!ev || typeof ev !== 'object') return;
    const list = evListeners.slice();
    for (let i = 0; i < list.length; i++) {
      try { list[i](ev); } catch (err) { logErr('Un écouteur HQGame.onEvent a échoué.', err); }
    }
  }

  /** Events coming from characters.js / pets.js (level-ups, pet purrs…). */
  function onWorldEvent(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
    if (ev.type === 'levelup') {
      const lvl = num(ev.level);
      const prev = st.levels.get(ev.id) || 0;
      if (lvl <= prev) return;           // already announced (engine fallback or duplicate)
      st.levels.set(ev.id, lvl);
      sfx('levelup');
    } else if (ev.type === 'petclick') {
      sfx('pet');
    }
    emit(ev);
  }

  function drainWorldEvents() {
    if (!world) return;
    if (typeof world.takeEvents === 'function') {
      const list = world.takeEvents();
      if (list && list.length) for (let i = 0; i < list.length; i++) onWorldEvent(list[i]);
    } else if (Array.isArray(world.events) && world.events.length) {
      const list = world.events.splice(0, world.events.length);
      for (let i = 0; i < list.length; i++) onWorldEvent(list[i]);
    }
    const p = st.pets;
    if (p && st.petsOwned && Array.isArray(p.events) && p.events.length) {
      const list = p.events.splice(0, p.events.length);
      for (let i = 0; i < list.length; i++) onWorldEvent(list[i]);
    }
  }

  /** Engine-side fallback: announce level-ups from token totals if characters.js does not. */
  function trackAgent(agent) {
    const id = agent.id;
    const prevStatus = st.statuses.get(id);
    st.statuses.set(id, agent.status);
    const fresh = prevStatus === undefined;
    if (fresh) {
      if (now() - st.initAt > 1500) sfx('ding');
      if (!st.charsPing) ping('elevator');
    } else if (prevStatus !== agent.status) {
      if (agent.status === 'error') { shakeScreen(); sfx('error'); }
      else if (agent.status === 'done' && (prevStatus === 'working' || prevStatus === 'starting')) sfx('done');
    }
    const P = global.HQProgression;
    if (!P || typeof P.level !== 'function') return;
    let info = null;
    try { info = P.level(tokensTotal(agent)); } catch (e) { info = null; }
    const lvl = info ? num(info.level) : 0;
    if (!lvl) return;
    const known = st.levels.get(id);
    if (known === undefined || fresh) {
      if (known === undefined) st.levels.set(id, lvl);
      return;
    }
    if (lvl > known) {
      const title = info.title;
      const name = agent.name;
      setTimeout(() => {
        if ((st.levels.get(id) || 0) >= lvl || !st.statuses.has(id)) return;
        st.levels.set(id, lvl);
        sfx('levelup');
        emit({ type: 'levelup', id, level: lvl, title, name, source: 'engine' });
      }, 450);
    }
  }

  // ------------------------------------------------------------------ office helpers (all guarded)
  function roomsList() {
    const r = office && office.rooms;
    if (!r) return EMPTY;
    return Array.isArray(r) ? r : Object.keys(r).map((k) => (r[k] && typeof r[k] === 'object' ? Object.assign({ id: k }, r[k]) : null)).filter(Boolean);
  }
  function roomInfo(id) {
    if (!office || !id) return null;
    try { if (typeof office.roomInfo === 'function') return office.roomInfo(id) || null; } catch (e) { /* fall through */ }
    const list = roomsList();
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return list[i];
    return null;
  }
  function roomAtWorld(wx, wy) {
    if (!office) return null;
    try {
      if (typeof office.roomAtWorld === 'function') return office.roomAtWorld(wx, wy) || null;
      if (typeof office.roomAt === 'function') {
        const T = TILE();
        const tx = Math.floor(wx / T), ty = Math.floor(wy / T);
        if (tx < 0 || ty < 0 || wx >= WW() || wy >= WH()) return null;
        const r = office.roomAt(tx, ty);
        return r && typeof r === 'object' ? r.id || null : r || null;
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  function ping(what, arg) {
    if (!office || typeof office.ping !== 'function') return;
    try { office.ping(what, arg); } catch (e) { /* ambient only */ }
  }
  /** True when characters.js already triggers office.ping() itself (then the engine stays quiet). */
  function detectCharsPing() {
    const re = /\.ping\s*\(/;
    const protos = [];
    if (C && C.World && C.World.prototype) protos.push(C.World.prototype);
    if (C && C.Character && C.Character.prototype) protos.push(C.Character.prototype);
    for (const p of protos) {
      for (const k of Object.getOwnPropertyNames(p)) {
        let fn = null;
        try { fn = p[k]; } catch (e) { fn = null; }
        if (typeof fn === 'function' && re.test(Function.prototype.toString.call(fn))) return true;
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ camera
  function freeW() { return Math.max(2, st.W - (st.ins.l + st.ins.r) * st.dpr); }
  function freeH() { return Math.max(2, st.H - (st.ins.t + st.ins.b) * st.dpr); }
  /** Offset (world px at zoom z) from the camera centre to the centre of the free area: freeCentre = cam + shift. */
  function shiftX(z) { return ((st.ins.l - st.ins.r) / 2) * st.dpr / z; }
  function shiftY(z) { return ((st.ins.t - st.ins.b) / 2) * st.dpr / z; }

  function fitZoom() {
    if (st.W < 2 || st.H < 2) return 1;
    const f = Math.min(freeW() / (WW() + 16), freeH() / (WH() + 16));
    if (f >= 2) return Math.floor(f);
    return Math.max(0.2, f);
  }
  function maxZoom() { return 8 * Math.max(1, Math.round(st.dpr)); }
  function minZoom() { return Math.min(fitZoom(), 1); }

  function clampCamera(c) {
    const m = 32;
    const z = c.z;
    const fw = freeW() / z, fh = freeH() / z;
    const sx = shiftX(z), sy = shiftY(z);
    // Work on the centre of the free (HUD-less) area, then convert back to the camera centre.
    let fx = c.x + sx, fy = c.y + sy;
    fx = fw >= WW() + 2 * m ? WW() / 2 : clamp(fx, fw / 2 - m, WW() - fw / 2 + m);
    fy = fh >= WH() + 2 * m ? WH() / 2 : clamp(fy, fh / 2 - m, WH() - fh / 2 + m);
    c.x = fx - sx;
    c.y = fy - sy;
  }

  function fitCamera(instant) {
    st.fitMode = true;
    st.follow = null;
    const z = fitZoom();
    const x = WW() / 2 - shiftX(z), y = WH() / 2 - shiftY(z);
    if (instant || st.reduced) {
      st.cam.z = z; st.cam.x = x; st.cam.y = y;
      st.cam.tx = st.cam.ty = st.cam.tz = null;
    } else {
      st.cam.tz = z; st.cam.tx = x; st.cam.ty = y;
    }
  }

  function followZoom() {
    const f = fitZoom();
    const target = Math.max(2, Math.ceil(f * 1.5));
    return clamp(Math.max(st.cam.tz || st.cam.z, target), minZoom(), maxZoom());
  }

  function beginFollow(id) {
    st.follow = id;
    st.fitMode = false;
    const ch = getChar(id);
    st.followZoomPending = !ch;
    if (!ch) return;
    st.cam.tz = followZoom();
    if (st.reduced) {
      st.cam.z = st.cam.tz; st.cam.tz = null;
      st.cam.x = ch.x - shiftX(st.cam.z); st.cam.y = ch.y - 10 - shiftY(st.cam.z);
      clampCamera(st.cam);
    }
  }

  function updateCamera(dt) {
    const c = st.cam;
    if (st.follow) {
      const ch = getChar(st.follow);
      const zz = c.tz !== null ? c.tz : c.z;
      if (ch) { c.tx = ch.x - shiftX(zz); c.ty = ch.y - 10 - shiftY(zz); }
      else if (!(chars() && chars().has(st.follow))) { c.tx = c.ty = null; }
    }
    const k = st.reduced ? 1 : 1 - Math.exp(-dt * (st.tour.on ? 2.2 : 6));
    if (c.tz !== null) {
      c.z += (c.tz - c.z) * k;
      if (Math.abs(c.tz - c.z) < 0.01) { c.z = c.tz; c.tz = null; }
    }
    if (c.tx !== null && c.ty !== null) {
      c.x += (c.tx - c.x) * k;
      c.y += (c.ty - c.y) * k;
      if (!st.follow && Math.abs(c.tx - c.x) < 0.05 && Math.abs(c.ty - c.y) < 0.05) { c.x = c.tx; c.y = c.ty; c.tx = c.ty = null; }
    }
    clampCamera(c);
  }

  function zoomAt(nz, ax, ay) {
    const c = st.cam;
    const z = c.z;
    const wx = c.x + (ax - st.W / 2) / z, wy = c.y + (ay - st.H / 2) / z;
    c.z = nz; c.tz = null;
    if (!st.follow) {
      c.x = wx - (ax - st.W / 2) / nz;
      c.y = wy - (ay - st.H / 2) / nz;
      c.tx = c.ty = null;
    }
    st.fitMode = false;
    clampCamera(c);
  }

  /** Glides the camera onto a world point at zoom z (instant with reduced motion). */
  function glideTo(wx, wy, z) {
    const c = st.cam;
    const zz = clamp(z, minZoom(), maxZoom());
    st.fitMode = false;
    st.follow = null;
    const x = wx - shiftX(zz), y = wy - shiftY(zz);
    if (st.reduced) {
      c.z = zz; c.x = x; c.y = y; c.tx = c.ty = c.tz = null;
      clampCamera(c);
    } else {
      c.tz = zz; c.tx = x; c.ty = y;
    }
  }

  function focusRoom(id) {
    const r = roomInfo(id);
    if (!r) return false;
    const T = TILE();
    const w = num(r.w) * T, h = num(r.h) * T;
    const cx = (num(r.x) + num(r.w) / 2) * T, cy = (num(r.y) + num(r.h) / 2) * T;
    let z = Math.min(freeW() / (w + 64), freeH() / (h + 64));
    z = z >= 2 ? Math.floor(z) : z;
    z = Math.max(z, fitZoom());
    glideTo(cx, cy, Math.min(z, 6 * Math.max(1, Math.round(st.dpr))));
    return true;
  }

  // ------------------------------------------------------------------ guided tour
  function setTour(on) {
    const next = !!on;
    if (next === st.tour.on) return;
    st.tour.on = next;
    st.tour.timer = 0;
    if (!next) {
      st.follow = st.selected || null;
    }
    emit({ type: 'tour', on: next });
  }

  function stopTourByUser() { if (st.tour.on) setTour(false); }

  function tourStep(dt) {
    if (!st.tour.on) return;
    st.tour.timer -= dt;
    if (st.tour.timer > 0) return;
    st.tour.timer = TOUR_PERIOD;
    const m = chars();
    const busy = [];
    const any = [];
    if (m) {
      for (const ch of m.values()) {
        if (!alive(ch) || ch.leaving) continue;
        any.push(ch);
        const s = ch.agent && ch.agent.status;
        if (s === 'working' || s === 'starting') busy.push(ch);
      }
    }
    const list = busy.length ? busy : any;
    if (list.length) {
      list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      st.tour.idx = (st.tour.idx + 1) % list.length;
      const ch = list[st.tour.idx];
      st.follow = ch.id;
      st.fitMode = false;
      st.cam.tz = followZoom();
      if (st.reduced) beginFollow(ch.id);
      return;
    }
    // Nobody at work: wander from room to room.
    const rooms = roomsList();
    if (!rooms.length) return;
    st.tour.idx = (st.tour.idx + 1) % rooms.length;
    focusRoom(rooms[st.tour.idx].id);
  }

  // ------------------------------------------------------------------ screen shake
  function shakeScreen() {
    if (st.reduced) return;
    st.shake.t = 0;
    st.shake.dur = 0.35;
    st.shake.amp = 3;
  }
  function shakeOffset(out) {
    const s = st.shake;
    out.x = 0; out.y = 0;
    if (st.reduced || s.dur <= 0 || s.t >= s.dur) return;
    const k = 1 - s.t / s.dur;
    const a = s.amp * k * st.dpr;
    out.x = Math.round(Math.sin(s.t * 71) * a);
    out.y = Math.round(Math.cos(s.t * 53) * a * 0.6);
  }
  const shakeOut = { x: 0, y: 0 };

  // ------------------------------------------------------------------ sound (8-bit WebAudio, off by default)
  const snd = { on: false, ctx: null, master: null, last: Object.create(null) };
  const SFX_GAP = { tick: 0.07, coin: 0.05, done: 0.3, error: 0.35, levelup: 0.6, ding: 1.2, pet: 0.5, achievement: 0.8, click: 0.05 };

  function ensureAudio() {
    if (snd.ctx) return true;
    const AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) return false;
    try {
      snd.ctx = new AC();
      snd.master = snd.ctx.createGain();
      snd.master.gain.value = 0.14;
      snd.master.connect(snd.ctx.destination);
      return true;
    } catch (err) {
      snd.ctx = null;
      return false;
    }
  }

  function tone(freq, start, dur, type, vol, slideTo) {
    const c = snd.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(vol, start + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g);
    g.connect(snd.master);
    o.start(start);
    o.stop(start + dur + 0.03);
  }

  const SFX = {
    tick(t) { tone(1500 + Math.random() * 700, t, 0.022, 'square', 0.12); },
    click(t) { tone(880, t, 0.03, 'square', 0.25); },
    coin(t) { tone(988, t, 0.06, 'square', 0.35); tone(1319, t + 0.06, 0.16, 'square', 0.35); },
    done(t) { const n = [523, 659, 784, 1047]; for (let i = 0; i < n.length; i++) tone(n[i], t + i * 0.085, 0.22, 'triangle', 0.6); },
    error(t) { tone(150, t, 0.3, 'sawtooth', 0.45, 80); tone(156, t, 0.3, 'square', 0.2, 84); },
    levelup(t) { const n = [523, 659, 784, 1047, 784, 1047, 1319]; for (let i = 0; i < n.length; i++) tone(n[i], t + i * 0.065, 0.12, 'square', 0.4); },
    ding(t) { tone(1319, t, 0.7, 'sine', 0.55); tone(1047, t + 0.2, 0.9, 'sine', 0.5); },
    pet(t) { tone(70, t, 0.45, 'triangle', 0.5, 60); tone(1568, t + 0.1, 0.08, 'square', 0.18, 2093); },
    achievement(t) { const n = [784, 988, 1175, 1568]; for (let i = 0; i < n.length; i++) tone(n[i], t + i * 0.1, i === 3 ? 0.4 : 0.12, 'square', 0.4); }
  };

  function sfx(name) {
    if (!snd.on || !snd.ctx || snd.ctx.state !== 'running' || (doc && doc.hidden)) return;
    const fn = SFX[name];
    if (!fn) return;
    const t = snd.ctx.currentTime;
    if (t - (snd.last[name] || -99) < (SFX_GAP[name] || 0.05)) return;
    snd.last[name] = t;
    try { fn(t + 0.01); } catch (err) { /* audio is decoration */ }
  }

  function setSound(on) {
    snd.on = !!on;
    if (snd.on) {
      if (!ensureAudio()) { snd.on = false; return false; }
      const go = () => sfx('click');
      if (snd.ctx.state === 'suspended' && typeof snd.ctx.resume === 'function') {
        snd.ctx.resume().then(go, () => {});
      } else {
        go();
      }
    } else if (snd.ctx && snd.ctx.state === 'running' && typeof snd.ctx.suspend === 'function') {
      snd.ctx.suspend().catch(() => {});
    }
    return snd.on;
  }

  /** Soft typing ticks while somebody types at a desk (edit / write). */
  function soundStep(dt) {
    if (!snd.on) return;
    st.typistTimer -= dt;
    if (st.typistTimer <= 0) {
      st.typistTimer = 0.5;
      let n = 0;
      const m = chars();
      if (m) {
        for (const ch of m.values()) {
          const a = ch.agent;
          if (!alive(ch) || !a || a.status !== 'working' || !a.activity) continue;
          const k = a.activity.kind;
          if (k === 'edit' || k === 'write') n++;
        }
      }
      st.typists = n;
    }
    if (!st.typists) return;
    st.tickTimer -= dt;
    if (st.tickTimer <= 0) {
      st.tickTimer = 0.09 + Math.random() * (0.32 / Math.min(3, st.typists));
      sfx('tick');
    }
  }

  // ------------------------------------------------------------------ coins (fly from characters into the HUD counter)
  const coins = [];
  let coinFrames = null, coinFramesU = 0;

  function coinSprites(u) {
    if (coinFrames && coinFramesU === u) return coinFrames;
    const mk = S && typeof S.makeCanvas === 'function' ? S.makeCanvas : (w, h) => {
      const c = doc.createElement('canvas'); c.width = w; c.height = h; return c;
    };
    // 8×8 coin seen from 4 angles (spinning), drawn once per pixel size.
    const shapes = [
      ['..####..', '.#oooo#.', '#oo**oo#', '#o*oo*o#', '#o*oo*o#', '#oo**oo#', '.#oooo#.', '..####..'],
      ['...##...', '..#oo#..', '.#o**o#.', '.#o*oo#.', '.#o*oo#.', '.#o**o#.', '..#oo#..', '...##...'],
      ['...##...', '...##...', '...#*...', '...#*...', '...#*...', '...#*...', '...##...', '...##...'],
      ['...##...', '..#oo#..', '.#o**o#.', '.#oo*o#.', '.#oo*o#.', '.#o**o#.', '..#oo#..', '...##...']
    ];
    const pal = { '#': '#7A5518', o: '#F2C14E', '*': '#FFE89A' };
    coinFrames = shapes.map((rows) => {
      const c = mk(8 * u, 8 * u);
      const g = c.getContext('2d');
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const ch = rows[y][x];
          if (ch === '.') continue;
          g.fillStyle = pal[ch];
          g.fillRect(x * u, y * u, u, u);
        }
      }
      return c;
    });
    coinFramesU = u;
    return coinFrames;
  }

  function coinTargetDevice(out) {
    if (typeof st.coinTarget !== 'function' || !st.canvas) return false;
    let p = null;
    try { p = st.coinTarget(); } catch (e) { p = null; }
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
    out.x = (p.x - st.rect.left) * st.dpr;
    out.y = (p.y - st.rect.top) * st.dpr;
    return true;
  }
  const coinTgt = { x: 0, y: 0 };

  function coinArrived(value) {
    sfx('coin');
    emit({ type: 'coin', value: Math.max(0, Math.round(value)) });
  }

  function spawnCoin(wx, wy, value, delay) {
    const v = num(value);
    if (v <= 0) return;
    if (!st.canvas || st.reduced || (doc && doc.hidden) || !coinTargetDevice(coinTgt)) { coinArrived(v); return; }
    let active = 0, newest = null;
    for (let i = 0; i < coins.length; i++) {
      if (!coins[i].on) continue;
      active++;
      if (!newest || coins[i].born > newest.born) newest = coins[i];
    }
    if (active >= MAX_COINS && newest) { newest.value += v; return; }
    let c = null;
    for (let i = 0; i < coins.length; i++) if (!coins[i].on) { c = coins[i]; break; }
    if (!c) { c = { on: false }; coins.push(c); }
    c.on = true;
    c.x0 = st.view.ox + wx * st.view.z;
    c.y0 = st.view.oy + wy * st.view.z;
    c.t = -(delay || 0);
    c.dur = 0.8 + Math.random() * 0.3;
    c.value = v;
    c.born = now();
    c.spin = Math.random() * 4;
    c.dx = (Math.random() - 0.5) * 40 * st.dpr;
  }

  function stepCoins(dt) {
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      if (!c.on) continue;
      c.t += dt;
      if (c.t >= c.dur) { c.on = false; coinArrived(c.value); }
    }
  }

  function drawCoins(ctx) {
    let any = false;
    for (let i = 0; i < coins.length; i++) if (coins[i].on && coins[i].t > 0) { any = true; break; }
    if (!any) return;
    if (!coinTargetDevice(coinTgt)) return;
    const u = Math.max(1, Math.round(1.6 * st.dpr));
    const frames = coinSprites(u);
    const half = 4 * u;
    ctx.save();
    ctx.globalAlpha = 1;
    for (let i = 0; i < coins.length; i++) {
      const c = coins[i];
      if (!c.on || c.t <= 0) continue;
      const k = c.t / c.dur;
      let x, y;
      const pop = 0.22;
      if (k < pop) {
        // Pop up out of the character first.
        const q = k / pop;
        x = c.x0 + c.dx * q;
        y = c.y0 - (26 * st.dpr) * Math.sin(q * Math.PI / 2);
      } else {
        // Then accelerate along a curve into the counter.
        const q = (k - pop) / (1 - pop);
        const e = q * q;
        const sx = c.x0 + c.dx, sy = c.y0 - 26 * st.dpr;
        const cx = sx + (coinTgt.x - sx) * 0.15, cy = Math.min(sy, coinTgt.y) - 90 * st.dpr;
        const a = (1 - e) * (1 - e), b = 2 * (1 - e) * e, d = e * e;
        x = a * sx + b * cx + d * coinTgt.x;
        y = a * sy + b * cy + d * coinTgt.y;
      }
      const f = frames[(Math.floor((c.t + c.spin) * 12) & 3)];
      ctx.drawImage(f, Math.round(x - half), Math.round(y - half));
    }
    ctx.restore();
  }

  // ------------------------------------------------------------------ pets
  function petsObj() { return st.pets; }
  function setupPets() {
    st.pets = null;
    st.petsOwned = false;
    if (world && world.pets && typeof world.pets === 'object') { st.pets = world.pets; return; }
    const P = global.HQPets;
    if (!P || !office) return;
    try {
      if (typeof P.create === 'function') st.pets = P.create(office, world) || null;
      else if (typeof P.Pets === 'function') st.pets = new P.Pets(office, world);
      st.petsOwned = !!st.pets;
      if (st.pets && typeof st.pets === 'object' && !('onEvent' in st.pets && typeof st.pets.onEvent === 'function')) {
        st.pets.onEvent = onWorldEvent;
      }
    } catch (err) {
      logErr('Les animaux du bureau n\'ont pas pu arriver.', err);
      st.pets = null;
      st.petsOwned = false;
    }
  }
  const petCtx = { selectedId: null, selected: null, hours: 12, reduced: false };
  function stepPets(dt) {
    const p = st.pets;
    if (!p || !st.petsOwned || typeof p.update !== 'function') return;
    petCtx.selectedId = st.selected;
    petCtx.selected = st.selected ? getChar(st.selected) : null;
    petCtx.hours = st.hours;
    petCtx.reduced = st.reduced;
    try { p.update(dt, petCtx); } catch (err) { logErr('pets.update', err); st.petsOwned = false; }
  }
  function petHit(wx, wy) {
    const p = st.pets;
    if (!p || typeof p.hitTest !== 'function') return null;
    try { return p.hitTest(wx, wy) || null; } catch (e) { return null; }
  }
  function petClick(wx, wy) {
    const p = st.pets;
    if (!p || typeof p.click !== 'function') return false;
    const hit = typeof p.hitTest === 'function' ? petHit(wx, wy) : true;
    if (!hit) return false;
    let res = false;
    try { res = p.click(wx, wy); } catch (e) { res = false; }
    const ok = typeof p.hitTest === 'function' ? true : !!res;
    if (ok) {
      sfx('pet');
      emit({ type: 'petclick', pet: typeof hit === 'string' ? hit : (res && typeof res === 'object' ? res.name || res.id : null) });
    }
    return ok;
  }

  // ------------------------------------------------------------------ time of day
  function applyTimeOfDay() {
    st.hours = st.timeOverride !== null ? st.timeOverride : localHours();
    if (office && typeof office.setTimeOfDay === 'function') {
      try { office.setTimeOfDay(st.hours); } catch (err) { logErr('office.setTimeOfDay', err); }
    }
    if (world && typeof world.setTimeOfDay === 'function') {
      try { world.setTimeOfDay(st.hours); } catch (e) { /* optional */ }
    }
    const p = st.pets;
    if (p && st.petsOwned && typeof p.setTimeOfDay === 'function') {
      try { p.setTimeOfDay(st.hours); } catch (e) { /* optional */ }
    }
    mini.staticKey = '';
  }

  // ------------------------------------------------------------------ sizing
  function resize() {
    const cv = st.canvas;
    if (!cv) return;
    const rect = cv.getBoundingClientRect ? cv.getBoundingClientRect() : { width: cv.clientWidth, height: cv.clientHeight, left: 0, top: 0 };
    const dpr = Math.max(0.5, Number(global.devicePixelRatio) || 1);
    const W = Math.max(1, Math.round((rect.width || 0) * dpr));
    const H = Math.max(1, Math.round((rect.height || 0) * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    st.rect.left = rect.left || 0;
    st.rect.top = rect.top || 0;
    const dprChanged = dpr !== st.dpr;
    st.W = W; st.H = H; st.dpr = dpr;
    if (dprChanged) { watchDpr(); coinFrames = null; }
    if (st.fitMode) fitCamera(true);
    else clampCamera(st.cam);
    if (!st.running) render();
  }

  function watchDpr() {
    if (!global.matchMedia) return;
    if (st.mqDpr && st.mqDpr.removeEventListener) st.mqDpr.removeEventListener('change', onDprChange);
    try {
      st.mqDpr = global.matchMedia('(resolution: ' + st.dpr + 'dppx)');
      if (st.mqDpr && st.mqDpr.addEventListener) st.mqDpr.addEventListener('change', onDprChange);
    } catch (e) { st.mqDpr = null; }
  }
  function onDprChange() { resize(); miniResize(); }

  function applyReduced() {
    st.reduced = st.userReduced !== null ? st.userReduced : st.sysReduced;
    if (world) world.reduced = st.reduced;
    if (st.pets && typeof st.pets === 'object') {
      try { st.pets.reduced = st.reduced; } catch (e) { /* read-only */ }
    }
    if (st.reduced) { st.shake.dur = 0; }
  }

  function checkFonts() {
    let isReady = false;
    try {
      const fonts = doc && doc.fonts;
      if (fonts && typeof fonts.forEach === 'function') {
        fonts.forEach((face) => {
          if (String(face.family).replace(/["']/g, '').trim().toLowerCase() === 'silkscreen' && face.status === 'loaded') isReady = true;
        });
      }
    } catch (e) { isReady = false; }
    if (isReady !== st.fontReady) {
      st.fontReady = isReady;
      if (C && typeof C.clearTextCache === 'function') { try { C.clearTextCache(); } catch (e) { /* ignore */ } }
    }
  }

  // ------------------------------------------------------------------ loop
  function frame(ts) {
    st.raf = 0;
    if (!st.canvas || !st.running) return;
    if (doc && doc.hidden) { st.running = false; return; }
    const t = typeof ts === 'number' ? ts : now();
    let dt = (t - st.last) / 1000;
    st.last = t;
    if (!(dt >= 0)) dt = 0;
    if (dt > 0.1) dt = 0.1;
    step(dt);
    render();
    miniStep(dt);
    tipStep(dt);
    st.raf = global.requestAnimationFrame(frame);
  }

  function start() {
    if (st.running || !st.canvas || typeof global.requestAnimationFrame !== 'function') return;
    if (doc && doc.hidden) return;
    st.running = true;
    st.last = now();
    st.raf = global.requestAnimationFrame(frame);
  }

  function stop() {
    st.running = false;
    if (st.raf && typeof global.cancelAnimationFrame === 'function') global.cancelAnimationFrame(st.raf);
    st.raf = 0;
  }

  function step(dt) {
    if (world) {
      world.selectedId = st.selected;
      if (typeof world.update === 'function') {
        try { world.update(dt); } catch (err) { logErr('world.update', err); }
      }
      if (typeof world.takeCoins === 'function') {
        let list = null;
        try { list = world.takeCoins(); } catch (e) { list = null; }
        if (list && list.length) {
          for (let i = 0; i < list.length; i++) {
            const c = list[i];
            if (c) spawnCoin(num(c.x), num(c.y), c.value, i * 0.05);
          }
        }
      }
      drainWorldEvents();
    }
    stepPets(dt);
    tourStep(dt);
    updateCamera(dt);
    stepCoins(dt);
    soundStep(dt);
    if (st.shake.dur > 0) { st.shake.t += dt; if (st.shake.t >= st.shake.dur) st.shake.dur = 0; }
    st.todTimer += dt;
    if (st.todTimer >= 30) { st.todTimer = 0; applyTimeOfDay(); }
    if (st.ptr.inside && !st.ptr.down) updateHover();
    else if (st.hovered && !getChar(st.hovered)) setHover(null);
  }

  // ------------------------------------------------------------------ rendering
  function ensureBuffer(w, h) {
    if (!st.buffer) {
      st.buffer = S && typeof S.makeCanvas === 'function' ? S.makeCanvas(w, h) : (doc ? doc.createElement('canvas') : null);
      if (st.buffer && !(S && typeof S.makeCanvas === 'function')) { st.buffer.width = w; st.buffer.height = h; }
      st.bctx = st.buffer ? st.buffer.getContext('2d') : null;
    }
    if (st.buffer && (st.buffer.width < w || st.buffer.height < h)) {
      st.buffer.width = Math.max(st.buffer.width, w);
      st.buffer.height = Math.max(st.buffer.height, h);
    }
    return st.bctx;
  }

  function sortKey(o) { return o.sortY !== undefined ? o.sortY : o.y; }
  function bySortKey(a, b) { return sortKey(a) - sortKey(b); }

  function drawWorld(ctx, t) {
    ctx.imageSmoothingEnabled = false;
    if (typeof office.drawBase === 'function') {
      try { office.drawBase(ctx, t, st.reduced); } catch (err) { logErr('office.drawBase', err); office.drawBase = null; }
    }
    const list = st.sortList;
    list.length = 0;
    const items = Array.isArray(office.items) ? office.items : EMPTY;
    for (let i = 0; i < items.length; i++) list.push(items[i]);
    const m = chars();
    if (m) for (const ch of m.values()) if (ch.state !== 'gone') list.push(ch);
    const p = st.pets;
    let petsDrawn = false;
    if (p && typeof p.list === 'function') {
      try {
        const pl = p.list();
        if (pl && pl.length) for (let i = 0; i < pl.length; i++) if (pl[i] && typeof pl[i].draw === 'function') list.push(pl[i]);
        petsDrawn = true;
      } catch (e) { petsDrawn = false; }
    }
    list.sort(bySortKey);
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      try {
        if (typeof o.drawWorld === 'function') o.drawWorld(ctx, t, o.id === st.selected, o.id === st.hovered || o.id === st.extHover);
        else if (typeof o.draw === 'function') o.draw(ctx, t, st.reduced);
      } catch (err) { /* one broken sprite must not blank the office */ }
    }
    if (p && !petsDrawn && typeof p.draw === 'function') {
      try { p.draw(ctx, t, st.reduced); } catch (e) { /* ignore */ }
    }
    if (typeof world.drawParticles === 'function') {
      try { world.drawParticles(ctx); } catch (e) { /* ignore */ }
    }
    drawLighting(ctx, t);
  }

  function drawLighting(ctx, t) {
    const lv = st.lightView;
    const z = st.cam.z;
    lv.w = st.W / z; lv.h = st.H / z;
    lv.x = st.cam.x - lv.w / 2; lv.y = st.cam.y - lv.h / 2;
    lv.z = z; lv.reduced = st.reduced; lv.dpr = st.dpr; lv.hours = st.hours;
    try {
      if (typeof office.drawLighting === 'function') office.drawLighting(ctx, t, lv);
      else if (global.HQLighting && typeof global.HQLighting.draw === 'function') global.HQLighting.draw(office, ctx, t, lv);
    } catch (err) {
      // Lighting is decoration: disable it for this session rather than spamming errors every frame.
      logErr('Éclairage désactivé :', err);
      office.drawLighting = null;
      if (global.HQLighting) global.HQLighting.draw = null;
    }
  }

  function render() {
    const ctx = st.ctx;
    if (!ctx || st.W < 2 || st.H < 2) return;
    const W = st.W, H = st.H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    if (!ready()) return;
    if (!office.built && typeof office.build === 'function') {
      let ok = false;
      try { ok = office.build(); } catch (err) { logErr('office.build', err); }
      if (!ok && !office.built) return;
    }
    const t = num(world.time);
    const z = st.cam.z;
    shakeOffset(shakeOut);
    const view = st.view;
    if (isInt(z) && z >= 1) {
      const zi = Math.round(z);
      const ox = Math.round(W / 2 - st.cam.x * zi) + shakeOut.x, oy = Math.round(H / 2 - st.cam.y * zi) + shakeOut.y;
      ctx.setTransform(zi, 0, 0, zi, ox, oy);
      drawWorld(ctx, t);
      view.ox = ox; view.oy = oy; view.z = zi;
    } else {
      let K = Math.max(1, Math.ceil(z));
      while (K > 1 && (W * K / z > MAX_BUFFER || H * K / z > MAX_BUFFER)) K--;
      const r = z / K;
      const bw = Math.ceil(W / r) + K, bh = Math.ceil(H / r) + K;
      const b = ensureBuffer(bw, bh);
      if (!b) return;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.globalAlpha = 1;
      b.fillStyle = BG;
      b.fillRect(0, 0, bw, bh);
      const bx = Math.round(bw / 2 - st.cam.x * K), by = Math.round(bh / 2 - st.cam.y * K);
      b.setTransform(K, 0, 0, K, bx, by);
      drawWorld(b, t);
      b.setTransform(1, 0, 0, 1, 0, 0);
      const dx = W / 2 - (bw / 2) * r + shakeOut.x, dy = H / 2 - (bh / 2) * r + shakeOut.y;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(st.buffer, 0, 0, bw, bh, dx, dy, bw * r, bh * r);
      ctx.imageSmoothingEnabled = false;
      view.ox = dx + bx * r; view.oy = dy + by * r; view.z = z;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    drawOverlays(ctx, view);
    drawCoins(ctx);
  }

  const ov = { ox: 0, oy: 0, z: 1, u: 1, fs: 8, font: '', fontOffset: 0, reduced: false, compact: false, dpr: 1 };
  function drawOverlays(ctx, view) {
    const cssZ = view.z / st.dpr;
    const u = Math.max(1, Math.round(st.dpr * clamp(cssZ * 0.55, 1, 2)));
    const fs = st.fontReady ? 8 * u : Math.round(10 * u);
    const font = st.fontReady ? fs + 'px "Silkscreen", monospace' : 'bold ' + fs + 'px ui-monospace, "JetBrains Mono", Consolas, monospace';
    // compact: the office is drawn below ~0.8x (small windows, phones); text bubbles would bury the
    // characters, so only the selected / hovered one keeps its label bubble, the others show the icon.
    const v = ov;
    v.ox = view.ox; v.oy = view.oy; v.z = view.z; v.u = u; v.fs = fs; v.font = font;
    v.fontOffset = st.fontReady ? 0 : Math.round(u / 2); v.reduced = st.reduced; v.compact = cssZ < 0.8; v.dpr = st.dpr;
    drawLibraryPlaques(ctx, v);
    if (typeof world.drawLinks === 'function') {
      try { world.drawLinks(ctx, v); } catch (e) { /* ignore */ }
    }
    if (typeof world.drawOverlays === 'function') {
      try { world.drawOverlays(ctx, v); } catch (e) { /* optional world-level fx (fireworks, flying papers…) */ }
    }
    const list = st.overlayList;
    list.length = 0;
    const margin = 240 * u;
    const m = chars();
    if (m) {
      for (const ch of m.values()) {
        if (ch.state === 'gone' || typeof ch.drawOverlay !== 'function') continue;
        const sx = v.ox + ch.x * v.z, sy = v.oy + ch.y * v.z;
        if (sx < -margin || sx > st.W + margin || sy < -margin / 2 || sy > st.H + margin) continue;
        list.push(ch);
      }
    }
    list.sort((a, b) => a.y - b.y);
    layoutOverlays(list, v);
    let hov = null, sel = null;
    for (const ch of list) {
      if (ch.id === st.selected) { sel = ch; continue; }
      if (ch.id === st.hovered || ch.id === st.extHover) { hov = ch; continue; }
      try { ch.drawOverlay(ctx, v, false, false, ch.ovLift); } catch (e) { /* ignore */ }
    }
    try {
      if (hov) hov.drawOverlay(ctx, v, false, true, hov.ovLift);
      if (sel) sel.drawOverlay(ctx, v, true, sel.id === st.hovered, sel.ovLift);
    } catch (e) { /* ignore */ }
  }

  /** Small labelled plaques under the Bibliothèque shelves: one per linked repo (≤ 6) and « +N ». */
  function drawLibraryPlaques(ctx, v) {
    if (typeof office.libraryPlaques !== 'function') return;
    let list = null;
    try { list = office.libraryPlaques(); } catch (e) { list = null; }
    if (!list || !list.length || v.compact) return;
    const u = Math.max(1, Math.round(v.u * 0.75));
    const fs = Math.max(7, Math.round(v.fs * 0.75));
    ctx.save();
    ctx.font = st.fontReady ? fs + 'px "Silkscreen", monospace' : 'bold ' + fs + 'px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Two zig-zag rows: a plaque may use about twice the slot spacing before it would touch its neighbour.
    const room = Math.max(24, (10 * TILE() / 5) * 2 * v.z - 6 * u);
    const t = num(world.time);
    for (const p of list) {
      let text = String(p.text).toUpperCase();
      while (text.length > 3 && ctx.measureText(text).width + 6 * u > room) text = text.slice(0, -2) + '…';
      const w = Math.ceil(ctx.measureText(text).width) + 6 * u;
      const hgt = fs + 4 * u;
      const cx = Math.round(v.ox + p.x * v.z);
      const top = Math.round(v.oy + p.y * v.z);
      const x0 = Math.round(cx - w / 2);
      if (x0 > st.W || x0 + w < 0 || top > st.H || top + hgt < 0) continue;
      ctx.globalAlpha = p.dim ? 0.55 : (p.busy && !st.reduced && Math.floor(t * 3) % 2 ? 0.7 : 1);
      ctx.fillStyle = '#1A1012';
      ctx.fillRect(x0 - u, top - u, w + 2 * u, hgt + 2 * u + u);
      ctx.fillStyle = p.more ? '#3A2A18' : '#4A2F1C';
      ctx.fillRect(x0, top, w, hgt);
      ctx.fillStyle = p.color || '#C9A15C';
      ctx.fillRect(x0, top, w, u);
      ctx.fillStyle = '#2E1D12';
      ctx.fillRect(x0, top + hgt - u, w, u);
      ctx.fillStyle = p.more ? '#C9A15C' : '#F5ECD7';
      ctx.fillText(text, cx, top + hgt / 2 + (st.fontReady ? 0 : Math.round(u / 2)));
    }
    ctx.restore();
  }

  // Overlay de-cluttering: name tags + bubbles of characters standing close together are stacked
  // instead of drawn on top of each other. Boxes are measured with a no-op context, then placed
  // greedily (selected, hovered, then front-most characters keep their natural position) and each
  // character eases toward its lift so labels glide rather than jump.
  const NULL_CTX = {
    globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic',
    drawImage() {}, fillRect() {}, fillText() {}, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    arc() {}, save() {}, restore() {}, setLineDash() {}, measureText() { return { width: 0 }; }, clearRect() {}, closePath() {}, rect() {}
  };
  const placedBoxes = [];
  const layoutOrder = [];
  function layoutPrio(ch) { return ch.id === st.selected ? 2 : (ch.id === st.hovered || ch.id === st.extHover) ? 1 : 0; }
  function byLayout(a, b) { return layoutPrio(b) - layoutPrio(a) || b.y - a.y; }
  function layoutOverlays(list, v) {
    const tNow = now();
    const dt = st.lastLayout ? clamp((tNow - st.lastLayout) / 1000, 0, 0.1) : 0.1;
    st.lastLayout = tNow;
    const gap = v.u;
    const maxLift = 90 * v.u;
    layoutOrder.length = 0;
    for (let i = 0; i < list.length; i++) layoutOrder.push(list[i]);
    layoutOrder.sort(byLayout);
    placedBoxes.length = 0;
    for (const ch of layoutOrder) {
      NULL_CTX.globalAlpha = 1;
      let box = null;
      try { box = ch.drawOverlay(NULL_CTX, v, ch.id === st.selected, ch.id === st.hovered, 0); } catch (e) { box = null; }
      let target = 0;
      if (box) {
        for (let iter = 0; iter < 12; iter++) {
          let hit = null;
          for (const p of placedBoxes) {
            if (box.x0 < p.x1 && box.x1 > p.x0 && box.y0 - target < p.y1 && box.y1 - target > p.y0) { hit = p; break; }
          }
          if (!hit) break;
          target = box.y1 - hit.y0 + gap;
        }
        // Never push a stack off the top of the canvas (or absurdly high): overlap is better than clipping.
        if (target > maxLift || box.y0 - target < 0) target = 0;
        placedBoxes.push({ x0: box.x0, x1: box.x1, y0: box.y0 - target, y1: box.y1 - target });
      }
      const cur = typeof ch.ovLift === 'number' ? ch.ovLift : target;
      ch.ovLift = st.reduced ? target : cur + (target - cur) * Math.min(1, dt * 12);
      if (Math.abs(ch.ovLift - target) < 0.5) ch.ovLift = target;
    }
  }

  // ------------------------------------------------------------------ minimap
  const mini = {
    canvas: null, ctx: null, W: 0, H: 0, s: 1, ox: 0, oy: 0,
    stat: null, staticKey: '', acc: 1, ro: null, listeners: [], down: false
  };

  function miniResize() {
    const cv = mini.canvas;
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    const dpr = Math.max(0.5, Number(global.devicePixelRatio) || 1);
    const W = Math.max(1, Math.round((rect.width || 0) * dpr));
    const H = Math.max(1, Math.round((rect.height || 0) * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    mini.W = W; mini.H = H;
    mini.staticKey = '';
    mini.acc = 1;
  }

  function miniStatic() {
    const key = mini.W + 'x' + mini.H + '|' + (office && office.built ? 1 : 0);
    if (mini.stat && mini.staticKey === key) return mini.stat;
    const W = mini.W, H = mini.H;
    if (W < 4 || H < 4) return null;
    if (!mini.stat) mini.stat = doc.createElement('canvas');
    mini.stat.width = W; mini.stat.height = H;
    const g = mini.stat.getContext('2d');
    const s = Math.min(W / WW(), H / WH());
    mini.s = s;
    mini.ox = Math.round((W - WW() * s) / 2);
    mini.oy = Math.round((H - WH() * s) / 2);
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    const dw = Math.round(WW() * s), dh = Math.round(WH() * s);
    let drawn = false;
    if (office && typeof office.drawMinimap === 'function') {
      try {
        g.save();
        g.translate(mini.ox, mini.oy);
        g.imageSmoothingEnabled = false;
        office.drawMinimap(g, dw, dh);
        g.restore();
        drawn = true;
      } catch (err) { g.restore(); drawn = false; }
    }
    if (!drawn && office && office.base) {
      try {
        g.imageSmoothingEnabled = true;
        g.drawImage(office.base, mini.ox, mini.oy, dw, dh);
        drawn = true;
      } catch (e) { drawn = false; }
    }
    if (!drawn) {
      const T = TILE();
      const rooms = roomsList();
      const tones = ['#3b3f5c', '#41395a', '#35465a', '#4a3c3a', '#3a4a40', '#4a4636', '#3c3a52', '#4b3a48'];
      rooms.forEach((r, i) => {
        g.fillStyle = tones[i % tones.length];
        g.fillRect(mini.ox + num(r.x) * T * s, mini.oy + num(r.y) * T * s, Math.max(1, num(r.w) * T * s), Math.max(1, num(r.h) * T * s));
      });
    }
    mini.staticKey = key;
    return mini.stat;
  }

  function drawMinimap() {
    const g = mini.ctx;
    if (!g || mini.W < 4 || mini.H < 4) return;
    const stat = miniStatic();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, mini.W, mini.H);
    if (stat) g.drawImage(stat, 0, 0);
    const s = mini.s;
    const dpr = Math.max(1, Number(global.devicePixelRatio) || 1);
    const m = chars();
    if (m) {
      const r = Math.max(2, Math.round(1.6 * dpr));
      for (const ch of m.values()) {
        if (!alive(ch) || ch.alpha < 0.2) continue;
        const x = Math.round(mini.ox + ch.x * s), y = Math.round(mini.oy + (ch.y - 6) * s);
        const sel = ch.id === st.selected;
        const rr = sel ? r + Math.round(dpr) : r;
        g.fillStyle = '#0B0C13';
        g.fillRect(x - rr - 1, y - rr - 1, rr * 2 + 2, rr * 2 + 2);
        g.fillStyle = (ch.agent && ch.agent.color) || ch.color || '#D97757';
        g.fillRect(x - rr, y - rr, rr * 2, rr * 2);
        if (sel) {
          g.strokeStyle = '#FFFFFF';
          g.lineWidth = Math.max(1, Math.round(dpr));
          g.strokeRect(x - rr - 2.5, y - rr - 2.5, rr * 2 + 5, rr * 2 + 5);
        }
      }
    }
    // Camera rectangle (what the main view shows, HUD margins excluded).
    if (st.canvas && st.W > 2) {
      const z = st.cam.z;
      const vw = freeW() / z, vh = freeH() / z;
      const cx = st.cam.x + shiftX(z), cy = st.cam.y + shiftY(z);
      let x0 = mini.ox + (cx - vw / 2) * s, y0 = mini.oy + (cy - vh / 2) * s;
      let w = vw * s, h = vh * s;
      x0 = Math.max(1, x0); y0 = Math.max(1, y0);
      w = Math.min(mini.W - 1 - x0, w); h = Math.min(mini.H - 1 - y0, h);
      if (w > 2 && h > 2) {
        const lw = Math.max(1, Math.round(dpr));
        g.lineWidth = lw + 2;
        g.strokeStyle = 'rgba(11,12,19,.85)';
        g.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
        g.lineWidth = lw;
        g.strokeStyle = '#F5ECD7';
        g.strokeRect(Math.round(x0) + 0.5, Math.round(y0) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
      }
    }
  }

  function miniStep(dt) {
    if (!mini.canvas) return;
    mini.acc += dt;
    if (mini.acc < 0.1) return;
    mini.acc = 0;
    drawMinimap();
  }

  function miniPoint(e) {
    const rect = mini.canvas.getBoundingClientRect();
    const dpr = mini.W / Math.max(1, rect.width);
    const px = (e.clientX - rect.left) * dpr, py = (e.clientY - rect.top) * dpr;
    return { x: clamp((px - mini.ox) / (mini.s || 1), 0, WW()), y: clamp((py - mini.oy) / (mini.s || 1), 0, WH()) };
  }

  function miniGo(e, first) {
    const p = miniPoint(e);
    stopTourByUser();
    const c = st.cam;
    let z = c.tz !== null ? c.tz : c.z;
    if (first && z <= fitZoom() + 0.01) z = clamp(Math.max(2, Math.ceil(fitZoom() * 2)), minZoom(), maxZoom());
    st.follow = null;
    st.fitMode = false;
    const x = p.x - shiftX(z), y = p.y - shiftY(z);
    if (st.reduced || !first) {
      c.z = z; c.tz = null; c.x = x; c.y = y; c.tx = c.ty = null;
      clampCamera(c);
    } else {
      c.tz = z; c.tx = x; c.ty = y;
    }
    mini.acc = 1;
    if (!st.running) render();
  }

  function attachMinimap(canvas) {
    if (mini.canvas === canvas) return;
    mini.listeners.forEach((off) => off());
    mini.listeners = [];
    if (mini.ro) { try { mini.ro.disconnect(); } catch (e) { /* ignore */ } mini.ro = null; }
    mini.canvas = null;
    mini.ctx = null;
    if (!canvas || typeof canvas.getContext !== 'function') return;
    mini.canvas = canvas;
    mini.ctx = canvas.getContext('2d');
    if (canvas.style) canvas.style.touchAction = 'none';
    const L = mini.listeners;
    listen(canvas, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      mini.down = true;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      miniGo(e, true);
      e.preventDefault();
    }, undefined, L);
    listen(canvas, 'pointermove', (e) => { if (mini.down) miniGo(e, false); }, undefined, L);
    const up = (e) => {
      mini.down = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    };
    listen(canvas, 'pointerup', up, undefined, L);
    listen(canvas, 'pointercancel', up, undefined, L);
    if (typeof global.ResizeObserver === 'function') {
      mini.ro = new global.ResizeObserver(() => { miniResize(); drawMinimap(); });
      mini.ro.observe(canvas);
    }
    miniResize();
    drawMinimap();
  }

  // ------------------------------------------------------------------ hover tooltips (DOM, built with textContent only)
  const tip = { el: null, title: null, dot: null, name: null, sub: null, body: null, foot: null, sig: '', shown: false, roomId: null, roomSince: 0, occAt: 0, occ: '' };

  function ensureTip() {
    if (tip.el || !doc || !doc.body) return tip.el;
    const el = doc.createElement('div');
    el.className = 'game-tip';
    el.setAttribute('aria-hidden', 'true');
    el.hidden = true;
    const title = doc.createElement('div');
    title.className = 'game-tip-title';
    const dot = doc.createElement('span');
    dot.className = 'game-tip-dot';
    const name = doc.createElement('span');
    name.className = 'game-tip-name';
    title.append(dot, name);
    const sub = doc.createElement('div');
    sub.className = 'game-tip-sub';
    const body = doc.createElement('div');
    body.className = 'game-tip-body';
    const foot = doc.createElement('div');
    foot.className = 'game-tip-foot';
    el.append(title, sub, body, foot);
    doc.body.appendChild(el);
    Object.assign(tip, { el, title, dot, name, sub, body, foot });
    return el;
  }

  function hideTip() {
    if (tip.el && tip.shown) { tip.el.hidden = true; tip.shown = false; }
    tip.sig = '';
  }

  function fmtTok(n) {
    const v = Math.max(0, num(n));
    if (v < 1000) return String(Math.round(v));
    if (v < 999950) return (v / 1e3).toFixed(1).replace('.', ',') + ' k';
    return (v / 1e6).toFixed(1).replace('.', ',') + ' M';
  }

  const STATUS_FR = { starting: 'Démarre', working: 'Travaille', waiting: 'En attente', done: 'Terminé', error: 'Erreur', stopped: 'Arrêté' };

  function setTipText(node, text) {
    const v = String(text == null ? '' : text);
    if (node.textContent !== v) node.textContent = v;
    node.hidden = !v;
  }

  function showTip(kind, color, name, sub, body, foot) {
    if (!ensureTip()) return;
    const sig = kind + '|' + color + '|' + name + '|' + sub + '|' + body + '|' + foot;
    if (sig !== tip.sig) {
      tip.sig = sig;
      tip.el.dataset.kind = kind;
      tip.dot.style.background = color || 'transparent';
      tip.dot.hidden = !color;
      setTipText(tip.name, name);
      setTipText(tip.sub, sub);
      setTipText(tip.body, body);
      setTipText(tip.foot, foot);
    }
    if (!tip.shown) { tip.el.hidden = false; tip.shown = true; }
    placeTip();
  }

  function placeTip() {
    if (!tip.el || !tip.shown) return;
    const vw = global.innerWidth || 1024, vh = global.innerHeight || 768;
    const w = tip.el.offsetWidth || 220, h = tip.el.offsetHeight || 60;
    let x = st.ptr.cx + 18, y = st.ptr.cy + 18;
    if (x + w > vw - 8) x = st.ptr.cx - w - 14;
    if (y + h > vh - 8) y = st.ptr.cy - h - 14;
    x = clamp(x, 8, Math.max(8, vw - w - 8));
    y = clamp(y, 8, Math.max(8, vh - h - 8));
    tip.el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }

  function levelInfo(tokens) {
    const P = global.HQProgression;
    if (!P || typeof P.level !== 'function') return null;
    try { return P.level(tokens); } catch (e) { return null; }
  }

  function occupantsOf(roomId) {
    const names = [];
    const m = chars();
    if (!m) return '';
    for (const ch of m.values()) {
      if (!alive(ch) || ch.leaving || !ch.agent) continue;
      if (roomAtWorld(ch.x, ch.y - 2) === roomId) names.push(String(ch.agent.name || ch.id));
    }
    if (!names.length) return 'Personne ici pour l\'instant';
    names.sort((a, b) => a.localeCompare(b, 'fr'));
    const shown = names.slice(0, 6).join(', ');
    return 'Ici : ' + shown + (names.length > 6 ? ' +' + (names.length - 6) : '');
  }

  function tipStep(dt) {
    if (!st.canvas) return;
    if (!st.ptr.inside || st.ptr.down || st.ptr.dragging || st.ptr.touch || !ready()) { hideTip(); tip.roomId = null; return; }
    if (st.hovered) {
      tip.acc = (tip.acc || 0) - dt;
      if (tip.shown && tip.hid === st.hovered && tip.acc > 0) return;
      tip.acc = 0.2;
      tip.hid = st.hovered;
      const ch = getChar(st.hovered);
      const a = ch && ch.agent;
      if (!a) { hideTip(); return; }
      const tk = tokensTotal(a);
      const lv = levelInfo(tk);
      const status = a.interactive === true && a.status === 'waiting' ? 'T\'attend' : (STATUS_FR[a.status] || '');
      const sub = (lv ? 'Niv. ' + lv.level + ' · ' + lv.title : (a.kind === 'sub' ? 'Sous-agent' : 'Agent')) + (status ? ' · ' + status : '');
      const label = a.activity && a.activity.label ? String(a.activity.label) : '';
      showTip('agent', a.color || '', String(a.name || a.id), sub, label, fmtTok(tk) + ' tokens' + (a.kind === 'sub' && a.role ? ' · ' + a.role : ''));
      tip.roomId = null;
      return;
    }
    const w = screenToWorld(st.ptr.x, st.ptr.y);
    const id = roomAtWorld(w.x, w.y);
    if (id !== tip.roomId) {
      tip.roomId = id;
      tip.roomSince = 0;
      tip.occAt = 0;
      hideTip();
      return;
    }
    if (!id) { hideTip(); return; }
    tip.roomSince += dt;
    if (tip.roomSince < ROOM_TIP_DELAY) return;
    tip.occAt -= dt;
    if (tip.occAt <= 0) { tip.occAt = 0.5; tip.occ = occupantsOf(id); }
    const r = roomInfo(id);
    showTip('room', '', r && r.label ? String(r.label) : String(id), '', r && r.blurb ? String(r.blurb) : '', tip.occ);
  }

  // ------------------------------------------------------------------ input
  function pointerPos(e) {
    const rect = st.canvas.getBoundingClientRect();
    st.rect.left = rect.left; st.rect.top = rect.top;
    return { x: (e.clientX - rect.left) * st.dpr, y: (e.clientY - rect.top) * st.dpr, cx: e.clientX, cy: e.clientY };
  }
  function screenToWorld(x, y) {
    const c = st.cam;
    return { x: c.x + (x - st.W / 2) / c.z, y: c.y + (y - st.H / 2) / c.z };
  }
  function hitAt(x, y) {
    if (!world || typeof world.hitTest !== 'function') return null;
    const w = screenToWorld(x, y);
    const pad = Math.max(3, 6 / Math.max(0.5, st.cam.z / st.dpr));
    try { return world.hitTest(w.x, w.y, pad); } catch (e) { return null; }
  }
  function setCursor(c) { if (st.canvas && st.canvas.style && st.canvas.style.cursor !== c) st.canvas.style.cursor = c; }
  function setHover(id) {
    if (id === st.hovered) return;
    st.hovered = id;
    if (!st.ptr.dragging) setCursor(id ? 'pointer' : '');
    if (typeof st.onHover === 'function') { try { st.onHover(id); } catch (e) { /* host callback */ } }
  }
  function updateHover() {
    const id = hitAt(st.ptr.x, st.ptr.y);
    setHover(id);
    if (!id && !st.ptr.dragging && st.pets && typeof st.pets.hitTest === 'function') {
      const w = screenToWorld(st.ptr.x, st.ptr.y);
      setCursor(petHit(w.x, w.y) ? 'pointer' : '');
    }
  }

  function selectInternal(id) {
    st.selected = id;
    if (id) beginFollow(id);
    else fitCamera(false);
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    stopTourByUser();
    const p = pointerPos(e);
    Object.assign(st.ptr, { down: true, id: e.pointerId, sx: p.cx, sy: p.cy, lx: p.x, ly: p.y, x: p.x, y: p.y, cx: p.cx, cy: p.cy, dragging: false, inside: true, touch: e.pointerType === 'touch' });
    hideTip();
    try { if (st.canvas.setPointerCapture && e.pointerId !== undefined) st.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  }
  function onPointerMove(e) {
    const p = pointerPos(e);
    st.ptr.x = p.x; st.ptr.y = p.y; st.ptr.cx = p.cx; st.ptr.cy = p.cy; st.ptr.inside = true;
    st.ptr.touch = e.pointerType === 'touch';
    if (st.ptr.down) {
      if (!st.ptr.dragging && Math.hypot(p.cx - st.ptr.sx, p.cy - st.ptr.sy) > DRAG_THRESHOLD) {
        st.ptr.dragging = true;
        setCursor('grabbing');
      }
      if (st.ptr.dragging) {
        const c = st.cam;
        c.x -= (p.x - st.ptr.lx) / c.z;
        c.y -= (p.y - st.ptr.ly) / c.z;
        c.tx = c.ty = null;
        st.follow = null;
        st.fitMode = false;
        clampCamera(c);
      }
      st.ptr.lx = p.x; st.ptr.ly = p.y;
    } else {
      updateHover();
      placeTip();
    }
  }
  function onPointerUp(e) {
    if (!st.ptr.down) return;
    const wasDrag = st.ptr.dragging;
    st.ptr.down = false;
    st.ptr.dragging = false;
    try { if (st.canvas.releasePointerCapture && e.pointerId !== undefined) st.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    if (e.type === 'pointercancel') { setCursor(st.hovered ? 'pointer' : ''); return; }
    const p = pointerPos(e);
    if (!wasDrag) {
      const id = hitAt(p.x, p.y);
      if (id) {
        selectInternal(id);
        if (typeof st.onSelect === 'function') st.onSelect(id);
      } else {
        const w = screenToWorld(p.x, p.y);
        if (!petClick(w.x, w.y)) {
          const room = roomAtWorld(w.x, w.y);
          if (st.selected) {
            st.selected = null;
            st.follow = null;
            if (typeof st.onSelect === 'function') st.onSelect(null);
          }
          emit({ type: 'roomclick', id: room, x: w.x, y: w.y });
        }
      }
    }
    st.ptr.x = p.x; st.ptr.y = p.y;
    if (e.pointerType === 'touch') st.ptr.inside = false;
    updateHover();
    setCursor(st.hovered ? 'pointer' : '');
  }
  function onPointerLeave() {
    st.ptr.inside = false;
    if (!st.ptr.down) setHover(null);
    hideTip();
  }
  function onDblClick(e) {
    const p = pointerPos(e);
    if (hitAt(p.x, p.y)) return;
    stopTourByUser();
    fitCamera(false);
  }
  function onWheel(e) {
    e.preventDefault();
    stopTourByUser();
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 33;
    else if (e.deltaMode === 2) d *= 400;
    if (e.ctrlKey) d *= 3;
    st.wheelAcc += d;
    if (Math.abs(st.wheelAcc) < 50) return;
    const dir = st.wheelAcc < 0 ? 1 : -1;
    st.wheelAcc = 0;
    const z = st.cam.tz !== null ? st.cam.tz : st.cam.z;
    const fit = fitZoom();
    let nz = dir > 0 ? (isInt(z) ? Math.round(z) + 1 : Math.ceil(z)) : (isInt(z) ? Math.round(z) - 1 : Math.floor(z));
    if (dir < 0 && z > fit && nz < fit) nz = fit;
    nz = clamp(nz, minZoom(), maxZoom());
    if (nz <= 0 || nz === z) return;
    const p = pointerPos(e);
    zoomAt(nz, p.x, p.y);
  }
  function onVisibility() {
    if (doc.hidden) { stop(); hideTip(); }
    else { applyTimeOfDay(); start(); }
  }

  // ------------------------------------------------------------------ public API
  function init(canvas, callbacks) {
    if (!canvas || typeof canvas.getContext !== 'function') return;
    const cb = callbacks || {};
    st.onSelect = typeof cb.onSelect === 'function' ? cb.onSelect : null;
    st.onHover = typeof cb.onHover === 'function' ? cb.onHover : null;
    if (typeof cb.onEvent === 'function') evListeners.push(cb.onEvent);
    if (st.canvas === canvas) return;
    if (st.canvas) destroy();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    st.canvas = canvas;
    st.ctx = ctx;
    st.initAt = now();
    if (canvas.style) canvas.style.touchAction = 'none';
    if (office && typeof office.build === 'function') {
      try { office.build(); } catch (err) { logErr('office.build', err); }
    }
    if (world) {
      // characters.js may call world.onEvent(ev) (or this.emit → onEvent) for level-ups and scenes.
      if (typeof world.takeEvents !== 'function') world.onEvent = onWorldEvent;
    }
    try { st.charsPing = detectCharsPing(); } catch (e) { st.charsPing = false; }
    setupPets();
    applyTimeOfDay();
    // Reduced motion (system preference unless the host forced it).
    if (global.matchMedia) {
      try {
        st.mqReduced = global.matchMedia('(prefers-reduced-motion: reduce)');
        st.sysReduced = !!(st.mqReduced && st.mqReduced.matches);
        listen(st.mqReduced, 'change', (ev) => { st.sysReduced = !!ev.matches; applyReduced(); });
      } catch (e) { st.sysReduced = false; }
    }
    applyReduced();
    listen(canvas, 'pointerdown', onPointerDown);
    listen(canvas, 'pointermove', onPointerMove);
    listen(canvas, 'pointerup', onPointerUp);
    listen(canvas, 'pointercancel', onPointerUp);
    listen(canvas, 'pointerleave', onPointerLeave);
    listen(canvas, 'dblclick', onDblClick);
    listen(canvas, 'wheel', onWheel, { passive: false });
    if (doc) listen(doc, 'visibilitychange', onVisibility);
    if (typeof global.ResizeObserver === 'function') {
      st.ro = new global.ResizeObserver(() => resize());
      st.ro.observe(canvas);
    } else {
      listen(global, 'resize', resize);
    }
    if (doc && doc.fonts) {
      checkFonts();
      if (doc.fonts.ready && typeof doc.fonts.ready.then === 'function') doc.fonts.ready.then(checkFonts, () => {});
      listen(doc.fonts, 'loadingdone', checkFonts);
      // Canvas text does not trigger web-font downloads by itself: ask for the pixel font explicitly.
      if (typeof doc.fonts.load === 'function') doc.fonts.load('8px "Silkscreen"').then(checkFonts, () => {});
    }
    st.dpr = 0;
    resize();
    if (st.selected) beginFollow(st.selected);
    else fitCamera(true);
    st.inited = true;
    start();
  }

  function destroy() {
    stop();
    st.listeners.forEach((off) => off());
    st.listeners = [];
    if (st.ro) { try { st.ro.disconnect(); } catch (e) { /* ignore */ } st.ro = null; }
    if (st.mqDpr && st.mqDpr.removeEventListener) st.mqDpr.removeEventListener('change', onDprChange);
    st.mqDpr = null;
    st.canvas = null;
    st.ctx = null;
    hideTip();
  }

  function select(id) {
    if (id === null || id === undefined || id === '') {
      st.selected = null;
      st.follow = null;
      if (!st.tour.on) fitCamera(false);
      return;
    }
    if (typeof id !== 'string') return;
    stopTourByUser();
    st.selected = id;
    beginFollow(id);
  }

  function setViewInsets(ins) {
    const o = ins || {};
    const t = Math.max(0, num(o.top)), r = Math.max(0, num(o.right)), b = Math.max(0, num(o.bottom)), l = Math.max(0, num(o.left));
    if (t === st.ins.t && r === st.ins.r && b === st.ins.b && l === st.ins.l) return;
    st.ins.t = t; st.ins.r = r; st.ins.b = b; st.ins.l = l;
    if (!st.canvas) return;
    if (st.fitMode) fitCamera(false);
    else if (st.follow) { /* updateCamera re-centres the followed character in the new free area */ }
    else clampCamera(st.cam);
  }

  /** HQGame.drawAvatar: false when the sprite module is missing (the HUD then draws its own stand-in). */
  function drawAvatar(canvas, color, opts) {
    if (!S || typeof S.drawAvatar !== 'function') return false;
    S.drawAvatar(canvas, color, opts);
    return true;
  }

  global.HQGame = {
    init: safe(init),
    upsertAgent: safe((agent) => {
      if (!world || !agent || typeof agent !== 'object' || typeof agent.id !== 'string') return;
      const ch = typeof world.upsert === 'function' ? world.upsert(agent) : null;
      trackAgent(agent);
      if (ch && st.follow === ch.id && st.followZoomPending) beginFollow(ch.id);
    }),
    removeAgent: safe((id) => {
      if (!world || typeof id !== 'string') return;
      if (typeof world.remove === 'function') world.remove(id);
      st.testPending.delete(id);
      if (st.statuses.has(id)) {
        st.statuses.delete(id);
        st.levels.delete(id);
        if (!st.charsPing) ping('elevator');
      }
      if (st.hovered === id) setHover(null);
      if (st.extHover === id) st.extHover = null;
    }),
    log: safe((id, entry) => {
      if (!world || typeof id !== 'string' || !entry || typeof entry !== 'object') return;
      if (typeof world.flash === 'function') world.flash(id, entry);
      if (!st.charsPing && entry.type === 'tool' && entry.kind === 'bash') {
        const text = String(entry.text || '');
        if (GIT_RE.test(text)) ping('post');
        if (TEST_RE.test(text)) st.testPending.add(id);
      } else if (!st.charsPing && entry.type === 'tool_result' && st.testPending.has(id)) {
        st.testPending.delete(id);
        ping('tests', !FAIL_RE.test(String(entry.text || '') + ' ' + String(entry.detail || '').slice(0, 400)));
      }
    }),
    tokens: safe((id, delta) => {
      if (!world || typeof id !== 'string') return;
      if (typeof world.tokens === 'function') world.tokens(id, delta);
      // Fallback when characters.js does not hand out coins itself: one small handful from the character.
      if (typeof world.takeCoins !== 'function') {
        const ch = getChar(id);
        const v = num(delta);
        if (!ch || v <= 0) { if (v > 0) coinArrived(v); return; }
        const n = clamp(1 + Math.floor(Math.log10(Math.max(1, v)) / 1.5), 1, 4);
        for (let i = 0; i < n; i++) spawnCoin(ch.x, ch.y - 14, v / n, i * 0.07);
      }
    }),
    select: safe(select),
    drawAvatar,
    setReducedMotion: safe((on) => { st.userReduced = !!on; applyReduced(); }),
    // Linked library repos (Library object from the server): books + plaques in the Bibliothèque room.
    setLibrary: safe((lib) => { if (office && typeof office.setLibrary === 'function') office.setLibrary(lib); }),
    // GAME2 §3 additions
    attachMinimap: safe(attachMinimap),
    setTour: safe((on) => { setTour(on); return st.tour.on; }),
    isTouring: () => st.tour.on,
    setSound: safe((on) => setSound(on)),
    isSoundOn: () => snd.on,
    setCoinTarget: safe((fn) => { st.coinTarget = typeof fn === 'function' ? fn : null; }),
    onEvent: (cb) => {
      if (typeof cb !== 'function') return () => {};
      evListeners.push(cb);
      return () => { const i = evListeners.indexOf(cb); if (i >= 0) evListeners.splice(i, 1); };
    },
    focusRoom: safe((id) => { stopTourByUser(); return focusRoom(id); }),
    rooms: safe(() => roomsList().map((r) => ({ id: r.id, label: r.label || r.id, blurb: r.blurb || '' }))),
    worldSize: () => ({ w: WW(), h: WH() }),
    // Extras (not in the contract, harmless for other callers):
    setViewInsets: safe(setViewInsets),
    highlight: safe((id) => { st.extHover = typeof id === 'string' && id ? id : null; }),
    playSound: safe((name) => sfx(String(name))),
    setTimeOverride: safe((h) => { st.timeOverride = h === null || h === undefined || h === '' ? null : clamp(num(h), 0, 24); applyTimeOfDay(); }),
    fit: safe(() => { stopTourByUser(); st.follow = null; fitCamera(false); }),
    // Debug hooks (headless checks): force a time of day (null = local clock) and peek at the live objects.
    _debugTime: safe((h) => { st.timeOverride = h === null || h === undefined || h === '' ? null : clamp(num(h), 0, 24); applyTimeOfDay(); return st.hours; }),
    _debug: () => ({ office, world, pets: st.pets, cam: st.cam, selected: st.selected }),
    destroy: safe(destroy),
    isReady: () => !!st.canvas && ready()
  };
})(typeof window !== 'undefined' ? window : globalThis);
