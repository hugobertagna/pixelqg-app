'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { startServer, parseArgs } = require('../server');
const { FAKE_CLAUDE, makePublicDir, request, waitFor, sseConnect, tmpDir } = require('./helpers');

const fakeClaude = { command: process.execPath, prefixArgs: [FAKE_CLAUDE], path: FAKE_CLAUDE };

test('HTTP guards, static files and REST routes', async (t) => {
  const app = await startServer({
    license: { bypass: true },
    port: 0,
    observe: false,
    publicDir: makePublicDir(),
    claude: fakeClaude,
    skipVersion: true,
    demoSpeed: 200,
    watcher: { projectsDir: tmpDir('pixelqg-app-projects-'), autoPoll: false },
  });
  t.after(() => app.close());
  const { port, token } = app;
  const auth = { 'X-HQ-Token': token };

  await t.test('401 without or with a wrong token', async () => {
    const none = await request(port, { path: '/api/agents' });
    assert.equal(none.status, 401);
    assert.equal(none.json.ok, false);
    assert.match(none.json.error, /Jeton/);
    const wrong = await request(port, { path: '/api/agents', headers: { 'X-HQ-Token': 'x'.repeat(48) } });
    assert.equal(wrong.status, 401);
    const shorter = await request(port, { path: '/api/agents', headers: { 'X-HQ-Token': token.slice(0, -1) } });
    assert.equal(shorter.status, 401);
    // The query-string token is only accepted for the event stream.
    const query = await request(port, { path: `/api/agents?token=${token}` });
    assert.equal(query.status, 401);
    const ok = await request(port, { path: '/api/agents', headers: auth });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json, { ok: true, agents: [] });
  });

  await t.test('403 on a foreign Host header (DNS rebinding)', async () => {
    const bad = await request(port, { path: '/', headers: { Host: `evil.example:${port}` } });
    assert.equal(bad.status, 403);
    assert.ok(!bad.text.includes(token));
    const badPort = await request(port, { path: '/api/config', headers: { ...auth, Host: '127.0.0.1:1' } });
    assert.equal(badPort.status, 403);
    const localhost = await request(port, { path: '/api/config', headers: { ...auth, Host: `localhost:${port}` } });
    assert.equal(localhost.status, 200);
  });

  await t.test('403 on a foreign Origin header', async () => {
    const bad = await request(port, { path: '/api/config', headers: { ...auth, Origin: 'http://evil.example' } });
    assert.equal(bad.status, 403);
    const nul = await request(port, { path: '/api/config', headers: { ...auth, Origin: 'null' } });
    assert.equal(nul.status, 403);
    const good = await request(port, { path: '/api/config', headers: { ...auth, Origin: `http://localhost:${port}` } });
    assert.equal(good.status, 200);
  });

  await t.test('index.html carries the token, other files do not', async () => {
    const home = await request(port, { path: '/' });
    assert.equal(home.status, 200);
    assert.match(home.headers['content-type'], /^text\/html/);
    assert.equal(home.headers['cache-control'], 'no-store');
    assert.ok(home.text.includes(token));
    assert.ok(!home.text.includes('__HQ_TOKEN__'));
    assert.ok(home.headers['content-security-policy']);
    const index = await request(port, { path: '/index.html' });
    assert.ok(index.text.includes(token));
    const js = await request(port, { path: '/js/app.js' });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /^text\/javascript/);
    assert.equal(js.headers['cache-control'], 'no-store');
    assert.equal(js.text, 'window.APP_OK = true;\n');
    const css = await request(port, { path: '/style.css' });
    assert.match(css.headers['content-type'], /^text\/css/);
    const unknownType = await request(port, { path: '/notes.xyz' });
    assert.equal(unknownType.status, 404);
    const missing = await request(port, { path: '/absent.js' });
    assert.equal(missing.status, 404);
  });

  await t.test('path traversal is blocked', async () => {
    const attempts = [
      '/..%2f..%2fpackage.json',
      '/..%2fserver%2fserver.js',
      '/%2e%2e/%2e%2e/server/server.js',
      '/..%5c..%5cserver%5cserver.js',
      '/js/..%2f..%2f..%2fserver%2fserver.js',
      '/..\\..\\server\\server.js',
      '/js/../../server/server.js',
      '/%00index.html',
    ];
    for (const p of attempts) {
      const res = await request(port, { path: p });
      assert.notEqual(res.status, 200, `${p} must not be served`);
      assert.ok(!res.text.includes('startServer'), `${p} leaked a server file`);
      assert.ok(!res.text.includes(token), `${p} leaked the token`);
    }
  });

  await t.test('POST bodies: JSON only, 1 MB max', async () => {
    const plain = await request(port, { method: 'POST', path: '/api/agents', headers: { ...auth, 'Content-Type': 'text/plain' }, rawBody: '{"prompt":"x"}' });
    assert.equal(plain.status, 415);
    assert.match(plain.json.error, /JSON/);
    const form = await request(port, { method: 'POST', path: '/api/agents', headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' }, rawBody: 'prompt=x' });
    assert.equal(form.status, 415);
    const big = await request(port, { method: 'POST', path: '/api/agents', headers: auth, body: { prompt: 'x'.repeat(1024 * 1024 + 10) } });
    assert.ok(big.status === 413 || big.status === 0, `expected 413, got ${big.status}`);
    const broken = await request(port, { method: 'POST', path: '/api/agents', headers: { ...auth, 'Content-Type': 'application/json; charset=utf-8' }, rawBody: '{"prompt":' });
    assert.equal(broken.status, 400);
    assert.match(broken.json.error, /JSON invalide/);
  });

  await t.test('validation errors are French 400s', async () => {
    const empty = await request(port, { method: 'POST', path: '/api/agents', headers: auth, body: { prompt: '' } });
    assert.equal(empty.status, 400);
    assert.equal(empty.json.error, 'Le prompt est requis.');
    const color = await request(port, { method: 'POST', path: '/api/agents', headers: auth, body: { prompt: 'p', color: 'bleu' } });
    assert.equal(color.status, 400);
    assert.match(color.json.error, /Couleur invalide/);
    const cwd = await request(port, { method: 'POST', path: '/api/agents', headers: auth, body: { prompt: 'p', cwd: 'pas/absolu' } });
    assert.equal(cwd.status, 400);
    assert.match(cwd.json.error, /chemin absolu/);
    const mode = await request(port, { method: 'POST', path: '/api/agents', headers: auth, body: { prompt: 'p', permissionMode: 'tout' } });
    assert.equal(mode.status, 400);
  });

  await t.test('config, 404 and 405', async () => {
    const res = await request(port, { path: '/api/config', headers: auth });
    const c = res.json.config;
    assert.equal(c.version, '1.0.0');
    assert.equal(c.port, port);
    assert.equal(c.claudeFound, true);
    assert.equal(c.claudePath, FAKE_CLAUDE);
    assert.equal(c.models.length, 5);
    assert.equal(c.models[0].value, '');
    assert.equal(c.models[0].label, 'Par défaut');
    assert.deepEqual(c.permissionModes.find((p) => p.value === 'bypassPermissions'), { value: 'bypassPermissions', label: 'Tout autoriser (dangereux)', danger: true });
    assert.equal(c.colors.length, 12);
    assert.equal(c.colors[0], '#D97757');
    assert.equal(c.observe, false);
    assert.equal(c.demo, false);
    assert.equal(typeof c.defaultCwd, 'string');

    const logs = await request(port, { path: '/api/agents/a99/logs', headers: auth });
    assert.equal(logs.status, 404);
    assert.equal(logs.json.error, 'Agent introuvable.');
    const del = await request(port, { method: 'DELETE', path: '/api/agents/a99', headers: auth });
    assert.equal(del.status, 404);
    const route = await request(port, { path: '/api/nimporte', headers: auth });
    assert.equal(route.status, 404);
    const method = await request(port, { method: 'PUT', path: '/api/agents', headers: auth });
    assert.equal(method.status, 405);
    const stopGet = await request(port, { path: '/api/agents/a1/stop', headers: auth });
    assert.equal(stopGet.status, 405);
  });

  await t.test('observe toggle', async () => {
    const bad = await request(port, { method: 'POST', path: '/api/observe', headers: auth, body: { enabled: 'oui' } });
    assert.equal(bad.status, 400);
    const on = await request(port, { method: 'POST', path: '/api/observe', headers: auth, body: { enabled: true } });
    assert.equal(on.status, 200);
    assert.equal(on.json.config.observe, true);
    const off = await request(port, { method: 'POST', path: '/api/observe', headers: auth, body: { enabled: false } });
    assert.equal(off.json.config.observe, false);
  });

  await t.test('demo routes start and remove simulated agents', async () => {
    const sse = sseConnect(port, token);
    await sse.ready;
    const bad = await request(port, { method: 'POST', path: '/api/demo', headers: auth, body: { count: 9 } });
    assert.equal(bad.status, 400);
    const started = await request(port, { method: 'POST', path: '/api/demo', headers: auth, body: { count: 2 } });
    assert.equal(started.status, 200);
    assert.equal(started.json.agents.length, 2);
    assert.ok(started.json.agents.every((a) => a.source === 'demo' && a.id.startsWith('d') && a.canControl === true));
    const cfg = await request(port, { path: '/api/config', headers: auth });
    assert.equal(cfg.json.config.demo, true);
    await waitFor(() => sse.events.some((e) => e.event === 'tokens'), 10000, 'tokens event from demo');
    await waitFor(() => sse.events.some((e) => e.event === 'log'), 10000, 'log event from demo');
    const stop = await request(port, { method: 'POST', path: '/api/demo/stop', headers: auth });
    assert.equal(stop.status, 200);
    const list = await request(port, { path: '/api/agents', headers: auth });
    assert.equal(list.json.agents.filter((a) => a.source === 'demo').length, 0);
    await waitFor(() => sse.events.filter((e) => e.event === 'remove').length >= 2, 5000, 'remove events');
    sse.close();
  });
});

