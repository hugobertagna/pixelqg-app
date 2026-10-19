/* PixelQG — characters.js
 * Character entities built from Agent objects: where they want to be (activity -> room, status overrides,
 * thinking keeps them in place, dwell before leaving a room), 8-direction movement along string-pulled A*
 * paths with acceleration, poses and carried / used items, emotes, scenes (delegation hand-over, idle chats),
 * level-ups (fireworks + "NIVEAU N !"), coins handed to the engine, world-space drawing (shadow, ring, sprite,
 * items) and screen-space overlays (name tag with level badge, bubbles, emotes, token popups, sub -> parent links,
 * selection spotlight, fireworks, flying papers).
 * Exposes window.HQCharacters ({ World, Character, desireOf, smoothPath, clearLine, formatTokens, truncate, … }).
 */
(function (global) {
  'use strict';

  const S = global.HQSprites;
  const P = global.HQProgression || null;
  const T = 16;
  const SPEED = 3.6 * T;          // cruise speed, world px per second
  const ACCEL = 10 * T;           // px/s² (start and brake)
  const DEBOUNCE = 1.2;           // s a new destination must hold before the character changes room
  const ACCUM = 1.8;              // s of cumulative wanting (while flickering) after which the latest desire wins
  const DWELL = 2.5;              // s a character stays in a room before leaving it (status changes excepted)
  const BUBBLE_TIME = 4;          // s the activity label stays in a speech bubble
  const LABEL_MAX = 28;
  const TEST_RE = /test|jest|vitest|pytest|mocha|spec|lint|tsc|build|compile/i;
  const GIT_RE = /\bgit\b|commit|push|pull|merge|rebase/i;
  const GIT_CMD_RE = /\bgit\b/i;
  const FAIL_RE = /\b(?:fail(?:ed|ure|s)?|error|erreur|échec|echec)\b|✗/i;
  const TOOL_KINDS = { read: 1, search: 1, edit: 1, write: 1, bash: 1, web: 1, task: 1, todo: 1, tool: 1 };
  const EMPTY = Object.freeze([]);

  /** activity.kind -> destination ("desk" = home desk, "keep" = think where you are, "stay" = freeze). */
  const KIND_ROOM = {
    edit: 'desk', write: 'desk', talk: 'desk', think: 'keep',
    read: 'library', search: 'library', bash: 'servers', web: 'web', tool: 'web',
    task: 'meeting', todo: 'meeting', done: 'cafe', idle: 'cafe', error: 'stay'
  };
  /** Rooms that may be missing from an older map, and where to go instead. */
  const ROOM_FALLBACK = {
    tests: ['servers'], post: ['servers'], terrace: ['cafe'], cafe: ['terrace'], lobby: ['entrance'], entrance: ['lobby'],
    lounge: ['cafe', 'terrace'], open: [], library: ['open'], servers: ['open'], web: ['servers', 'open'], meeting: ['open']
  };
  /** Item used at the destination (items carried on the way are their "closed" forms). */
  const ROOM_ITEM = { library: 'bookopen', servers: 'laptop', tests: 'laptop', post: 'letter', web: 'tablet', meeting: 'marker', cafe: 'mug', terrace: 'mug', lounge: 'mug' };
  const POSE_ALIAS = { browse: 'read', terminal: 'rack', whiteboard: 'board', couch: 'sit' };
  const DIR8 = ['right', 'downright', 'down', 'downleft', 'left', 'upleft', 'up', 'upright'];
  const CHAT_ICONS = ['dots', 'note', 'heart', 'mug', 'sparkle', 'question', 'exclaim', 'lightbulb', 'thumb', 'coin', 'star'];
  const GREET_MEETING = [['p', 'dots', 0], ['s', 'paper', 1.05], ['p', 'thumb', 2.1]];
  const GREET_SHORT = [['p', 'thumb', 0.1]];
  const FIREWORK_COLORS = ['#FFD84A', '#FFFFFF', '#E0709B', '#4FC1B9', '#8E9BF0', '#6CC28A'];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }

  /** "+850", "+1,2k", "+12k", "+1,5M" (French decimal comma). */
  function formatTokens(n) {
    n = Math.max(0, Math.round(Number(n) || 0));
    const fr = (v) => String(v).replace('.', ',');
    if (n < 1000) return '+' + n;
    const k = Math.round(n / 100) / 10;
    if (k < 1000) return '+' + fr(k >= 100 ? Math.round(k) : k) + 'k';
    const m = Math.round(n / 1e5) / 10;
    return '+' + fr(m >= 100 ? Math.round(m) : m) + 'M';
  }

  function truncate(text, max) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    const m = max || LABEL_MAX;
    return s.length > m ? s.slice(0, m - 1).trimEnd() + '…' : s;
  }

  function hashStr(s) {
    let h = 2166136261;
    const str = String(s);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function tokensOf(agent) {
    const t = agent && agent.tokens;
    if (!t) return 0;
    return num(t.total) || num(t.input) + num(t.output) + num(t.cacheRead) + num(t.cacheWrite);
  }
  function levelOf(tokens) {
    if (P && typeof P.levelOf === 'function') return P.levelOf(tokens);
    if (P && typeof P.level === 'function') return P.level(tokens).level;
    return 0;
  }
  function titleOf(lvl) {
    if (P && typeof P.titleOf === 'function') return P.titleOf(lvl);
    return '';
  }

  /** bash label -> room: an explicit git command wins, then tests/builds, then other git words. */
  function bashRoom(label) {
    if (GIT_CMD_RE.test(label)) return 'post';
    if (TEST_RE.test(label)) return 'tests';
    if (GIT_RE.test(label)) return 'post';
    return 'servers';
  }

  /** 8-way facing from a movement vector (screen y grows downward). */
  function dir8(dx, dy) {
    let s = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    s = ((s % 8) + 8) % 8;
    return DIR8[s];
  }

  /**
   * Where the agent wants to be right now. Status overrides activity.
   * { key, room, mode, kind, item, status } — key "keep" means "think where you are".
   */
  function desireOf(agent) {
    const st = agent && agent.status;
    const act = (agent && agent.activity) || {};
    const kind = typeof act.kind === 'string' ? act.kind : 'think';
    const label = typeof act.label === 'string' ? act.label : '';
    const mk = (key, room, mode, item) => ({ key, room, mode, kind, item: item || null, status: st });
    if (st === 'error' || kind === 'error') return mk('stay', null, 'error');
    if (st === 'stopped') return mk('room:cafe', 'cafe', 'sleep');
    if (st === 'done') return mk('room:cafe', 'cafe', 'done', 'mug');
    // An interactive terminal session in "waiting" waits for the user, it is not finished:
    // it stays at its home desk (idle pose, "?") instead of going for a coffee.
    if (st === 'waiting' && agent.interactive === true) return mk('desk', 'desk', 'wait');
    if (st === 'waiting') return mk('room:lounge', 'lounge', 'idle', 'mug');
    if (st === 'starting') return mk('desk', 'desk', 'think');
    const r = KIND_ROOM[kind] || 'desk';
    if (r === 'keep') return mk('keep', null, 'think');
    if (r === 'desk') return mk('desk', 'desk', 'type', kind === 'edit' || kind === 'write' ? 'paper' : null);
    if (r === 'stay') return mk('stay', null, 'error');
    if (r === 'cafe') return mk('room:cafe', 'cafe', kind === 'done' ? 'done' : 'idle', 'mug');
    const room = kind === 'bash' ? bashRoom(label) : r;
    return mk('room:' + room, room, 'work', kind === 'search' ? 'magnifier' : ROOM_ITEM[room] || null);
  }

  // ------------------------------------------------------------------ office helpers (tolerant of old / new maps)
  function getRoom(off, id) {
    if (!off || !id) return null;
    const rs = off.rooms;
    if (rs) {
      if (Array.isArray(rs)) { for (let i = 0; i < rs.length; i++) if (rs[i] && rs[i].id === id) return rs[i]; }
      else if (rs[id]) return rs[id];
    }
    return null;
  }
  function rectOf(room) {
    if (!room) return null;
    if (room.rect) return room.rect;
    if (typeof room.x === 'number' && typeof room.w === 'number') return { x: room.x, y: room.y, w: room.w, h: room.h };
    return null;
  }
  function roomIdAt(off, tx, ty) {
    if (!off || typeof off.roomAt !== 'function') return null;
    let r = null;
    try { r = off.roomAt(tx, ty); } catch (e) { r = null; }
    return r && typeof r === 'object' ? r.id || null : r || null;
  }
  function hasFreeSpot(off, roomId, owner) {
    const room = getRoom(off, roomId);
    if (!room || !Array.isArray(room.spots) || !room.spots.length) return !!room;
    for (const s of room.spots) if (!off.isReservedByOther(s.x, s.y, owner)) return true;
    return false;
  }
  function deskIndexOf(off, desk) {
    if (!desk) return -1;
    if (typeof desk.index === 'number') return desk.index;
    return Array.isArray(off.desks) ? off.desks.indexOf(desk) : -1;
  }

  /** Walkable tile, excluding high-cost tiles (couches…) so smoothed paths do not cut across them. */
  function okTile(off, tx, ty, cols) {
    if (!off.isWalkable(tx, ty)) return false;
    return !(off.cost && cols && off.cost[ty * cols + tx] > 0);
  }

  /**
   * True when a body-sized box (feet ±4 px wide, 3 px up / 1 px down) can slide in a straight line from
   * (ax, ay) to (bx, by). Samples every 4 px; each corner only re-checks the grid when it enters a new tile.
   */
  function clearLine(off, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return true;
    const cols = off.cols || Math.round((off.width || 0) / T) || 1;
    const steps = Math.ceil(len / 4);
    let k0 = -1, k1 = -1, k2 = -1, k3 = -1;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps, x = ax + dx * k, y = ay + dy * k;
      const xl = Math.floor((x - 4) / T), xr = Math.floor((x + 4) / T);
      const yt = Math.floor((y - 3) / T), yb = Math.floor((y + 1) / T);
      let q = yt * cols + xl;
      if (q !== k0) { if (!okTile(off, xl, yt, cols)) return false; k0 = q; }
      q = yt * cols + xr;
      if (q !== k1) { if (!okTile(off, xr, yt, cols)) return false; k1 = q; }
      q = yb * cols + xl;
      if (q !== k2) { if (!okTile(off, xl, yb, cols)) return false; k2 = q; }
      q = yb * cols + xr;
      if (q !== k3) { if (!okTile(off, xr, yb, cols)) return false; k3 = q; }
    }
    return true;
  }

  /**
   * String pulling: from each anchor jump to the farthest waypoint still in straight line of sight
   * (exponential probe + binary search, so long corridors stay cheap). Returns the points after pts[0].
   */
  function smoothPath(off, pts) {
    const out = [];
    const n = pts.length;
    let a = 0;
    while (a < n - 1) {
      let lo = a + 1, hi = -1, step = 1;
      const pa = pts[a];
      while (lo < n - 1) {
        const cand = Math.min(n - 1, lo + step);
        if (clearLine(off, pa.x, pa.y, pts[cand].x, pts[cand].y)) { lo = cand; step *= 2; }
        else { hi = cand; break; }
      }
      if (hi !== -1) {
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (clearLine(off, pa.x, pa.y, pts[mid].x, pts[mid].y)) lo = mid; else hi = mid;
        }
      }
      out.push(pts[lo]);
      a = lo;
    }
    return out;
  }

  // ------------------------------------------------------------------ activity icons (bubbles, screen space)
  const ICONS = {
    read: ['.......', '.##.##.', '#..#..#', '#..#..#', '#..#..#', '.##.##.', '...#...'],
    search: ['.###...', '#...#..', '#...#..', '#...#..', '.###...', '....##.', '.....##'],
    edit: ['.....##', '....#o#', '...#.#.', '..#.#..', '.#.#...', '##.....', '#......'],
    write: ['.####..', '.#..##.', '.#...#.', '.#ooo#.', '.#...#.', '.#ooo#.', '.#####.'],
    bash: ['#######', '#.....#', '#o....#', '#.o...#', '#o.oo.#', '#.....#', '#######'],
    web: ['..###..', '.#.#.#.', '#######', '#..#..#', '#######', '.#.#.#.', '..###..'],
    task: ['.#...#.', '###.###', '#.#.#.#', '.......', '...o...', '..ooo..', '..o.o..'],
    todo: ['o.####.', '.......', 'o.####.', '.......', 'o.###..', '.......', '.......'],
    tool: ['...#...', '.#####.', '.##.##.', '###.###', '.##.##.', '.#####.', '...#...'],
    think: ['.......', '.......', '.......', '#..#..#', '.......', '.......', '.......'],
    talk: ['#######', '#.....#', '#.ooo.#', '#.....#', '#######', '.#.....', '#......'],
    done: ['......#', '.....##', '#...##.', '##.##..', '.###...', '..#....', '.......'],
    idle: ['.o..o..', '..o..o.', '#####..', '#####.#', '#####.#', '.###.#.', '.......'],
    eye: ['..###..', '.#...#.', '#..o..#', '.#...#.', '..###..'],
    // ">_" on a tiny screen: marker of sessions started in an HQ terminal ('#' screen, 'o' glyph).
    term: ['#########', '#o#######', '##o######', '#o##ooo##', '#########'],
    // "?" bubble: an interactive session waiting for the user's answer.
    ask: ['..###..', '.#...#.', '.....#.', '....#..', '...#...', '.......', '...#...'],
    bang: ['.##.', '.##.', '.##.', '.##.', '.##.', '....', '.##.', '.##.'],
    z: ['###', '..#', '.#.', '#..', '###']
  };

  // Caches for pre-rendered overlay bits (icons, tags, bubbles). Cleared when web fonts finish loading.
  const textCache = new Map();
  function clearTextCache() { textCache.clear(); }
  function cacheGet(key, make) {
    let v = textCache.get(key);
    if (v === undefined) {
      if (textCache.size > 700) textCache.clear();
      v = make();
      textCache.set(key, v);
    }
    return v;
  }

  function iconCanvas(name, u, main, accent, outline) {
    const rows = ICONS[name];
    if (!rows) return null;
    return cacheGet('i|' + name + '|' + u + '|' + main + '|' + accent + '|' + (outline || ''), () => {
      const pad = outline ? 1 : 0;
      const w = rows[0].length, h = rows.length;
      const cv = S.makeCanvas((w + pad * 2) * u, (h + pad * 2) * u);
      if (!cv) return null;
      const c = cv.getContext('2d');
      if (outline) {
        c.fillStyle = outline;
        for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
          if (rows[j][i] === '.') continue;
          c.fillRect(i * u, j * u, u * 3, u * 3);
        }
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const ch = rows[j][i];
        if (ch === '.') continue;
        c.fillStyle = ch === 'o' ? accent : main;
        c.fillRect((i + pad) * u, (j + pad) * u, u, u);
      }
      return cv;
    });
  }

  const MARKER_ICONS = new Set(['eye', 'bang', 'z', 'term', 'ask']);

  function iconFor(agent, mode) {
    if (mode === 'sleep') return 'idle';
    if (mode === 'done') return 'done';
    if (mode === 'wait') return 'ask';
    const k = agent && agent.activity && agent.activity.kind;
    return ICONS[k] && !MARKER_ICONS.has(k) ? k : 'think';
  }

  // ------------------------------------------------------------------ Character
  let seed = 1;
  function rand() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

  function Character(world, agent) {
    this.world = world;
    this.office = world.office;
    this.id = agent.id;
    this.agent = null;
    this.color = S.normHex(agent.color);
    this.name = '';
    this.x = 0; this.y = 0;
    this.dir = 'up';
    this.alpha = 0;
    this.state = 'spawning';   // spawning | walking | idle | fading | gone
    this.leaving = false;
    this.path = []; this.rest = []; this.pi = 0;
    this.speed = 0;
    this.speedMul = 0.94 + rand() * 0.12;
    this.walkMul = 1;
    this.spot = null;
    this.arriveFacing = 'down';
    this.arrivedAt = -1e9;
    this.committed = null;     // where the character goes / is: { key, mode, room, kind, item, status }
    this.desire = null;        // latest desire (may be "keep")
    this.intent = null;        // latest real destination (thinking never changes it)
    this.pending = null;
    this.thinking = false;
    this.walkDist = 0;
    this.phase = rand() * 10;
    this.nextBlink = world.time + 1 + rand() * 3;
    this.blinkUntil = 0;
    this.bubble = null;
    this.popups = [];
    this.emo = null;           // emote above the head { icon, t0, until }
    this.sayB = null;          // small icon speech bubble used by scenes { icon, t0, until }
    this.scene = null;         // { type: greet | report | chat, … }
    this.faceDir = null; this.faceUntil = 0;
    this.level = 0;
    this.levelFx = null;
    this.coinBank = 0; this.coinAt = 0;
    this.letterPending = false; this.dropAt = 0;
    this.pendingPaper = false; this.papers = 0; this.paperDecayAt = 0;
    this.testOpen = false; this.testDeadline = 0; this.testOk = true;
    this.thinkSince = -1e9; this.ideaAt = -1e9;
    this.nextNote = world.time + 6 + rand() * 10;
    this.chatCooldown = world.time + 4 + rand() * 8;
    this.nextStroll = 0;
    this.loungePref = (hashStr(agent.id) & 1) ? 'terrace' : 'cafe';
    this.doneAt = -1e9; this.errorAt = -1e9; this.spawnAt = world.time; this.fadeAt = 0; this.holdUntil = 0;
    this.lastLabel = null; this.lastKind = null; this.lastSince = null; this.lastStatus = null;
    this.deskExtras = { name: '', papers: 0 };
    this.ovLift = 0;
    let desk = null;
    try { desk = this.office.assignDesk(this.id); } catch (e) { desk = null; }
    this.deskObj = desk;
    this.deskIndex = deskIndexOf(this.office, desk);
    this._placeSpawn(agent);
    this.setAgent(agent);
  }

  Character.prototype._placeSpawn = function (agent) {
    const w = this.world;
    const tiles = w.spawnTiles();
    const e = tiles[w._spawnToggle++ % tiles.length];
    const p = this.office.tileCenter(e.x, e.y);
    this.x = p.x; this.y = p.y;
    this.dir = 'down';
    this.holdUntil = w.time + 0.45;
    this.state = 'spawning';
    w.ping('elevator');
    w.burst(this.x, this.y - 8, S.normHex(agent.color), 'spark');
    // Subagents walk out of the elevator to their parent first (delegation scene).
    if (agent.kind === 'sub' && agent.parentId) {
      this.scene = { type: 'greet', parentId: agent.parentId, phase: 'approach', t0: w.time, tPhase: w.time, key: null, step: 0, meeting: false, handed: false };
    }
  };

  /** Called on every upsert (cheap when nothing relevant changed). */
  Character.prototype.setAgent = function (agent) {
    const w = this.world;
    const first = this.agent === null;
    this.agent = agent;
    this.color = S.normHex(agent.color);
    this.name = truncate(agent.name || agent.id, 24);
    this.deskExtras.name = this.name;
    if (this.leaving) this._cancelLeave();
    const act = agent.activity || {};
    const label = typeof act.label === 'string' ? act.label : '';
    const kind = typeof act.kind === 'string' ? act.kind : null;
    if (label !== this.lastLabel || kind !== this.lastKind || act.since !== this.lastSince) {
      if (label) this.bubble = { text: truncate(label, LABEL_MAX), start: w.time, until: w.time + BUBBLE_TIME, style: 'speech' };
      this._onActivity(kind, label, first ? null : this.lastKind);
      this.lastLabel = label; this.lastKind = kind; this.lastSince = act.since;
    }
    if (agent.status !== this.lastStatus) {
      if (!first) this._onStatus(agent.status, this.lastStatus);
      else if (agent.status === 'waiting' && agent.interactive === true) this.emote('question', 2.4);
      this.lastStatus = agent.status;
    }
    const lvl = levelOf(tokensOf(agent));
    if (first || !this.level) this.level = lvl;
    else if (lvl > this.level) { this.level = lvl; this._levelUp(lvl); }
    this._setDesire(desireOf(agent));
  };

  Character.prototype._onActivity = function (kind, label, prevKind) {
    const now = this.world.time;
    const isBash = kind === 'bash';
    const room = isBash ? bashRoom(label) : null;
    if (prevKind === 'think' && kind && TOOL_KINDS[kind] && now - this.thinkSince >= 0.6 && now - this.ideaAt > 6) {
      this.ideaAt = now;
      this.emote('lightbulb', 1.7);
    }
    if (kind === 'think' && prevKind !== 'think') this.thinkSince = now;
    // Tests: the board flashes when the run ends (result log, or the next activity as a fallback).
    if (this.testOpen && room !== 'tests') this.testDeadline = now + 0.9;
    if (room === 'tests') { this.testOpen = true; this.testDeadline = 0; }
    if (room === 'post') { this.letterPending = true; this.dropAt = 0; }
    if (kind === 'edit' || kind === 'write') this.pendingPaper = true;
  };

  Character.prototype._onStatus = function (st, prev) {
    const w = this.world, now = w.time;
    if (st === 'done') {
      this.doneAt = now;
      w.burst(this.x, this.y - 18, '#6CC28A', 'check');
      this.emote(rand() < 0.5 ? 'heart' : 'sparkle', 2.4);
      if (this.agent && this.agent.kind === 'sub' && this.agent.parentId && w.get(this.agent.parentId)) {
        this.scene = { type: 'report', parentId: this.agent.parentId, phase: 'approach', t0: now, tPhase: now, key: null, step: 0, meeting: false, handed: false };
      }
    } else if (st === 'error') {
      this.errorAt = now;
      this.emote('sweat', 2.6);
      if (this.testOpen) { this.testOpen = false; this.testOk = false; w.ping('tests', false); }
    } else if (st === 'stopped') {
      this.emote('zzz', 2.4);
    } else if ((st === 'working' || st === 'starting') && (prev === 'done' || prev === 'error' || prev === 'stopped' || prev === 'waiting')) {
      this.emote('exclaim', 1.8);
    } else if (st === 'waiting' && this.agent && this.agent.interactive === true) {
      this.emote('question', 2.4);
    }
    if (this.scene && this.scene.type === 'chat' && st !== 'done' && st !== 'waiting') this._endChat();
  };

  Character.prototype._levelUp = function (lvl) {
    const w = this.world;
    this.levelFx = { level: lvl, t0: w.time };
    w.fireworks(this.x, this.y - 16, this.color);
    w.emit({ type: 'levelup', id: this.id, level: lvl, title: titleOf(lvl), name: this.agent ? this.agent.name : this.name, color: this.color });
  };

  /** Pixel emote above the head (lightbulb, exclaim, question, sweat, heart, sparkle, zzz, note…). */
  Character.prototype.emote = function (icon, dur) {
    if (!P || !P.ICONS || !P.ICONS[icon] || this.state === 'gone') return;
    const now = this.world.time;
    this.emo = { icon, t0: now, until: now + (dur || 2) };
  };

  /** Tiny icon speech bubble (scenes and idle chats). */
  Character.prototype.say = function (icon, dur) {
    if (!P || !P.ICONS || !P.ICONS[icon] || this.leaving) return;
    const now = this.world.time;
    this.sayB = { icon, t0: now, until: now + (dur || 1.05) };
  };

  Character.prototype._setDesire = function (d) {
    this.desire = d;
    if (this.leaving) return;
    const now = this.world.time;
    if (d.key === 'keep') {
      // Thinking keeps the character where it is (desk at the very start).
      this.thinking = true;
      if (!this.intent) this.intent = { key: 'desk', room: 'desk', mode: 'think', kind: d.kind, item: null, status: d.status };
      return;
    }
    this.thinking = false;
    const changed = !this.intent || this.intent.key !== d.key;
    this.intent = d;
    if (this.committed && d.key === this.committed.key) {
      // Same place, maybe a new pose (e.g. think -> type at the desk).
      const c = this.committed;
      c.mode = d.mode; c.kind = d.kind; c.item = d.item; c.status = d.status;
      return;
    }
    if (!this.pending) this.pending = { firstAt: now, acc: {}, stayFor: 0, lastChange: now, statusChange: false, delay: DEBOUNCE };
    if (changed) this.pending.lastChange = now;
    const statusChange = !!(this.committed && d.status !== this.committed.status);
    if (statusChange) this.pending.statusChange = true;
    this.pending.delay = d.key === 'stay' ? 0 : d.mode === 'done' ? 1.5 : this.pending.statusChange ? 0.4 : DEBOUNCE;
  };

  /** Tile the character is on (feet). */
  Character.prototype._currentTile = function () {
    return this.office.worldToTile(this.x, this.y);
  };

  Character.prototype._desk = function () {
    const off = this.office;
    let d = null;
    try { d = typeof off.deskOf === 'function' ? off.deskOf(this.id) : null; } catch (e) { d = null; }
    if (!d) {
      // A desk may have been freed since we arrived without one.
      try { d = off.assignDesk(this.id); } catch (e) { d = null; }
    }
    if (d && d.owner !== undefined && d.owner !== null && d.owner !== this.id) d = null;
    this.deskObj = d;
    this.deskIndex = deskIndexOf(off, d);
    return d;
  };

  /** Resolves a logical room (lounge, rooms missing from the map, a full cafe) to an existing room id. */
  Character.prototype._resolveRoom = function (id) {
    const off = this.office;
    let r = id === 'lounge' ? this.loungePref : id;
    if (!getRoom(off, r)) {
      const alts = ROOM_FALLBACK[r] || [];
      r = null;
      for (const a of alts) if (getRoom(off, a)) { r = a; break; }
    }
    if (r === 'cafe' && getRoom(off, 'terrace') && !hasFreeSpot(off, 'cafe', this.id)) r = 'terrace';
    else if (r === 'terrace' && getRoom(off, 'cafe') && !hasFreeSpot(off, 'terrace', this.id) && hasFreeSpot(off, 'cafe', this.id)) r = 'cafe';
    return r;
  };

  Character.prototype._commit = function (d) {
    const off = this.office;
    if (!d || d.key === 'keep') d = { key: 'desk', room: 'desk', mode: 'think', kind: 'think', item: null, status: this.agent ? this.agent.status : null };
    this.committed = { key: d.key, mode: d.mode, room: d.room, kind: d.kind, item: d.item, status: d.status };
    const cur = this._currentTile();
    let spot = null;
    if (d.key === 'desk') {
      const desk = this._desk();
      if (desk) { off.releaseSpot(this.id); spot = desk; this.committed.room = desk.room || 'open'; }
      else { spot = off.findFreeTile(getRoom(off, 'open') ? 'open' : null, null, this.id); this.committed.room = 'open'; }
    } else if (d.key === 'stay') {
      spot = off.reserveTile(cur.x, cur.y, this.id) || off.findFreeTile(roomIdAt(off, cur.x, cur.y), cur, this.id, true);
      this.committed.room = roomIdAt(off, cur.x, cur.y);
    } else {
      const room = this._resolveRoom(d.room);
      this.committed.room = room;
      spot = room ? off.reserveSpot(room, this.id, cur) : off.findFreeTile(null, cur, this.id);
    }
    if (!spot) spot = { x: cur.x, y: cur.y, facing: 'down', pose: 'stand', floor: true };
    this.spot = spot;
    this.walkMul = 1;
    if (this.committed.room === 'terrace') this.nextStroll = this.world.time + 8 + rand() * 8;
    this._walkTo(spot);
  };

  Character.prototype._walkTo = function (spot) {
    const off = this.office;
    const start = this._currentTile();
    let tiles = null;
    try { tiles = off.findPath(start.x, start.y, spot.x, spot.y); } catch (e) { tiles = null; }
    const c = off.tileCenter(spot.x, spot.y);
    const dest = { x: c.x + (spot.ox || 0), y: c.y + (spot.oy || 0) };
    this.arriveFacing = spot.facing || 'down';
    this.path = [];
    this.rest = [];
    this.pi = 0;
    if (!tiles || !tiles.length) {
      // Unreachable (should not happen on this map): hop there with a little sparkle.
      this.world.burst(this.x, this.y - 8, this.color, 'spark');
      this.x = dest.x; this.y = dest.y;
      this.world.burst(this.x, this.y - 8, this.color, 'spark');
      this._arrive();
      return;
    }
    const pts = [{ x: this.x, y: this.y }];
    for (let i = 1; i < tiles.length; i++) pts.push(off.tileCenter(tiles[i].x, tiles[i].y));
    const last = pts[pts.length - 1];
    if (Math.abs(last.x - dest.x) > 0.01 || Math.abs(last.y - dest.y) > 0.01) pts.push(dest);
    const path = smoothPath(off, pts);
    // Drop zero-length legs.
    let px = this.x, py = this.y;
    for (const p of path) {
      if (Math.abs(p.x - px) < 0.01 && Math.abs(p.y - py) < 0.01) continue;
      this.path.push(p);
      px = p.x; py = p.y;
    }
    if (!this.path.length) { this._arrive(); return; }
    const n = this.path.length;
    this.rest.length = n;
    this.rest[n - 1] = 0;
    for (let i = n - 2; i >= 0; i--) {
      const a = this.path[i], b = this.path[i + 1];
      this.rest[i] = this.rest[i + 1] + Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.y - a.y) * (b.y - a.y));
    }
    if (this.state !== 'walking') this.speed = Math.min(this.speed, SPEED * 0.35);
    this.state = 'walking';
  };

  Character.prototype._arrive = function () {
    const w = this.world;
    this.path = []; this.rest = []; this.pi = 0;
    this.speed = 0;
    if (this.leaving) {
      this.state = 'fading';
      this.fadeAt = w.time;
      this.dir = 'down';
      w.ping('elevator');
      w.burst(this.x, this.y - 8, this.color, 'spark');
      return;
    }
    this.state = 'idle';
    this.dir = this.arriveFacing || 'down';
    this.arrivedAt = w.time;
    if (this._spotPose() === 'coffee') w.ping('coffee');
  };

  /** Walk to the elevator, then fade out. */
  Character.prototype.leave = function () {
    if (this.leaving || this.state === 'gone') return;
    this._flushCoins();
    if (this.scene && this.scene.type === 'chat') this._endChat();
    this.scene = null;
    this.leaving = true;
    this.pending = null;
    this.bubble = null;
    this.sayB = null;
    this.letterPending = false;
    this.office.releaseSpot(this.id);
    this.office.freeDesk(this.id);
    this.deskIndex = -1;
    this.deskObj = null;
    const exits = this.world.exitTiles();
    const e = exits[this.world._exitToggle++ % exits.length];
    this.committed = { key: 'exit', mode: 'exit', room: 'lobby', kind: null, item: null, status: null };
    this.spot = { x: e.x, y: e.y, facing: 'down', pose: 'stand', floor: true };
    if (this.state === 'spawning') this.state = 'idle';
    this._walkTo(this.spot);
  };

  Character.prototype._cancelLeave = function () {
    this.leaving = false;
    if (this.state === 'fading' || this.state === 'gone') { this.state = 'idle'; this.alpha = Math.max(this.alpha, 0.3); }
    let desk = null;
    try { desk = this.office.assignDesk(this.id); } catch (e) { desk = null; }
    this.deskObj = desk;
    this.deskIndex = deskIndexOf(this.office, desk);
    this.committed = null;
    this.pending = null;
  };

  Character.prototype._faceEachOther = function (other, dur) {
    const now = this.world.time;
    this.faceDir = dir8(other.x - this.x, other.y - this.y);
    this.faceUntil = now + dur;
    if (other.state === 'idle') {
      other.faceDir = dir8(this.x - other.x, this.y - other.y);
      other.faceUntil = now + dur;
    }
  };

  /** Tile a character is heading to (or standing on). */
  function targetTileOf(ch) {
    if (ch.state === 'walking' && ch.spot) return { x: ch.spot.x, y: ch.spot.y };
    return ch.office.worldToTile(ch.x, ch.y);
  }

  /** Delegation scenes: greet (sub walks out of the elevator to its parent) and report (hands its paper over). */
  Character.prototype._tickScene = function () {
    const s = this.scene, w = this.world, now = w.time, off = this.office;
    const p = w.get(s.parentId);
    if (!p || p.leaving || p === this || now - s.t0 > (s.type === 'greet' ? 18 : 14)) { this._endScene(); return; }
    if (s.phase === 'approach') {
      const tt = targetTileOf(p);
      const key = tt.x + ',' + tt.y;
      if (key !== s.key) {
        s.key = key;
        s.tPhase = now;
        const room = roomIdAt(off, tt.x, tt.y);
        let spot = null;
        try { spot = off.findFreeTile(room, tt, this.id, true); } catch (e) { spot = null; }
        if (!spot) spot = { x: tt.x, y: tt.y, facing: 'down', pose: 'stand', floor: true };
        this.committed = { key: 'scene', mode: 'idle', room, kind: null, item: null, status: this.agent ? this.agent.status : null };
        this.spot = spot;
        this.walkMul = 1.12;
        this._walkTo(spot);
      }
      if (this.state === 'idle') {
        const d = Math.sqrt((p.x - this.x) * (p.x - this.x) + (p.y - this.y) * (p.y - this.y));
        if (d <= 4 * T && p.state !== 'walking') {
          s.phase = 'talk'; s.tPhase = now; s.step = 0;
          s.meeting = p.committed && p.committed.room === 'meeting';
        } else if (now - s.tPhase > 6) {
          s.key = null;   // the parent moved on: re-target
        }
      }
    } else {
      this._faceEachOther(p, 0.6);
      const e = now - s.tPhase;
      if (s.type === 'greet') {
        const lines = s.meeting ? GREET_MEETING : GREET_SHORT;
        while (s.step < lines.length && e >= lines[s.step][2]) {
          const L = lines[s.step];
          (L[0] === 'p' ? p : this).say(L[1], 1.0);
          s.step++;
        }
        if (e >= (s.meeting ? 3.2 : 1.4)) this._endScene();
      } else {
        if (!s.handed) {
          s.handed = true;
          w.arc(this.x, this.y - 9, p.x, p.y - 9, 'paper', this.color, 0.75);
        }
        if (s.step === 0 && e >= 0.8) {
          s.step = 1;
          p.say('thumb', 1.1);
          p.papers = Math.min(6, p.papers + 1);
          p.deskExtras.papers = p.papers;
          p.paperDecayAt = now + 45;
        }
        if (e >= 1.5) this._endScene();
      }
    }
  };

  Character.prototype._endScene = function () {
    this.scene = null;
    this.pending = null;
    this.walkMul = 1;
    if (this.leaving) return;
    this._commit(this.intent || desireOf(this.agent || {}));
  };

  Character.prototype._endChat = function () {
    const s = this.scene;
    if (!s || s.type !== 'chat') return;
    const now = this.world.time;
    this.scene = null;
    this.chatCooldown = now + 12 + rand() * 14;
    const o = this.world.chars.get(s.partnerId);
    if (o && o.scene && o.scene.type === 'chat' && o.scene.partnerId === this.id) {
      o.scene = null;
      o.chatCooldown = now + 12 + rand() * 14;
    }
  };

  Character.prototype._tickChat = function () {
    const s = this.scene, w = this.world, now = w.time;
    const o = w.get(s.partnerId);
    if (!o || o.leaving || this.leaving || this.pending || this.state !== 'idle' || now >= s.end) { this._endChat(); return; }
    this.faceDir = dir8(o.x - this.x, o.y - this.y);
    this.faceUntil = now + 0.3;
    if (s.leader && s.lines) {
      while (s.step < s.lines.length && now - s.t0 >= s.lines[s.step].at) {
        const L = s.lines[s.step];
        (L.lead ? this : o).say(L.icon, 1.0);
        s.step++;
      }
    }
  };

  /** Per-frame simulation step (world time already advanced). */
  Character.prototype.tick = function (dt) {
    const w = this.world, now = w.time, off = this.office;
    if (this.state === 'gone') return;
    if (this.state === 'fading') {
      this.alpha = 1 - (now - this.fadeAt) / 0.6;
      if (this.alpha <= 0) { this.alpha = 0; this.state = 'gone'; }
      return;
    }
    this.alpha = Math.min(1, this.alpha + dt / 0.45);
    if (this.coinBank > 0 && now - this.coinAt >= 0.35) this._flushCoins();
    if (now >= this.nextBlink) { this.blinkUntil = now + 0.13; this.nextBlink = now + 2.5 + rand() * 3.5; }
    if (this.popups.length && now - this.popups[0].t0 >= 1.6) this.popups.shift();
    if (this.emo && now >= this.emo.until) this.emo = null;
    if (this.sayB && now >= this.sayB.until) this.sayB = null;
    if (this.testOpen && this.testDeadline && now >= this.testDeadline) {
      this.testOpen = false;
      this.testOk = !(this.agent && this.agent.status === 'error');
      w.ping('tests', this.testOk);
    }
    if (now < this.holdUntil) return;
    if (this.state === 'spawning') this.state = 'idle';

    if (!this.leaving) {
      if (this.scene && this.scene.type !== 'chat') {
        this._tickScene();
      } else {
        if (this.scene) this._tickChat();
        this._tickIntent(dt);
      }
    }
    if (this.state === 'walking') this._move(dt);
    if (this.state === 'idle' && !this.leaving) this._tickIdle(now);
  };

  /** Debounce + dwell before acting on a new destination. */
  Character.prototype._tickIntent = function (dt) {
    const now = this.world.time;
    if (!this.committed) {
      if (this.intent && this.world._pathBudget > 0) { this.world._pathBudget--; this.pending = null; this._commit(this.intent); }
      return;
    }
    const p = this.pending;
    if (!p) return;
    const d = this.intent;
    if (!d || d.key === this.committed.key) {
      p.stayFor += dt;
      if (p.stayFor >= DEBOUNCE) this.pending = null;
      return;
    }
    // Move only once the new destination held for 1.2 s (or was wanted ACCUM s in total while flickering),
    // and never leave a room less than DWELL s after arriving, except when the status changed.
    p.stayFor = 0;
    p.acc[d.key] = (p.acc[d.key] || 0) + dt;
    const ready = now - p.lastChange >= p.delay || p.acc[d.key] >= ACCUM;
    const dwellOk = p.statusChange || d.key === 'stay' || this.state === 'walking' || now - this.arrivedAt >= DWELL;
    // A per-frame path budget spreads mass re-targets (30 agents changing at once) over a few frames.
    if (ready && dwellOk && this.world._pathBudget > 0) {
      this.world._pathBudget--;
      this.pending = null;
      if (this.scene && this.scene.type === 'chat') this._endChat();
      this._commit(d);
    }
  };

  Character.prototype._move = function (dt) {
    const n = this.path.length;
    if (this.pi >= n) { this._arrive(); return; }
    const wp = this.path[this.pi];
    const dxw = wp.x - this.x, dyw = wp.y - this.y;
    const remaining = Math.sqrt(dxw * dxw + dyw * dyw) + (this.rest[this.pi] || 0);
    const cruise = SPEED * this.speedMul * this.walkMul;
    const brake = Math.sqrt(2 * ACCEL * remaining) + 10;
    this.speed = Math.min(this.speed + ACCEL * dt, cruise, Math.max(cruise * 0.3, brake));
    let budget = this.speed * dt;
    while (budget > 0 && this.pi < n) {
      const p = this.path[this.pi];
      const dx = p.x - this.x, dy = p.y - this.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 1.5) this.dir = dir8(dx, dy);
      if (dist <= budget) {
        this.x = p.x; this.y = p.y;
        budget -= dist; this.walkDist += dist; this.pi++;
      } else {
        this.x += (dx / dist) * budget; this.y += (dy / dist) * budget;
        this.walkDist += budget; budget = 0;
      }
    }
    if (this.pi >= n) this._arrive();
  };

  /** Idle-at-spot life: desk monitor, paper stack, letters, notes, terrace strolls. */
  Character.prototype._tickIdle = function (now) {
    const w = this.world, off = this.office, c = this.committed;
    if (!c) return;
    // Home desk: monitor (code lines / "…"), nameplate and paper stack.
    if (c.key === 'desk' && this.deskObj && this.spot === this.deskObj) {
      if (this.pendingPaper && now - this.arrivedAt > 0.5) {
        this.pendingPaper = false;
        this.papers = Math.min(6, this.papers + 1);
        const s = this.spot;
        const top = off.tileCenter(typeof s.deskX === 'number' ? s.deskX : s.x, typeof s.deskY === 'number' ? s.deskY : s.y - 1);
        w.arc(this.x, this.y - 8, top.x + 4, top.y - 6, 'paper', this.color, 0.45);
      }
      this.paperDecayAt = now + 45;
      this.deskExtras.papers = this.papers;
      if (typeof off.markDesk === 'function' && this.deskIndex >= 0) {
        const mode = c.mode === 'type' && !this.thinking ? 'type' : 'think';
        try { off.markDesk(this.deskIndex, mode, this.color, now, this.deskExtras); } catch (e) { /* decoration */ }
      }
    } else if (this.papers > 0 && now >= this.paperDecayAt) {
      // Papers get filed away slowly while the agent is elsewhere.
      this.papers--;
      this.deskExtras.papers = this.papers;
      this.paperDecayAt = now + 45;
    }
    // Letters: dropped into a mailbox at the post office.
    if (this.letterPending) {
      if (c.key === 'room:post') {
        if (!this.dropAt) this.dropAt = now + 0.6;
        else if (now >= this.dropAt) {
          this.letterPending = false;
          this.dropAt = 0;
          const f = this.dir;
          const ox = f === 'left' ? -12 : f === 'right' ? 12 : 0, oy = f === 'up' ? -12 : f === 'down' ? 6 : -4;
          w.arc(this.x, this.y - 9, this.x + ox, this.y - 14 + oy, 'letter', this.color, 0.4);
          w.ping('post');
        }
      } else if (!this.intent || this.intent.key !== 'room:post') {
        if (now - this.arrivedAt > 3) this.letterPending = false;
      }
    }
    if (this.scene) return;
    const lounge = c.room === 'cafe' || c.room === 'terrace';
    if (lounge && (c.mode === 'idle' || c.mode === 'done') && !this.pending) {
      if (now >= this.nextNote) {
        this.nextNote = now + 8 + rand() * 10;
        if (rand() < 0.4 && !this.emo) this.emote('note', 1.8);
      }
      // Waiting characters stroll around the terrace.
      if (c.room === 'terrace' && now >= this.nextStroll && now - this.arrivedAt > 4) {
        this.nextStroll = now + 7 + rand() * 9;
        const r = rectOf(getRoom(off, 'terrace'));
        if (r) {
          const near = { x: r.x + Math.floor(rand() * r.w), y: r.y + Math.floor(rand() * r.h) };
          let spot = null;
          try { spot = off.findFreeTile('terrace', near, this.id); } catch (e) { spot = null; }
          if (spot) { this.spot = spot; this.walkMul = 0.55; this._walkTo(spot); }
        }
      }
    }
  };

  /** True when the character stands on its target and is not about to move. */
  Character.prototype.isSettled = function () {
    return this.state === 'idle' && !this.pending && !!this.committed && !this.leaving;
  };

  Character.prototype.flash = function (entry) {
    if (!entry || this.leaving) return;
    const w = this.world;
    const text = truncate(entry.text || '', LABEL_MAX);
    if (entry.type === 'error') {
      this.errorAt = w.time;
      if (text) this.bubble = { text, start: w.time, until: w.time + 3, style: 'error' };
      this.emote('sweat', 2.4);
      if (this.testOpen) { this.testOpen = false; this.testOk = false; w.ping('tests', false); }
    } else if (entry.type === 'result') {
      w.burst(this.x, this.y - 18, '#6CC28A', 'check');
    } else if (entry.type === 'user') {
      this.emote('exclaim', 1.8);
    } else if (entry.type === 'tool_result') {
      if (this.testOpen) {
        const blob = String(entry.text || '') + ' ' + String(entry.detail || '').slice(0, 400);
        this.testOpen = false;
        this.testOk = !FAIL_RE.test(blob);
        w.ping('tests', this.testOk);
      }
    } else if ((entry.type === 'tool' || entry.type === 'text') && text) {
      this.bubble = { text, start: w.time, until: w.time + (entry.type === 'text' ? 3 : 2.5), style: 'speech' };
    }
  };

  Character.prototype.addTokens = function (delta) {
    const n = Number(delta);
    if (!(n > 0) || this.state === 'gone') return;
    const now = this.world.time;
    const last = this.popups[this.popups.length - 1];
    if (last && now - last.t0 < 0.4) { last.amount += n; last.text = formatTokens(last.amount); }
    else {
      this.popups.push({ amount: n, text: formatTokens(n), t0: now });
      if (this.popups.length > 5) this.popups.shift();
    }
    if (this.coinBank <= 0) this.coinAt = now;
    this.coinBank += n;
  };

  /** Hands the banked tokens to the engine as 1–5 coins popping from the head (values sum to the delta). */
  Character.prototype._flushCoins = function () {
    const v = this.coinBank;
    if (!(v > 0)) return;
    this.coinBank = 0;
    this.coinAt = this.world.time;
    let n = v < 500 ? 1 : v < 5000 ? 2 : v < 50000 ? 3 : v < 500000 ? 4 : 5;
    if (this.world.reduced) n = 1;
    const base = Math.floor(v / n);
    for (let k = 0; k < n; k++) {
      const value = k === 0 ? v - base * (n - 1) : base;
      this.world.pushCoin(this.x + (k - (n - 1) / 2) * 4, this.y - 17, value, this.color, this.id);
    }
    this.world.burst(this.x, this.y - 17, '#F2C14E', 'coin');
  };

  // ------------------------------------------------------------------ appearance
  Character.prototype._spotPose = function () {
    const p = this.spot && this.spot.pose ? this.spot.pose : 'stand';
    return POSE_ALIAS[p] || p;
  };

  /** Item carried while walking (closed forms). */
  Character.prototype._carryItem = function () {
    if (this.leaving) return null;
    const s = this.scene;
    if (s && s.type === 'report' && !s.handed) return 'paper';
    if (this.letterPending) return 'letter';
    const c = this.committed;
    if (!c || !c.item) return null;
    switch (c.item) {
      case 'paper': return this.pendingPaper ? 'paper' : null;
      case 'laptop': return 'laptopclosed';
      case 'tablet': return 'tablet';
      case 'magnifier': return 'magnifier';
      case 'bookopen': return 'book';
      default: return null;
    }
  };

  /** Pose / frame / eyes / item / screen glow for this frame, derived from state, spot and mode. */
  Character.prototype.visual = function (t) {
    const v = this._v || (this._v = { pose: 'idle', frame: 0, eyes: 'open', acc: null, lift: false, glow: null, dir: 'down' });
    v.pose = 'idle'; v.frame = 0; v.eyes = 'open'; v.acc = null; v.lift = false; v.glow = null;
    v.dir = this.state === 'idle' && t < this.faceUntil && this.faceDir ? this.faceDir : this.dir;
    const ph = t + this.phase;
    if (this.state === 'walking') {
      const carry = this._carryItem();
      v.pose = carry ? 'carry' : 'walk';
      v.frame = Math.floor(this.walkDist / 4) % 4;
      v.acc = carry;
    } else if (this.state === 'idle' && this.committed && !this.leaving) {
      const c = this.committed;
      const mode = c.mode;
      const pose = this._spotPose();
      const lounge = c.room === 'cafe' || c.room === 'terrace';
      const thinking = this.thinking && mode !== 'error' && mode !== 'sleep';
      if (mode === 'error') {
        v.eyes = 'x';
        v.frame = Math.floor(ph * 2) % 2;
      } else if (mode === 'sleep') {
        v.pose = pose === 'sit' ? 'sit' : 'idle';
        v.eyes = 'closed';
        v.frame = Math.floor(ph * 0.8) % 2;
      } else if (c.key === 'desk' || pose === 'type') {
        if (mode === 'type' && !thinking) { v.pose = 'work'; v.frame = Math.floor(ph * 6) % 2; }
        else v.frame = Math.floor(ph * (mode === 'wait' ? 0.9 : 1.5)) % 2;
      } else if (c.key === 'scene') {
        v.frame = Math.floor(ph * 1.5) % 2;
        if (this.scene && this.scene.type === 'report' && !this.scene.handed) { v.pose = 'carry'; v.frame = 1; v.acc = 'paper'; }
      } else {
        switch (pose) {
          case 'read':
            if (v.dir === 'up' || v.dir === 'upleft' || v.dir === 'upright') { v.pose = 'reach'; v.frame = Math.floor(ph * 1.5) % 2; }
            else { v.frame = Math.floor(ph * 1.2) % 2; v.acc = c.kind === 'search' ? 'magnifier' : 'bookopen'; v.lift = c.kind === 'search' && ph % 3 < 1.5; }
            break;
          case 'rack': v.pose = thinking ? 'idle' : 'work'; v.frame = Math.floor(ph * 3.5) % 2; v.acc = 'laptop'; v.glow = '#5BA4E6'; break;
          case 'test': v.pose = thinking ? 'idle' : 'work'; v.frame = Math.floor(ph * 3.5) % 2; v.acc = 'laptop'; v.glow = this.testOk ? '#6CC28A' : '#E5534B'; break;
          case 'screen': {
            const cyc = ph % 5;
            v.pose = cyc < 1 && !thinking ? 'reach' : 'idle';
            v.frame = Math.floor(ph * 1.5) % 2;
            v.acc = 'tablet';
            v.glow = '#4FC1B9';
            break;
          }
          case 'board': v.pose = thinking ? 'idle' : 'reach'; v.frame = Math.floor(ph * 2.5) % 2; v.acc = 'marker'; v.lift = v.frame === 1; break;
          case 'mail':
            if (this.letterPending) { v.pose = 'reach'; v.frame = Math.floor(ph * 2) % 2; v.acc = 'letter'; }
            else v.frame = Math.floor(ph * 1.2) % 2;
            break;
          case 'meet': {
            const talking = ph % 4 < 1.2;
            v.pose = talking ? 'work' : 'idle';
            v.frame = Math.floor(ph * (talking ? 4 : 1.2)) % 2;
            break;
          }
          case 'coffee': v.frame = Math.floor(ph * 1.2) % 2; v.acc = 'mug'; v.lift = ph % 4.5 < 1; break;
          case 'sit':
            v.pose = 'sit';
            v.frame = Math.floor(ph) % 2;
            if (c.room === 'meeting') { v.frame = Math.floor(ph * (ph % 4 < 1.2 ? 4 : 1)) % 2; }
            else { v.acc = 'mug'; v.lift = ph % 6 < 1; }
            break;
          default:
            if (mode === 'type') { v.pose = 'work'; v.frame = Math.floor(ph * 6) % 2; }
            else if (lounge || mode === 'idle' || mode === 'done') { v.frame = Math.floor(ph * 1.2) % 2; if (lounge) { v.acc = 'mug'; v.lift = ph % 5 < 0.9; } }
            else {
              v.frame = Math.floor(ph * 1.2) % 2;
              const k = c.kind;
              if (k === 'read') v.acc = 'bookopen';
              else if (k === 'search') v.acc = 'magnifier';
              else if (k === 'bash') { v.acc = 'laptop'; v.pose = thinking ? 'idle' : 'work'; v.frame = Math.floor(ph * 3.5) % 2; }
              else if (k === 'web' || k === 'tool') v.acc = 'tablet';
            }
        }
        // A spot may name its own prop.
        const it = this.spot && this.spot.item;
        if (it && S.ITEMS && S.ITEMS.indexOf(it) >= 0) v.acc = it;
      }
      if (mode === 'done' && ph % 7 < 1.2) v.eyes = 'happy';
    } else {
      v.frame = Math.floor(ph * 1.2) % 2;
    }
    // Celebrations: level-up and freshly done -> both arms up.
    if (!this.leaving && this.state !== 'walking') {
      if ((this.levelFx && t - this.levelFx.t0 < 1.6) || (t - this.doneAt < 1.1 && this.state === 'idle')) {
        v.pose = 'cheer'; v.frame = Math.floor(t * 6) % 2; v.eyes = 'happy'; v.acc = null;
      }
    }
    if (v.eyes === 'open' && t < this.blinkUntil) v.eyes = 'blink';
    if (this.world.reduced && v.pose === 'idle') v.frame = 0;
    return v;
  };

  /** 1 px pixel ellipse under the feet (selection / hover). */
  function ring(ctx, fx, fy, color, t, pulse, reduced, grow) {
    const p = pulse && !reduced ? (Math.sin(t * 5) + 1) / 2 : 0.5;
    const rx = 9 + p * 1.5 + (grow || 0), ry = 3.4 + p * 0.6 + (grow || 0) * 0.35;
    ctx.fillStyle = color;
    for (let k = 0; k < 44; k++) {
      const ang = (k / 44) * Math.PI * 2;
      ctx.fillRect(Math.round(fx + Math.cos(ang) * rx), Math.round(fy - 1 + Math.sin(ang) * ry), 1, 1);
    }
  }

  const drawOpts = { pose: 'idle', dir: 'down', frame: 0, eyes: 'open', accessory: null, lift: false, shadow: true };

  /** World-space drawing: ring, screen glow, shadow, sprite, item, hover/selection highlight. */
  Character.prototype.drawWorld = function (ctx, t, selected, hovered) {
    if (this.state === 'gone' || this.alpha <= 0) return;
    const fx = Math.round(this.x), fy = Math.round(this.y);
    const v = this.visual(t);
    const reduced = this.world.reduced;
    const a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * this.alpha;
    if (selected) {
      ring(ctx, fx, fy, '#FFFFFF', t, true, reduced, 0);
      ring(ctx, fx, fy + 1, this.color, t, true, reduced, 0);
      if (!reduced) {
        ctx.globalAlpha = a0 * this.alpha * (0.35 + 0.35 * Math.sin(t * 5));
        ring(ctx, fx, fy, this.color, t, true, reduced, 3);
        ctx.globalAlpha = a0 * this.alpha;
      }
    } else if (hovered) {
      ring(ctx, fx, fy, '#ECE8F4', t, false, reduced, 0);
    }
    if (v.glow) {
      const flick = reduced ? 0.22 : 0.16 + 0.12 * Math.abs(Math.sin(t * 9 + this.phase * 3));
      ctx.globalAlpha = a0 * this.alpha * flick;
      ctx.fillStyle = v.glow;
      ctx.fillRect(fx - 6, fy - 25, 12, 8);
      ctx.globalAlpha = a0 * this.alpha;
    }
    const o = drawOpts;
    o.pose = v.pose; o.dir = v.dir; o.frame = v.frame; o.eyes = v.eyes; o.accessory = v.acc; o.lift = v.lift; o.shadow = true;
    S.drawCharacter(ctx, this.color, fx, fy, o);
    if (selected || hovered) {
      const prevOp = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = a0 * this.alpha * (selected ? 0.16 : 0.22);
      o.shadow = false; o.accessory = null;
      S.drawCharacter(ctx, this.color, fx, fy, o);
      ctx.globalCompositeOperation = prevOp;
    }
    ctx.globalAlpha = a0;
  };

  // ------------------------------------------------------------------ overlays (screen space)
  let measureCtx = null;
  function measure(font, text) {
    return cacheGet('m|' + font + '|' + text, () => {
      if (!measureCtx) { const c = S.makeCanvas(8, 8); measureCtx = c ? c.getContext('2d') : null; }
      if (!measureCtx || typeof measureCtx.measureText !== 'function') return text.length * 6;
      measureCtx.font = font;
      const m = measureCtx.measureText(text);
      return m && typeof m.width === 'number' ? m.width : text.length * 6;
    });
  }

  /** Name tag in the agent colour, with the level badge on its left. */
  function tagCanvas(name, color, view, level) {
    const u = view.u;
    return cacheGet('t|' + name + '|' + color + '|' + view.font + '|' + u + '|' + level, () => {
      const tw = Math.ceil(measure(view.font, name));
      const h = view.fs + 5 * u;
      const lvTxt = level > 0 ? String(level) : '';
      const bw = lvTxt ? Math.max(h - u, Math.ceil(measure(view.font, lvTxt)) + 5 * u) : 0;
      const nameW = tw + 8 * u;
      const w = nameW + bw;
      const cv = S.makeCanvas(w, h + u);
      if (!cv) return { img: null, w, h: h + u };
      const c = cv.getContext('2d');
      const pal = S.palette(color);
      c.fillStyle = pal.outline; c.fillRect(0, 0, w, h + u);
      c.fillStyle = color; c.fillRect(bw + u, u, nameW - 2 * u, h - 2 * u);
      c.fillStyle = pal.light; c.fillRect(bw + u, u, nameW - 2 * u, u);
      c.fillStyle = pal.dark; c.fillRect(bw + u, h - 2 * u, nameW - 2 * u, u);
      c.font = view.font;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      if (bw) {
        const lc = P && typeof P.levelColor === 'function' ? P.levelColor(level) : { bg: '#F2C14E', fg: '#14151F' };
        c.fillStyle = lc.bg; c.fillRect(u, u, bw - u, h - 2 * u);
        c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(u, u, bw - u, u);
        c.fillStyle = 'rgba(0,0,0,0.22)'; c.fillRect(u, h - 2 * u, bw - u, u);
        c.fillStyle = lc.fg;
        c.fillText(lvTxt, u + (bw - u) / 2, h / 2 + (view.fontOffset || 0));
      }
      c.fillStyle = S.luminance(color) > 0.42 ? '#14151F' : '#FFFFFF';
      c.fillText(name, bw + nameW / 2, h / 2 + (view.fontOffset || 0));
      return { img: cv, w, h: h + u };
    });
  }

  function bubbleCanvas(text, style, view) {
    const u = view.u;
    return cacheGet('b|' + style + '|' + text + '|' + view.font + '|' + u, () => {
      const tw = Math.ceil(measure(view.font, text));
      const w = tw + 10 * u, h = view.fs + 7 * u;
      const cv = S.makeCanvas(w, h + 3 * u);
      if (!cv) return { img: null, w, h: h + 3 * u };
      const c = cv.getContext('2d');
      const bg = style === 'error' ? '#FBE3E1' : '#F7F4EC';
      paintBubble(c, 0, 0, w, h, u, bg);
      c.font = view.font;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = style === 'error' ? '#9B1C16' : '#14151F';
      c.fillText(text, w / 2, h / 2 + (view.fontOffset || 0));
      return { img: cv, w, h: h + 3 * u };
    });
  }

  /** Pixel bubble: dark border, rounded pixel corners, light fill and a stepped tail under the centre. */
  function paintBubble(c, x, y, w, h, u, bg) {
    c.fillStyle = '#14151F';
    c.fillRect(x + u, y, w - 2 * u, h);
    c.fillRect(x, y + u, w, h - 2 * u);
    c.fillStyle = bg;
    c.fillRect(x + u, y + u, w - 2 * u, h - 2 * u);
    c.fillStyle = 'rgba(20,21,31,0.12)';
    c.fillRect(x + u, y + h - 2 * u, w - 2 * u, u);
    const cx = x + Math.round(w / 2 / u) * u;
    c.fillStyle = '#14151F';
    c.fillRect(cx - 2 * u, y + h - u, 4 * u, u);
    c.fillRect(cx - u, y + h, 3 * u, u);
    c.fillRect(cx, y + h + u, u, u);
    c.fillStyle = bg;
    c.fillRect(cx - u, y + h - u, 2 * u, u);
    c.fillRect(cx, y + h, u, u);
  }

  function iconBubble(icon, accent, view) {
    const u = view.u;
    return cacheGet('ib|' + icon + '|' + accent + '|' + u, () => {
      const w = 13 * u, h = 13 * u;
      const cv = S.makeCanvas(w, h + 3 * u);
      if (!cv) return { img: null, w, h: h + 3 * u };
      const c = cv.getContext('2d');
      paintBubble(c, 0, 0, w, h, u, '#F7F4EC');
      const ic = iconCanvas(icon, u, icon === 'done' ? '#2E8B57' : '#14151F', accent);
      if (ic) c.drawImage(ic, 3 * u, 3 * u);
      return { img: cv, w, h: h + 3 * u };
    });
  }

  /** Small bubble around a shared pixel icon (HQProgression.ICONS), for scenes and chats. */
  function sayBubble(icon, view) {
    const u = view.u;
    return cacheGet('sy|' + icon + '|' + u, () => {
      const ic = P && P.ICONS ? P.ICONS[icon] : null;
      if (!ic) return { img: null, w: 0, h: 0 };
      const iw = ic.w, ih = ic.h;
      const w = (Math.max(iw, 7) + 4) * u, h = (Math.max(ih, 5) + 4) * u;
      const cv = S.makeCanvas(w, h + 3 * u);
      if (!cv) return { img: null, w, h: h + 3 * u };
      const c = cv.getContext('2d');
      paintBubble(c, 0, 0, w, h, u, '#F7F4EC');
      ic.draw(c, Math.round((w - iw * u) / 2 / u) * u, Math.round((h - ih * u) / 2 / u) * u, u, icon !== 'dots');
      return { img: cv, w, h: h + 3 * u };
    });
  }

  function emoteCanvas(icon, s) {
    return P && typeof P.iconCanvas === 'function' ? P.iconCanvas(icon, s, icon !== 'dots') : null;
  }

  /**
   * Screen-space overlays above the head. view: { ox, oy, z, u, fs, font, fontOffset, reduced, compact }.
   * lift (device px) raises the whole stack so crowded name tags do not overlap (the engine computes it);
   * a thin leader line then joins the tag to the head. Returns the stack's screen box
   * { x0, y0, x1, y1 } (name tag, icons, bubbles, emote; popups excluded) or null when nothing is drawn.
   * Only drawImage / fillRect / fillText and plain property writes are used (the engine measures with a no-op context).
   */
  Character.prototype.drawOverlay = function (ctx, view, selected, hovered, lift) {
    if (this.state === 'gone' || this.alpha <= 0.02) return null;
    const t = this.world.time, u = view.u;
    const sx = Math.round(view.ox + this.x * view.z);
    const realHeadY = Math.round(view.oy + (this.y - 14) * view.z);
    const lifted = lift > 0 ? Math.round(lift) : 0;
    const headY = realHeadY - lifted;
    const a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * this.alpha;

    const tag = tagCanvas(this.name, this.color, view, this.level);
    const tagX = Math.round(sx - tag.w / 2);
    const tagY = headY - 2 * u - tag.h;
    const box = { x0: tagX, y0: tagY, x1: tagX + tag.w, y1: tagY + tag.h };
    const widen = (w) => {
      const h = Math.ceil(w / 2);
      if (sx - h < box.x0) box.x0 = sx - h;
      if (sx + h > box.x1) box.x1 = sx + h;
    };
    if (lifted > 2 * u) {
      ctx.globalAlpha = a0 * this.alpha * 0.55;
      ctx.fillStyle = this.color;
      ctx.fillRect(sx - Math.floor(u / 2), tagY + tag.h, u, Math.max(0, realHeadY - 2 * u - (tagY + tag.h)));
      ctx.globalAlpha = a0 * this.alpha;
    }
    if (tag.img) ctx.drawImage(tag.img, tagX, tagY);
    const source = this.agent ? this.agent.source : null;
    if (source === 'observed' || source === 'terminal') {
      // Eye for observed sessions; ">_" mini screen (framed in the agent colour) for terminal sessions.
      const marker = source === 'observed'
        ? iconCanvas('eye', u, '#ECE8F4', this.color, '#14151F')
        : iconCanvas('term', u, '#14151F', '#6CC28A', this.color);
      if (marker) {
        ctx.drawImage(marker, tagX - marker.width - u, tagY + Math.round((tag.h - marker.height) / 2));
        box.x0 = Math.min(box.x0, tagX - marker.width - u);
      }
    }
    let top = tagY - u;
    const c = this.committed;
    const mode = this.thinking && c && c.mode !== 'error' && c.mode !== 'sleep' && c.mode !== 'done' ? 'think'
      : c ? c.mode : (this.desire ? this.desire.mode : null);
    if (!this.leaving) {
      if (mode === 'error') {
        const bang = iconCanvas('bang', u, '#E5534B', null, '#14151F');
        const bounce = view.reduced ? 0 : Math.round(Math.abs(Math.sin(t * 5)) * 4) * u;
        if (bang) { ctx.drawImage(bang, sx - Math.round(bang.width / 2), top - bang.height - bounce); top -= bang.height + 4 * u; widen(bang.width); }
      } else if (mode === 'sleep') {
        const zc = iconCanvas('z', u, '#E8E6FF', null, '#14151F');
        if (zc) {
          for (let k = 0; k < 3; k++) {
            const p = view.reduced ? k / 3 : (t * 0.45 + k / 3) % 1;
            ctx.globalAlpha = a0 * this.alpha * (1 - p);
            ctx.drawImage(zc, tagX + tag.w + u + Math.round(p * 6 + k) * u, tagY + Math.round(tag.h / 2) - Math.round(p * 14) * u - zc.height);
          }
          ctx.globalAlpha = a0 * this.alpha;
        }
      }
      const b = this.bubble;
      const label = b ? b.text : '';
      const active = b && t < b.until;
      const say = this.sayB && t < this.sayB.until ? this.sayB : null;
      const emo = this.emo && t < this.emo.until ? this.emo : null;
      if (label && (selected || hovered || (active && !view.compact))) {
        const bc = bubbleCanvas(label, b.style, view);
        const left = active ? b.until - t : 1;
        const k = view.reduced || selected || hovered ? 1 : clamp(left / 0.25, 0, 1);
        if (k >= 1 && bc.img) {
          ctx.drawImage(bc.img, sx - Math.round(bc.w / 2), top - bc.h);
          top -= bc.h + u;
          widen(bc.w);
        } else {
          // Shrinking toward the icon bubble.
          const ib = iconBubble(iconFor(this.agent, mode), this.color, view);
          const w = Math.round((ib.w + (bc.w - ib.w) * k) / u) * u;
          const h = ib.h - 3 * u;
          const cv = cacheGet('sb|' + w + '|' + h + '|' + u, () => {
            const c2 = S.makeCanvas(w, h + 3 * u);
            if (c2) paintBubble(c2.getContext('2d'), 0, 0, w, h, u, '#F7F4EC');
            return c2;
          });
          if (cv) ctx.drawImage(cv, sx - Math.round(w / 2), top - h - 3 * u);
          const ic = iconCanvas(iconFor(this.agent, mode), u, '#14151F', this.color);
          if (ic) ctx.drawImage(ic, sx - Math.round(ic.width / 2), top - h - 3 * u + 3 * u);
          top -= h + 4 * u;
          widen(w);
        }
      } else if (mode === 'think' && !say) {
        this._drawThought(ctx, sx, top, u, t, view.reduced);
        top -= 12 * u;
        widen(21 * u);
      } else if (mode && mode !== 'error' && mode !== 'sleep' && this.state !== 'spawning' && !say && !emo && c && c.key !== 'scene') {
        const ib = iconBubble(mode === 'done' ? 'done' : iconFor(this.agent, mode), this.color, view);
        if (ib.img) { ctx.drawImage(ib.img, sx - Math.round(ib.w / 2), top - ib.h); top -= ib.h + u; widen(ib.w); }
      }
      if (say) {
        const sb = sayBubble(say.icon, view);
        if (sb.img) {
          const age = t - say.t0;
          const hop = view.reduced || age > 0.12 ? 0 : Math.round((1 - age / 0.12) * 3) * u;
          ctx.drawImage(sb.img, sx - Math.round(sb.w / 2), top - sb.h + hop);
          top -= sb.h + u;
          widen(sb.w);
        }
      }
      if (emo) {
        const es = Math.max(u, Math.min(3 * u, Math.round(view.z * 0.75)));
        const ic = emoteCanvas(emo.icon, es);
        if (ic) {
          const age = t - emo.t0, left = emo.until - t;
          let s = 1;
          if (!view.reduced && age < 0.24) s = age < 0.12 ? 0.5 + (age / 0.12) * 0.8 : 1.3 - ((age - 0.12) / 0.12) * 0.3;
          const bob = view.reduced ? 0 : Math.round(Math.sin(age * 4) * 1.5) * u;
          ctx.globalAlpha = a0 * this.alpha * clamp(left / 0.3, 0, 1);
          const w = Math.round(ic.width * s), h = Math.round(ic.height * s);
          ctx.drawImage(ic, sx - Math.round(w / 2), top - h - u + bob, w, h);
          ctx.globalAlpha = a0 * this.alpha;
          top -= ic.height + 2 * u;
          widen(ic.width);
        }
      }
    }
    // "NIVEAU N !" (+ the new title under it) pops above the stack after a level-up.
    const lf = this.levelFx;
    if (lf && t - lf.t0 < 2.8) {
      const q = (t - lf.t0) / 2.8;
      const big = view.font.replace(/(\d+)px/, (m, n0) => Math.max(Number(n0), Math.round((Number(n0) * 1.5) / 8) * 8) + 'px');
      const bfs = Number((/(\d+)px/.exec(big) || [0, view.fs])[1]) || view.fs;
      const rise = view.reduced ? 0 : Math.round(Math.min(1, q * 3) * 6) * u;
      const title = titleOf(lf.level);
      const ty = top - Math.round(view.fs / 2) - u - rise;
      const y = (title ? ty - Math.round(view.fs / 2) - 2 * u : top - rise) - Math.round(bfs / 2) - u;
      ctx.globalAlpha = a0 * this.alpha * (q < 0.75 ? 1 : 1 - (q - 0.75) / 0.25);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (title) {
        ctx.font = view.font;
        ctx.fillStyle = '#14151F';
        ctx.fillText(title, sx + u, ty + u); ctx.fillText(title, sx - u, ty - u); ctx.fillText(title, sx + u, ty - u); ctx.fillText(title, sx - u, ty + u);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(title, sx, ty);
      }
      const txt = 'NIVEAU ' + lf.level + ' !';
      ctx.font = big;
      ctx.fillStyle = '#14151F';
      ctx.fillText(txt, sx + u, y + u); ctx.fillText(txt, sx - u, y + u); ctx.fillText(txt, sx + u, y - u); ctx.fillText(txt, sx - u, y - u);
      ctx.fillStyle = (Math.floor(t * 8) % 2 && !view.reduced) ? '#FFFFFF' : '#FFD84A';
      ctx.fillText(txt, sx, y);
      ctx.globalAlpha = a0 * this.alpha;
      // Part of the layout box, so the engine lifts neighbouring name tags out of the way.
      widen(Math.ceil(measure(big, txt)) + 4 * u);
      top = y - Math.round(bfs / 2) - u;
    }
    // Token popups rise and fade.
    if (this.popups.length) {
      ctx.font = view.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const p of this.popups) {
        const q = clamp((t - p.t0) / 1.6, 0, 1);
        const y = top - 4 * u - Math.round(q * 26) * u;
        ctx.globalAlpha = a0 * this.alpha * (q < 0.65 ? 1 : 1 - (q - 0.65) / 0.35);
        ctx.fillStyle = '#14151F';
        ctx.fillText(p.text, sx + u, y + u);
        ctx.fillText(p.text, sx - u, y);
        ctx.fillText(p.text, sx + u, y - u);
        ctx.fillStyle = '#F2C14E';
        ctx.fillText(p.text, sx, y);
      }
    }
    ctx.globalAlpha = a0;
    box.y0 = Math.min(box.y0, top);
    return box;
  };

  Character.prototype._drawThought = function (ctx, sx, top, u, t, reduced) {
    const w = 15 * u, h = 8 * u;
    const x = sx - Math.round(w / 2) + 3 * u, y = top - h - 3 * u;
    ctx.fillStyle = '#14151F';
    ctx.fillRect(x + u, y, w - 2 * u, h);
    ctx.fillRect(x, y + u, w, h - 2 * u);
    ctx.fillRect(sx - 2 * u, top - 3 * u, 3 * u, 3 * u);
    ctx.fillRect(sx - 4 * u, top, 2 * u, 2 * u);
    ctx.fillStyle = '#F7F4EC';
    ctx.fillRect(x + u, y + u, w - 2 * u, h - 2 * u);
    ctx.fillRect(sx - u, top - 2 * u, u, u);
    const dots = reduced ? 3 : 1 + (Math.floor(t * 2.5 + this.phase) % 3);
    ctx.fillStyle = '#14151F';
    for (let k = 0; k < dots; k++) ctx.fillRect(x + 4 * u + k * 3 * u, y + 3 * u, 2 * u, 2 * u);
  };

  // ------------------------------------------------------------------ World
  function World(office) {
    this.office = office;
    this.time = 0;
    this.chars = new Map();
    this.particles = [];
    this.fx = [];              // screen-space effects in world coords: rockets, sparks, hearts
    this.arcs = [];            // flying items (paper hand-over, letters into mailboxes)
    this.reduced = false;
    this.selectedId = null;    // set by the engine every frame (spotlight)
    this.hours = 12;
    this.onEvent = null;       // optional push callback; otherwise events queue for takeEvents()
    this._spawnToggle = 0;
    this._exitToggle = 0;
    this._spawn = null;
    this._coins = [];
    this._events = [];
    this._chatTimer = 2;
    this._pathBudget = 8;
  }

  /** office.ping wrapper (elevator, tests, post, coffee); ambient only, never throws. */
  World.prototype.ping = function (what, arg) {
    const off = this.office;
    if (!off || typeof off.ping !== 'function') return;
    try { off.ping(what, arg); } catch (e) { /* ambient only */ }
  };

  World.prototype.emit = function (ev) {
    if (typeof this.onEvent === 'function') {
      try { this.onEvent(ev); } catch (e) { /* host callback */ }
      return;
    }
    this._events.push(ev);
    if (this._events.length > 64) this._events.shift();
  };
  /** Events since the last call ({ type: "levelup", id, level, title, name, color }). */
  World.prototype.takeEvents = function () {
    if (!this._events.length) return EMPTY;
    const out = this._events;
    this._events = [];
    return out;
  };

  World.prototype.pushCoin = function (x, y, value, color, id) {
    this._coins.push({ x, y, value, color: color || '#F2C14E', id: id || null });
    if (this._coins.length > 80) {
      // Never lose value: fold the oldest coin into the next one.
      const old = this._coins.shift();
      this._coins[0].value += old.value;
    }
  };
  /** Coins spawned since the last call: [{ x, y (world px), value, color, id }]; values sum to the token deltas. */
  World.prototype.takeCoins = function () {
    if (!this._coins.length) return EMPTY;
    const out = this._coins;
    this._coins = [];
    return out;
  };

  World.prototype.setTimeOfDay = function (h) { const n = Number(h); if (isFinite(n)) this.hours = n; };

  /** Elevator tiles (spawn / exit), tolerant of maps without spawnTiles. */
  World.prototype.spawnTiles = function () {
    if (this._spawn) return this._spawn;
    const off = this.office;
    let list = Array.isArray(off.spawnTiles) && off.spawnTiles.length ? off.spawnTiles : null;
    if (!list && Array.isArray(off.exitTiles) && off.exitTiles.length) list = off.exitTiles;
    if (!list) {
      const r = rectOf(getRoom(off, 'lobby') || getRoom(off, 'entrance'));
      const cols = off.cols || Math.round((off.width || 0) / T) || 1;
      const rows = off.rows || Math.round((off.height || 0) / T) || 1;
      const t = r ? off.nearestWalkable(r.x + Math.floor(r.w / 2), r.y + r.h - 1) : off.nearestWalkable(Math.floor(cols / 2), rows - 2);
      list = [t || { x: 1, y: 1 }];
    }
    this._spawn = list;
    return list;
  };
  World.prototype.exitTiles = function () {
    const off = this.office;
    if (Array.isArray(off.exitTiles) && off.exitTiles.length) return off.exitTiles;
    return this.spawnTiles();
  };

  World.prototype.upsert = function (agent) {
    if (!agent || typeof agent !== 'object' || typeof agent.id !== 'string' || !agent.id) return null;
    let ch = this.chars.get(agent.id);
    if (ch && ch.state === 'gone') { this.chars.delete(agent.id); ch = null; }
    if (!ch) {
      ch = new Character(this, agent);
      this.chars.set(agent.id, ch);
    } else {
      ch.setAgent(agent);
    }
    return ch;
  };
  World.prototype.remove = function (id) { const ch = this.chars.get(id); if (ch) ch.leave(); };
  World.prototype.get = function (id) { const ch = this.chars.get(id); return ch && ch.state !== 'gone' ? ch : null; };
  World.prototype.flash = function (id, entry) { const ch = this.get(id); if (ch) ch.flash(entry); };
  World.prototype.tokens = function (id, delta) {
    const ch = this.get(id);
    if (ch && !ch.leaving) { ch.addTokens(delta); return; }
    const v = Number(delta);
    if (v > 0) {
      // Unknown / leaving agent: the coins still reach the counter, from the elevator.
      const e = this.spawnTiles()[0];
      const p = this.office.tileCenter(e.x, e.y);
      this.pushCoin(ch ? ch.x : p.x, (ch ? ch.y : p.y) - 16, v, ch ? ch.color : null, id);
    }
  };
  World.prototype.list = function () {
    const out = [];
    for (const ch of this.chars.values()) if (ch.state !== 'gone') out.push(ch);
    return out;
  };

  World.prototype.update = function (dt) {
    dt = clamp(Number(dt) || 0, 0, 0.25);
    this.time += dt;
    this._pathBudget = 8;
    for (const ch of this.chars.values()) ch.tick(dt);
    for (const [id, ch] of this.chars) {
      if (ch.state === 'gone') {
        ch._flushCoins();
        this.office.releaseSpot(id);
        this.office.freeDesk(id);
        this.chars.delete(id);
      }
    }
    stepList(this.particles, dt);
    this._stepFx(dt);
    if (this.arcs.length) {
      let j = 0;
      for (let i = 0; i < this.arcs.length; i++) {
        const a = this.arcs[i];
        a.t += dt;
        if (a.t < a.dur) this.arcs[j++] = a;
      }
      this.arcs.length = j;
    }
    this._chatTimer -= dt;
    if (this._chatTimer <= 0) { this._chatTimer = 1.5; this._startChats(); }
    if (typeof this.office.updateAmbient === 'function') {
      try { this.office.updateAmbient(dt, this.chars.values()); } catch (e) { /* ambient only */ }
    }
  };

  function stepList(list, dt) {
    if (!list.length) return;
    let j = 0;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      p.life += dt;
      if (p.life >= p.max) continue;
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt;
      list[j++] = p;
    }
    list.length = j;
  }

  World.prototype._stepFx = function (dt) {
    const fx = this.fx;
    if (!fx.length) return;
    let j = 0;
    const born = this._born || (this._born = []);
    born.length = 0;
    for (let i = 0; i < fx.length; i++) {
      const p = fx[i];
      if (p.delay > 0) { p.delay -= dt; fx[j++] = p; continue; }
      p.life += dt;
      if (p.kind === 'rocket' && p.life >= p.max) {
        // Burst into a ring of sparks.
        const n = this.reduced ? 8 : 18;
        for (let k = 0; k < n; k++) {
          const ang = (k / n) * Math.PI * 2 + rand() * 0.3;
          const sp = 26 + rand() * 22;
          born.push({ kind: 'spark', x: p.x, y: p.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 6, g: 22, life: 0, max: 0.9 + rand() * 0.5, delay: 0,
            color: k % 3 === 0 ? p.color : FIREWORK_COLORS[(k + p.seed) % FIREWORK_COLORS.length] });
        }
        continue;
      }
      if (p.life >= p.max) continue;
      p.x += p.vx * dt; p.y += p.vy * dt; p.vy += p.g * dt;
      if (p.kind === 'heart') p.vx = Math.sin(p.life * 6 + p.seed) * 8;
      fx[j++] = p;
    }
    fx.length = j;
    for (let i = 0; i < born.length; i++) fx.push(born[i]);
    if (fx.length > 500) fx.splice(0, fx.length - 500);
  };

  /** Idle chats: two idle characters close to each other in the cafe / on the terrace turn and chat. */
  World.prototype._startChats = function () {
    const now = this.time;
    const cand = [];
    for (const ch of this.chars.values()) {
      if (!ch.isSettled() || ch.scene || now < ch.chatCooldown) continue;
      const c = ch.committed;
      if ((c.room === 'cafe' || c.room === 'terrace') && (c.mode === 'idle' || c.mode === 'done')) cand.push(ch);
    }
    if (cand.length < 2) return;
    for (let i = 0; i < cand.length; i++) {
      for (let j = i + 1; j < cand.length; j++) {
        const a = cand[i], b = cand[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        if (dx * dx + dy * dy > (3.6 * T) * (3.6 * T) || rand() > 0.3) continue;
        const n = 3 + (rand() < 0.5 ? 1 : 0);
        const lines = [];
        for (let k = 0; k < n; k++) lines.push({ lead: k % 2 === 0, icon: CHAT_ICONS[Math.floor(rand() * CHAT_ICONS.length)], at: 0.2 + k * 1.1 });
        const end = now + 0.2 + n * 1.1 + 0.3;
        a.scene = { type: 'chat', partnerId: b.id, t0: now, lines, step: 0, leader: true, end };
        b.scene = { type: 'chat', partnerId: a.id, t0: now, lines: null, step: 0, leader: false, end };
        a._faceEachOther(b, 0.4);
        return;
      }
    }
  };

  /** Little particle bursts (world space): "spark" (spawn / exit), "check" (done ✓), "coin" (gold glints). */
  World.prototype.burst = function (x, y, color, type) {
    const n = type === 'check' ? (this.reduced ? 1 : 5) : type === 'coin' ? (this.reduced ? 1 : 4) : (this.reduced ? 3 : 10);
    for (let k = 0; k < n; k++) {
      this.particles.push({
        x: x + (rand() - 0.5) * 12, y: y + (rand() - 0.5) * 8,
        vx: (rand() - 0.5) * 26, vy: type === 'check' ? -12 - rand() * 10 : -8 - rand() * 24,
        g: type === 'check' ? 0 : 20, life: 0, max: type === 'check' ? 1.1 + rand() * 0.5 : type === 'coin' ? 0.4 + rand() * 0.3 : 0.6 + rand() * 0.6,
        type, color: type === 'check' ? '#6CC28A' : type === 'coin' ? (k % 2 ? '#FFF3B0' : '#F2C14E') : (k % 3 === 0 ? '#FFFFFF' : k % 3 === 1 ? '#F2C14E' : color)
      });
    }
    if (this.particles.length > 400) this.particles.splice(0, this.particles.length - 400);
  };

  /** Level-up fireworks around (x, y) (drawn in screen space so night lighting does not dim them). */
  World.prototype.fireworks = function (x, y, color) {
    const rockets = this.reduced ? 1 : 3;
    for (let r = 0; r < rockets; r++) {
      const ox = rockets === 1 ? 0 : (r - 1) * 14;
      this.fx.push({ kind: 'rocket', x: x + ox * 0.3, y, vx: ox * 0.9, vy: this.reduced ? 0 : -70 - rand() * 18, g: 40, life: 0,
        max: this.reduced ? 0.01 : 0.45 + r * 0.08, delay: r * 0.22, color: S.normHex(color), seed: Math.floor(rand() * 6) });
    }
  };

  /** Floating hearts (pets purring, happy moments). */
  World.prototype.hearts = function (x, y, n) {
    const count = this.reduced ? 1 : Math.max(1, Math.min(6, n | 0 || 3));
    for (let k = 0; k < count; k++) {
      this.fx.push({ kind: 'heart', x: x + (rand() - 0.5) * 8, y, vx: 0, vy: -14 - rand() * 8, g: 0, life: 0, max: 1.2 + rand() * 0.5,
        delay: k * 0.18, color: '#E5534B', seed: rand() * 6 });
    }
  };

  /** An item flying along a small arc from (x0, y0) to (x1, y1) in world px. */
  World.prototype.arc = function (x0, y0, x1, y1, item, color, dur) {
    if (this.arcs.length > 60) this.arcs.shift();
    this.arcs.push({ x0, y0, x1, y1, item, color: S.normHex(color), t: 0, dur: Math.max(0.15, dur || 0.6) });
  };

  World.prototype.drawParticles = function (ctx) {
    const a0 = ctx.globalAlpha;
    for (const p of this.particles) {
      const q = p.life / p.max;
      ctx.globalAlpha = a0 * (1 - q * q);
      const x = Math.round(p.x), y = Math.round(p.y);
      ctx.fillStyle = p.color;
      if (p.type === 'check') {
        ctx.fillRect(x + 3, y - 2, 1, 1); ctx.fillRect(x + 2, y - 1, 1, 1);
        ctx.fillRect(x + 1, y, 1, 1); ctx.fillRect(x, y - 1, 1, 1); ctx.fillRect(x - 1, y - 2, 1, 1);
      } else if (q < 0.5) {
        ctx.fillRect(x - 1, y, 3, 1); ctx.fillRect(x, y - 1, 1, 3);
      } else {
        ctx.fillRect(x, y, 1, 1);
      }
    }
    ctx.globalAlpha = a0;
  };

  /**
   * World-level screen-space effects, drawn after the lighting layer and before the name tags:
   * selection spotlight, flying items, fireworks, hearts. view: { ox, oy, z, u, reduced }.
   */
  World.prototype.drawOverlays = function (ctx, view) {
    const z = view.z, a0 = ctx.globalAlpha;
    const sel = this.selectedId ? this.get(this.selectedId) : null;
    if (sel && sel.alpha > 0.05 && typeof S.spotlight === 'function') {
      const sp = S.spotlight();
      if (sp) {
        const op = ctx.globalCompositeOperation;
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = a0 * sel.alpha * (this.reduced ? 0.45 : 0.4 + 0.08 * Math.sin(this.time * 2.5));
        ctx.drawImage(sp, Math.round(view.ox + (sel.x - 20) * z), Math.round(view.oy + (sel.y - 66) * z), Math.round(40 * z), Math.round(72 * z));
        ctx.globalCompositeOperation = op;
        ctx.globalAlpha = a0;
      }
    }
    for (const a of this.arcs) {
      const k = clamp(a.t / a.dur, 0, 1);
      const e = k * k * (3 - 2 * k);
      const wx = a.x0 + (a.x1 - a.x0) * e;
      const wy = a.y0 + (a.y1 - a.y0) * e - Math.sin(Math.PI * k) * 14;
      const it = S.accessory(a.item, a.color);
      if (!it || !it.img) continue;
      const w = Math.round(it.w * z), h = Math.round(it.h * z);
      ctx.drawImage(it.img, Math.round(view.ox + wx * z - w / 2), Math.round(view.oy + wy * z - h / 2), w, h);
    }
    const px = Math.max(1, Math.round(z * 0.75));
    for (const p of this.fx) {
      if (p.delay > 0) continue;
      const q = p.life / p.max;
      const sx = Math.round(view.ox + p.x * z), sy = Math.round(view.oy + p.y * z);
      if (p.kind === 'rocket') {
        ctx.globalAlpha = a0;
        ctx.fillStyle = '#FFF3B0';
        ctx.fillRect(sx - px, sy - px, px * 2, px * 2);
        ctx.fillStyle = p.color;
        ctx.fillRect(sx - Math.floor(px / 2), sy + px, px, px * 3);
      } else if (p.kind === 'spark') {
        ctx.globalAlpha = a0 * (1 - q * q);
        ctx.fillStyle = p.color;
        if (q < 0.45) { ctx.fillRect(sx - px, sy, px * 3, px); ctx.fillRect(sx, sy - px, px, px * 3); }
        else ctx.fillRect(sx, sy, px, px);
      } else if (p.kind === 'heart') {
        ctx.globalAlpha = a0 * (q < 0.7 ? 1 : 1 - (q - 0.7) / 0.3);
        const ic = P && P.iconCanvas ? P.iconCanvas('heart', Math.max(1, Math.round(z * 0.5))) : null;
        if (ic) ctx.drawImage(ic, sx - Math.round(ic.width / 2), sy - ic.height);
        else { ctx.fillStyle = p.color; ctx.fillRect(sx - px, sy - px, px * 2, px * 2); }
      }
    }
    ctx.globalAlpha = a0;
  };

  /** Thin dashed lines from each visible subagent to its parent (screen space). */
  World.prototype.drawLinks = function (ctx, view) {
    const u = view.u;
    let any = false;
    for (const ch of this.chars.values()) {
      if (!ch.agent || ch.agent.kind !== 'sub' || !ch.agent.parentId || ch.state === 'gone') continue;
      const p = this.get(ch.agent.parentId);
      if (!p) continue;
      const a = Math.min(ch.alpha, p.alpha);
      if (a < 0.3) continue;
      if (!any) {
        any = true;
        ctx.save();
        ctx.lineWidth = Math.max(1, u);
        ctx.setLineDash([3 * u, 3 * u]);
        ctx.lineDashOffset = view.reduced ? 0 : -(this.time * 14 * u) % (6 * u);
      }
      ctx.globalAlpha = 0.55 * a;
      ctx.strokeStyle = ch.color;
      ctx.beginPath();
      ctx.moveTo(view.ox + ch.x * view.z, view.oy + (ch.y - 7) * view.z);
      ctx.lineTo(view.ox + p.x * view.z, view.oy + (p.y - 7) * view.z);
      ctx.stroke();
    }
    if (any) ctx.restore();
  };

  /** Topmost character under a world point (generous box around the sprite). */
  World.prototype.hitTest = function (wx, wy, pad) {
    const m = pad == null ? 3 : pad;
    let best = null;
    for (const ch of this.chars.values()) {
      if (ch.state === 'gone' || ch.leaving || ch.alpha < 0.2) continue;
      if (wx >= ch.x - 10 - m && wx <= ch.x + 10 + m && wy >= ch.y - 17 - m && wy <= ch.y + 2 + m) {
        if (!best || ch.y > best.y) best = ch;
      }
    }
    return best ? best.id : null;
  };

  global.HQCharacters = {
    World, Character, formatTokens, truncate, desireOf, bashRoom, dir8, smoothPath, clearLine,
    clearTextCache, KIND_ROOM, ICONS
  };
})(typeof window !== 'undefined' ? window : globalThis);
