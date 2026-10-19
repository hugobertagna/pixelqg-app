'use strict';

// Terminal availability: automatic compilation of the ConPTY bridge and the "unsupported" path.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AgentManager } = require('../agents');
const { TerminalManager, BRIDGE_SOURCE } = require('../terminals');
const { startServer } = require('../server');
const { makePublicDir, request, tmpDir } = require('./helpers');

const winSkip = process.platform !== 'win32' ? 'Windows uniquement' : false;

test('bridge: compiled when missing, recompiled when older than its source, old exe kept on failure', { skip: winSkip }, async () => {
  const dir = tmpDir('pixelqg-app-bridge-');
  const src = path.join(dir, 'hq-pty.cs');
  const exe = path.join(dir, 'hq-pty.exe');
  fs.copyFileSync(BRIDGE_SOURCE, src);
  // copyFileSync keeps the original modification time on Windows: pin it to "now" so the
  // "exe older than its source" checks below do not depend on when hq-pty.cs was last edited.
  const now = new Date();
  fs.utimesSync(src, now, now);
  const make = () => new TerminalManager({ manager: new AgentManager({ claude: null }), bridgePath: exe, bridgeSource: src });

  const first = make();
  assert.deepEqual(await first.init(), { supported: true, reason: null, shell: 'cmd.exe' });
  assert.ok(fs.statSync(exe).size > 0, 'compiled');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['hq-pty.cs', 'hq-pty.exe'], 'no temporary build file left');

  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(exe, old, old);
  await make().init();
  assert.ok(fs.statSync(exe).mtimeMs > old.getTime() + 1000, 'outdated exe rebuilt');

  // A broken source with an existing exe: warning, the previous bridge is used.
  fs.appendFileSync(src, '\nceci ne compile pas');
  fs.utimesSync(exe, old, old);
  const broken = make();
  assert.equal((await broken.init()).supported, true);
  assert.equal(broken.warnings.length, 1);
  assert.match(broken.warnings[0], /n’a pas pu être recompilé/);

  // A broken source without exe: unavailable, with a French reason.
  fs.rmSync(exe);
  const none = make();
  const cfg = await none.init();
  assert.equal(cfg.supported, false);
  assert.match(cfg.reason, /Impossible de préparer le terminal intégré : la compilation de hq-pty\.exe a échoué/);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.exe')), 'no partial exe left');
});

test('terminal unavailable: config says why, routes answer 501', async (t) => {
  const app = await startServer({
    port: 0,
    observe: false,
    publicDir: makePublicDir(),
    claude: null,
    skipVersion: true,
    watcher: { projectsDir: tmpDir('pixelqg-app-projects-'), autoPoll: false },
    terminals: { platform: 'aix' }, // macOS and Linux have an (experimental) terminal now
  });
  t.after(() => app.close());
  const auth = { 'X-HQ-Token': app.token };
  const cfg = (await request(app.port, { path: '/api/config', headers: auth })).json.config;
  assert.equal(cfg.terminal.supported, false);
  assert.equal(typeof cfg.terminal.shell, 'string');
  assert.match(cfg.terminal.reason, /Windows/);
  assert.deepEqual((await request(app.port, { path: '/api/terminals', headers: auth })).json, { ok: true, terminals: [] });
  const create = await request(app.port, { method: 'POST', path: '/api/terminals', headers: auth, body: {} });
  assert.equal(create.status, 501);
  assert.match(create.json.error, /Windows/);
  assert.equal((await request(app.port, { method: 'POST', path: '/api/terminals/t1/link', headers: auth, body: {} })).status, 501);
});