test('CLI argument parsing', () => {
  assert.deepEqual(parseArgs([]), { port: null, demo: false, observe: true, open: false, help: false });
  assert.deepEqual(parseArgs(['--demo', '--no-observe', '--open', '--port', '5000']), { port: 5000, demo: true, observe: false, open: true, help: false });
  assert.equal(parseArgs(['--port=4400']).port, 4400);
  assert.throws(() => parseArgs(['--port', 'abc']), /Port invalide/);
  assert.throws(() => parseArgs(['--port', '70000']), /Port invalide/);
  assert.throws(() => parseArgs(['--bizarre']), /Option inconnue/);
});

test('busy port: the next free port is used', async (t) => {
  const first = await startServer({ license: { bypass: true }, port: 0, observe: false, publicDir: makePublicDir(), claude: fakeClaude, skipVersion: true });
  t.after(() => first.close());
  const second = await startServer({ license: { bypass: true }, port: first.port, observe: false, publicDir: makePublicDir(), claude: fakeClaude, skipVersion: true });
  t.after(() => second.close());
  assert.notEqual(second.port, first.port);
  assert.ok(second.port > first.port && second.port <= first.port + 10);
  const res = await request(second.port, { path: '/api/config', headers: { 'X-HQ-Token': second.token } });
  assert.equal(res.json.config.port, second.port);
  // Tokens are per server instance.
  const cross = await request(second.port, { path: '/api/config', headers: { 'X-HQ-Token': first.token } });
  assert.equal(cross.status, 401);
});
