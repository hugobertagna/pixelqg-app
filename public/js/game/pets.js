/* PixelQG — pets.js
 * Office pets: Biscuit, a small pixel cat that wanders on walkable tiles, naps on the couches, sometimes follows
 * the selected agent and purrs (hearts) when clicked; and a robot vacuum that leaves its dock at night to roam
 * the floors. Sprites are tiny ASCII bitmaps rendered once into cached canvases (via HQSprites helpers).
 * Exposes window.HQPets = { create(office, world), Pets }. The engine owns the instance:
 *   pets.update(dt, { selectedId, selected, hours, reduced }) · pets.list() → drawables { id, x, y, sortY, draw(ctx, t, reduced) }
 *   pets.hitTest(wx, wy) → pet name | null · pets.click(wx, wy) → { id, name } | null · pets.setTimeOfDay(h)
 */
(function (global) {
  'use strict';

  const S = global.HQSprites;
  const T = 16;

  let seed = 7;
  function rand() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
  function randInt(a, b) { return a + Math.floor(rand() * (b - a + 1)); }
  function dist(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return Math.sqrt(dx * dx + dy * dy); }

  // ------------------------------------------------------------------ sprites
  const CAT_COLORS = { b: '#E8A35C', d: '#B8743A', w: '#F7EBDD', k: '#2A1F1A', p: '#F2A0A8' };
  const CAT_OUTLINE = '#3A2416';
  const CAT = {
    walk0: ['...........b.b', '..........bbbb', '.d........bkbk', 'd.........bbpb', 'd.bbdbbdbbbww.', '.dbbbbbbbbbb..', '..bbdbbdbbb...', '..w.b....w.b..'],
    walk1: ['...........b.b', '..........bbbb', '.d........bkbk', 'd.........bbpb', 'd.bbdbbdbbbww.', '.dbbbbbbbbbb..', '..bbdbbdbbb...', '...wb.....wb..'],
    sit: ['.b...b...', '.bbbbb...', '.bkbkb...', '.bbpbb...', '..www....', '.bbbbb...', 'bbdbdbb..', 'bbbbbbbdd', '.ww.ww...'],
    sitTail: ['.b...b...', '.bbbbb...', '.bkbkb...', '.bbpbb...', '..www....', '.bbbbb..d', 'bbdbdbb.d', 'bbbbbbbd.', '.ww.ww...'],
    purr: ['.b...b...', '.bbbbb...', '.bbbbb...', '.kbpbk...', '..www....', '.bbbbb...', 'bbdbdbb..', 'bbbbbbbdd', '.ww.ww...'],
    sleep: ['..b.b......', '.bbbbbdbdb.', 'bbkbbbbbbbd', 'bbbbdbbdbbd', '.bbbbbbbbdd', '..ddddddd..']
  };
  const VAC = {
    rows: ['..gggggg..', '.ghhhhhhg.', 'gllllllllg', 'gllllllllg', '.gddddddg.', '..gggggg..'],
    colors: { g: '#2A2D3A', h: '#8A90A6', l: '#6E7489', d: '#4A4F60' }
  };
  const DOCK = {
    rows: ['.kkkkkkkkkk.', 'kssssssssssk', 'kkkkkkkkkkkk'],
    colors: { k: '#2A2D3A', s: '#3F4558' }
  };

  const cache = new Map();
  function sprite(key, rows, colors, outline, mirror) {
    const k = key + (mirror ? '|m' : '');
    let v = cache.get(k);
    if (v === undefined) {
      v = null;
      if (S && typeof S.fromRows === 'function') {
        const buf = S.fromRows(rows, colors, outline);
        if (mirror) buf.mirror();
        const img = buf.toCanvas();
        if (img) v = { img, w: buf.w, h: buf.h };
      }
      cache.set(k, v);
    }
    return v;
  }

  function drawShadow(ctx, x, y, w) {
    ctx.fillStyle = 'rgba(6,6,14,0.3)';
    ctx.fillRect(x - (w >> 1) + 1, y - 1, w - 2, 1);
    ctx.fillRect(x - (w >> 1), y, w, 1);
  }

  // ------------------------------------------------------------------ office helpers
  function roomsList(off) {
    const r = off && off.rooms;
    if (!r) return [];
    return Array.isArray(r) ? r.filter(Boolean) : Object.keys(r).map((k) => r[k]).filter(Boolean);
  }
  function getRoom(off, id) {
    const list = roomsList(off);
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function rectOf(room) {
    if (!room) return null;
    if (room.rect) return room.rect;
    if (typeof room.x === 'number' && typeof room.w === 'number') return { x: room.x, y: room.y, w: room.w, h: room.h };
    return null;
  }
  function cols(off) { return off.cols || Math.round((off.width || 0) / T) || 1; }
  function rows(off) { return off.rows || Math.round((off.height || 0) / T) || 1; }
  function walkPx(off, x, y) {
    try { return off.isWalkable(Math.floor(x / T), Math.floor(y / T)); } catch (e) { return false; }
  }
  /** A small body box fits at feet (x, y). */
  function fits(off, x, y, r) {
    return walkPx(off, x - r, y - 3) && walkPx(off, x + r, y - 3) && walkPx(off, x - r, y + 1) && walkPx(off, x + r, y + 1);
  }
  function randomTileIn(off, rect) {
    for (let i = 0; i < 14; i++) {
      const x = rect ? rect.x + randInt(0, rect.w - 1) : randInt(0, cols(off) - 1);
      const y = rect ? rect.y + randInt(0, rect.h - 1) : randInt(0, rows(off) - 1);
      if (off.isWalkable(x, y) && !(typeof off.isDoorway === 'function' && off.isDoorway(x, y))) return { x, y };
    }
    const c = rect ? { x: rect.x + (rect.w >> 1), y: rect.y + (rect.h >> 1) } : { x: cols(off) >> 1, y: rows(off) >> 1 };
    return off.nearestWalkable(c.x, c.y);
  }
  function randomRoomTile(off, exclude) {
    const list = roomsList(off).filter((r) => rectOf(r) && (!exclude || exclude.indexOf(r.id) < 0));
    const room = list.length ? list[randInt(0, list.length - 1)] : null;
    return randomTileIn(off, rectOf(room));
  }

  /** Feet-position waypoints along an A* path, smoothed when characters.js offers string pulling. */
  function planPath(off, fromX, fromY, tile) {
    const st = off.worldToTile(fromX, fromY);
    let tiles = null;
    try { tiles = off.findPath(st.x, st.y, tile.x, tile.y); } catch (e) { tiles = null; }
    if (!tiles || !tiles.length) return null;
    const pts = [{ x: fromX, y: fromY }];
    for (let i = 1; i < tiles.length; i++) pts.push(off.tileCenter(tiles[i].x, tiles[i].y));
    if (pts.length === 1) pts.push(off.tileCenter(tile.x, tile.y));
    const C = global.HQCharacters;
    return C && typeof C.smoothPath === 'function' ? C.smoothPath(off, pts) : pts.slice(1);
  }

  // ------------------------------------------------------------------ cat
  function Cat(pets) {
    this.pets = pets;
    this.id = 'cat';
    this.name = 'Biscuit';
    const off = pets.office;
    const start = randomTileIn(off, rectOf(getRoom(off, 'cafe') || getRoom(off, 'lobby') || getRoom(off, 'entrance'))) || { x: 2, y: 2 };
    const p = off.tileCenter(start.x, start.y);
    this.x = p.x; this.y = p.y; this.sortY = p.y;
    this.face = 1;
    this.state = 'sit';       // sit | walk | groom | sleep | purr
    this.after = 'sit';
    this.until = 2 + rand() * 3;
    this.path = null; this.pi = 0; this.speed = 1.6 * T; this.walkDist = 0;
    this.followId = null; this.followUntil = 0; this.repathAt = 0;
    this.lastSelected = null;
    this.sleepTile = null;
    this.heartAt = 0;
    this.localHearts = [];
  }

  Cat.prototype.goTo = function (tile, after, speedTiles) {
    const path = tile ? planPath(this.pets.office, this.x, this.y, tile) : null;
    if (!path || !path.length) { this.state = after || 'sit'; this.until = this.pets.time + 2 + rand() * 3; return false; }
    this.path = path; this.pi = 0;
    this.state = 'walk';
    this.after = after || 'sit';
    this.speed = (speedTiles || 1.6) * T;
    return true;
  };

  Cat.prototype.couchTile = function () {
    const off = this.pets.office;
    const cands = [];
    for (const id of ['cafe', 'terrace', 'lobby']) {
      const room = getRoom(off, id);
      if (!room || !Array.isArray(room.spots)) continue;
      for (const s of room.spots) {
        const pose = s.pose;
        if ((pose === 'sit' || pose === 'couch') && !off.isReservedByOther(s.x, s.y, 'pet:cat')) cands.push(s);
      }
    }
    if (cands.length) { const s = cands[randInt(0, cands.length - 1)]; return { x: s.x, y: s.y }; }
    return randomTileIn(off, rectOf(getRoom(off, 'cafe') || getRoom(off, 'terrace')));
  };

  Cat.prototype.decide = function (ctx) {
    const t = this.pets.time, night = this.pets.isNight();
    const sel = ctx && ctx.selected && ctx.selected.state !== 'gone' ? ctx.selected : null;
    const r = rand();
    if (sel && r < 0.3) { this.followId = sel.id; this.followUntil = t + 12 + rand() * 10; this.repathAt = 0; this.state = 'sit'; this.until = t + 0.1; return; }
    if (r < (night ? 0.65 : 0.4)) { this.sleepTile = this.couchTile(); this.goTo(this.sleepTile, 'sleep', 1.4); return; }
    if (r < 0.85) {
      const near = rand() < 0.5;
      const tile = near ? randomTileIn(this.pets.office, { x: Math.floor(this.x / T) - 6, y: Math.floor(this.y / T) - 4, w: 13, h: 9 }) : randomRoomTile(this.pets.office, ['servers']);
      this.goTo(tile, rand() < 0.4 ? 'groom' : 'sit', rand() < 0.12 ? 3.6 : 1.6);   // sometimes the zoomies
      return;
    }
    this.state = rand() < 0.5 ? 'groom' : 'sit';
    this.until = t + 3 + rand() * 4;
  };

  Cat.prototype.update = function (dt, ctx) {
    const pets = this.pets, t = pets.time, off = pets.office;
    if (this.state === 'purr') {
      if (t >= this.heartAt) { this.heartAt = t + (pets.reduced ? 1.2 : 0.45); pets.hearts(this.x, this.y - 10, 1); }
      if (t >= this.until) { this.state = 'sit'; this.until = t + 1.5 + rand() * 2; }
      return;
    }
    // Selection changed: the cat may come and see.
    const selId = ctx ? ctx.selectedId : null;
    if (selId !== this.lastSelected) {
      this.lastSelected = selId;
      if (selId && ctx.selected && rand() < 0.5) { this.followId = selId; this.followUntil = t + 12 + rand() * 10; this.repathAt = 0; }
      else if (!selId) this.followId = null;
    }
    if (this.followId) {
      const ch = ctx && ctx.selected && ctx.selected.id === this.followId && ctx.selected.state !== 'gone' ? ctx.selected : null;
      if (!ch || t > this.followUntil) { this.followId = null; }
      else if (t >= this.repathAt && this.state !== 'sleep') {
        this.repathAt = t + 1.5;
        if (dist(ch.x, ch.y, this.x, this.y) > 2.2 * T) {
          const ct = off.worldToTile(ch.x, ch.y);
          const side = this.x < ch.x ? -1 : 1;
          const tile = off.nearestWalkable(ct.x + side, ct.y + 1) || ct;
          this.goTo(tile, 'sit', 2.6);
        }
      }
    }
    if (this.state === 'walk') {
      let budget = this.speed * dt;
      while (budget > 0 && this.path && this.pi < this.path.length) {
        const p = this.path[this.pi];
        const dx = p.x - this.x, dy = p.y - this.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (Math.abs(dx) > 0.5) this.face = dx > 0 ? 1 : -1;
        if (d <= budget) { this.x = p.x; this.y = p.y; budget -= d; this.walkDist += d; this.pi++; }
        else { this.x += (dx / d) * budget; this.y += (dy / d) * budget; this.walkDist += budget; budget = 0; }
      }
      if (!this.path || this.pi >= this.path.length) {
        this.path = null;
        this.state = this.after;
        this.until = t + (this.state === 'sleep' ? 15 + rand() * 20 : 2.5 + rand() * 4);
      }
    } else {
      if (this.state === 'sleep' && this.sleepTile && off.isReservedByOther(this.sleepTile.x, this.sleepTile.y, 'pet:cat')) {
        // Someone wants this seat: stretch and leave.
        const ct = off.worldToTile(this.x, this.y);
        if (ct.x === this.sleepTile.x && ct.y === this.sleepTile.y) { this.sleepTile = null; this.until = t; }
      }
      if (t >= this.until && !this.followId) this.decide(ctx);
      else if (t >= this.until) { this.state = 'sit'; this.until = t + 1.5; }
    }
    this.sortY = this.y;
    if (this.localHearts.length) {
      let j = 0;
      for (let i = 0; i < this.localHearts.length; i++) { const h = this.localHearts[i]; h.life += dt; h.y -= 14 * dt; if (h.life < 1.2) this.localHearts[j++] = h; }
      this.localHearts.length = j;
    }
  };

  Cat.prototype.purr = function () {
    const t = this.pets.time;
    this.state = 'purr';
    this.until = t + 2.6;
    this.heartAt = t;
    this.path = null;
    this.followId = null;
  };

  Cat.prototype.draw = function (ctx, t, reduced) {
    const mir = this.face < 0;
    let spr;
    if (this.state === 'walk') spr = sprite('cat-walk' + (Math.floor(this.walkDist / 3) % 2), Math.floor(this.walkDist / 3) % 2 ? CAT.walk1 : CAT.walk0, CAT_COLORS, CAT_OUTLINE, mir);
    else if (this.state === 'sleep') spr = sprite('cat-sleep', CAT.sleep, CAT_COLORS, CAT_OUTLINE, mir);
    else if (this.state === 'purr' || (this.state === 'groom' && Math.floor(t * 1.5) % 2)) spr = sprite('cat-purr', CAT.purr, CAT_COLORS, CAT_OUTLINE, false);
    else spr = !reduced && (t % 4) < 0.5 ? sprite('cat-sit-tail', CAT.sitTail, CAT_COLORS, CAT_OUTLINE, false) : sprite('cat-sit', CAT.sit, CAT_COLORS, CAT_OUTLINE, false);
    const fx = Math.round(this.x), fy = Math.round(this.y);
    drawShadow(ctx, fx, fy, 10);
    if (spr) ctx.drawImage(spr.img, fx - (spr.w >> 1), fy - spr.h + 1 - (this.state === 'purr' && !reduced ? Math.floor(t * 6) % 2 : 0));
    if (this.state === 'sleep' && !reduced) {
      // Tiny z's drifting up.
      const a0 = ctx.globalAlpha;
      for (let k = 0; k < 2; k++) {
        const q = (t * 0.5 + k * 0.5) % 1;
        ctx.globalAlpha = a0 * (1 - q);
        ctx.fillStyle = '#E8E6FF';
        const zx = fx + 4 + Math.round(q * 5), zy = fy - 10 - Math.round(q * 9);
        ctx.fillRect(zx, zy, 3, 1); ctx.fillRect(zx + 1, zy + 1, 1, 1); ctx.fillRect(zx, zy + 2, 3, 1);
      }
      ctx.globalAlpha = a0;
    }
    for (const h of this.localHearts) {
      ctx.fillStyle = '#E5534B';
      const hx = Math.round(h.x), hy = Math.round(h.y);
      ctx.fillRect(hx - 1, hy, 1, 1); ctx.fillRect(hx + 1, hy, 1, 1); ctx.fillRect(hx - 1, hy + 1, 3, 1); ctx.fillRect(hx, hy + 2, 1, 1);
    }
  };

  // ------------------------------------------------------------------ robot vacuum
  function Vacuum(pets) {
    this.pets = pets;
    this.id = 'vacuum';
    this.name = 'Robot aspirateur';
    const off = pets.office;
    const room = getRoom(off, 'cafe') || getRoom(off, 'lobby') || getRoom(off, 'entrance');
    const r = rectOf(room);
    const dock = (r && off.nearestWalkable(r.x, r.y + r.h - 1)) || off.nearestWalkable(1, rows(off) - 2) || { x: 1, y: 1 };
    this.dock = dock;
    const p = off.tileCenter(dock.x, dock.y);
    this.dockX = p.x; this.dockY = p.y;
    this.x = p.x; this.y = p.y; this.sortY = p.y - 2;
    this.state = 'docked';     // docked | roam | return
    this.angle = 0;
    this.turnAt = 0;
    this.wakeAt = 0;
    this.path = null; this.pi = 0;
    this.spin = 0;
  }

  Vacuum.prototype.update = function (dt) {
    const pets = this.pets, t = pets.time, off = pets.office;
    const night = pets.isNight();
    this.spin = Math.max(0, this.spin - dt);
    if (this.state === 'docked') {
      if (night && t >= this.wakeAt) { this.state = 'roam'; this.angle = rand() * Math.PI * 2; this.turnAt = t + 5 + rand() * 6; }
    } else if (this.state === 'roam') {
      if (!night) {
        this.path = planPath(off, this.x, this.y, this.dock);
        this.pi = 0;
        this.state = this.path ? 'return' : 'docked';
        if (!this.path) { this.x = this.dockX; this.y = this.dockY; }
      } else {
        if (t >= this.turnAt) { this.angle += (rand() - 0.5) * 2.2; this.turnAt = t + 5 + rand() * 6; }
        const v = 1.1 * T * dt;
        const nx = this.x + Math.cos(this.angle) * v, ny = this.y + Math.sin(this.angle) * v;
        if (fits(off, nx, ny, 5)) { this.x = nx; this.y = ny; }
        else {
          // Bump: try a few new headings.
          let ok = false;
          for (let k = 0; k < 8 && !ok; k++) {
            const a = rand() * Math.PI * 2;
            if (fits(off, this.x + Math.cos(a) * 6, this.y + Math.sin(a) * 6, 5)) { this.angle = a; ok = true; }
          }
          if (!ok && !fits(off, this.x, this.y, 5)) { this.x = this.dockX; this.y = this.dockY; }
        }
      }
    } else if (this.state === 'return') {
      let budget = 1.4 * T * dt;
      while (budget > 0 && this.path && this.pi < this.path.length) {
        const p = this.path[this.pi];
        const dx = p.x - this.x, dy = p.y - this.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > 0.01) this.angle = Math.atan2(dy, dx);
        if (d <= budget) { this.x = p.x; this.y = p.y; budget -= d; this.pi++; }
        else { this.x += (dx / d) * budget; this.y += (dy / d) * budget; budget = 0; }
      }
      if (!this.path || this.pi >= this.path.length) {
        this.path = null; this.x = this.dockX; this.y = this.dockY;
        this.state = 'docked';
        this.wakeAt = t + 20;
      }
    }
    this.sortY = this.y - 2;
  };

  Vacuum.prototype.bip = function () {
    this.spin = 0.6;
    this.angle += Math.PI;
    if (this.state === 'docked' && this.pets.isNight()) this.wakeAt = this.pets.time;
  };

  Vacuum.prototype.drawDock = function (ctx) {
    const dock = sprite('dock', DOCK.rows, DOCK.colors, null, false);
    if (dock) ctx.drawImage(dock.img, Math.round(this.dockX) - (dock.w >> 1), Math.round(this.dockY) - 1);
  };

  Vacuum.prototype.draw = function (ctx, t, reduced) {
    const fx = Math.round(this.x), fy = Math.round(this.y);
    const spr = sprite('vacuum', VAC.rows, VAC.colors, '#14151F', false);
    drawShadow(ctx, fx, fy + 1, 10);
    if (spr) ctx.drawImage(spr.img, fx - (spr.w >> 1), fy - spr.h + 2);
    // LED (green while charging / blue while cleaning) and brushes.
    const docked = this.state === 'docked';
    const on = reduced || Math.floor(t * (docked ? 1 : 3)) % 2 === 0;
    ctx.fillStyle = on ? (docked ? '#6CC28A' : '#6AA9FF') : '#2A2D3A';
    const lx = fx + Math.round(Math.cos(this.angle) * 3), ly = fy - 5 + Math.round(Math.sin(this.angle) * 1);
    ctx.fillRect(lx, ly, 1, 1);
    if (!docked && !reduced) {
      const b = Math.floor(t * 12 + this.spin * 30) % 2;
      ctx.fillStyle = '#A0A7B8';
      ctx.fillRect(fx - 6 + b, fy, 1, 1);
      ctx.fillRect(fx + 5 - b, fy, 1, 1);
    }
  };

  // ------------------------------------------------------------------ manager
  function Pets(office, world) {
    this.office = office;
    this.world = world || null;
    this.time = 0;
    this.reduced = false;
    this.events = [];
    this.onEvent = null;
    const d = new Date();
    this.hours = d.getHours() + d.getMinutes() / 60;
    this.cat = null;
    this.vacuum = null;
    this._list = [];
    try { this.cat = new Cat(this); this._list.push(this.cat); } catch (e) { this.cat = null; }
    try {
      this.vacuum = new Vacuum(this);
      const v = this.vacuum;
      // The charging dock is floor-level: its own drawable, sorted under everything standing near it.
      this._list.push({ id: 'dock', x: v.dockX, y: v.dockY, sortY: v.dockY - 14, draw: (ctx) => v.drawDock(ctx) });
      this._list.push(v);
    } catch (e) { this.vacuum = null; }
  }

  Pets.prototype.isNight = function () { return this.hours >= 21 || this.hours < 6.5; };
  Pets.prototype.setTimeOfDay = function (h) { const n = Number(h); if (isFinite(n)) this.hours = ((n % 24) + 24) % 24; };

  Pets.prototype.update = function (dt, ctx) {
    dt = Math.max(0, Math.min(0.25, Number(dt) || 0));
    this.time += dt;
    if (ctx) {
      if (typeof ctx.reduced === 'boolean') this.reduced = ctx.reduced;
      if (typeof ctx.hours === 'number' && isFinite(ctx.hours)) this.hours = ctx.hours;
    }
    if (this.cat) this.cat.update(dt, ctx || null);
    if (this.vacuum) this.vacuum.update(dt);
  };

  /** Drawables for the engine's depth sort. */
  Pets.prototype.list = function () { return this._list; };
  /** Fallback when the engine does not depth-sort pets. */
  Pets.prototype.draw = function (ctx, t, reduced) { for (const p of this._list) p.draw(ctx, t, reduced); };

  Pets.prototype._hit = function (wx, wy) {
    const c = this.cat;
    if (c && wx >= c.x - 8 && wx <= c.x + 8 && wy >= c.y - 12 && wy <= c.y + 2) return c;
    const v = this.vacuum;
    if (v && wx >= v.x - 7 && wx <= v.x + 7 && wy >= v.y - 7 && wy <= v.y + 3) return v;
    return null;
  };
  /** Pet name under a world point, or null. */
  Pets.prototype.hitTest = function (wx, wy) { const p = this._hit(wx, wy); return p ? p.name : null; };

  /** Click on a pet: the cat purrs (hearts), the vacuum bips and turns around. Returns { id, name } or null. */
  Pets.prototype.click = function (wx, wy) {
    const p = this._hit(wx, wy);
    if (!p) return null;
    if (p === this.cat) this.cat.purr();
    else { this.vacuum.bip(); this.hearts(p.x, p.y - 8, 1); }
    return { id: p.id, name: p.name };
  };

  Pets.prototype.hearts = function (x, y, n) {
    const w = this.world;
    if (w && typeof w.hearts === 'function') { w.hearts(x, y, n); return; }
    if (this.cat && this.cat.localHearts.length < 12) this.cat.localHearts.push({ x: x + (rand() - 0.5) * 6, y, life: 0 });
  };

  global.HQPets = {
    Pets,
    create: (office, world) => (office && typeof office.isWalkable === 'function' ? new Pets(office, world) : null)
  };
})(typeof window !== 'undefined' ? window : globalThis);
