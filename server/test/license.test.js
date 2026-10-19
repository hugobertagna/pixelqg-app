'use strict';

// Licence gate (pixelqg-site/docs/ACCOUNTS.md §2): offline certificate checks and the server gate.
// A throw-away Ed25519 key signs the test certificates; Supabase is a fake fetch (no network).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const { startServer } = require('../server');
const { verifyCertificate, isPlaceholderConfig, parseMachineGuid, hashDevice } = require('../license');
const { FAKE_CLAUDE, makePublicDir, request, tmpDir } = require('./helpers');

const fakeClaude = { command: process.execPath, prefixArgs: [FAKE_CLAUDE], path: FAKE_CLAUDE };
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const DEV = hashDevice('test-machine');
const NOW = Math.floor(Date.now() / 1000);
const CLOUD = { SUPABASE_URL: 'https://projet-test.supabase.co', SUPABASE_ANON_KEY: 'anon-test' };

function payload(extra) {
  return { v: 1, lic: 'lic-1', sub: 'user-1', email: 'joueur@example.com', dev: DEV, iat: NOW, exp: NOW + 14 * 86400, ...extra };
}

function sign(data, key = privateKey) {
  const p64 = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${p64}.${crypto.sign(null, Buffer.from(p64), key).toString('base64url')}`;
}

function serverOpts(license) {
  return {
    port: 0,
    observe: false,
    publicDir: makePublicDir(),
    claude: fakeClaude,
    skipVersion: true,
    watcher: { projectsDir: tmpDir('pixelqg-app-projects-'), autoPoll: false },
    terminals: { platform: 'linux' },
    library: { home: tmpDir('pixelqg-app-home-') },
    license,
  };
}

/** WebSocket handshake; resolves with the HTTP status the server answered. */
function upgrade(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: reqPath,
      agent: false,
      headers: {
        Host: `127.0.0.1:${port}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('error', reject);
    req.end();
  });
}

test('certificate verification (offline)', () => {
  const opts = { publicKey: PUB, deviceHash: DEV };
  const good = verifyCertificate(sign(payload()), opts);
  assert.equal(good.ok, true);
  assert.equal(good.payload.email, 'joueur@example.com');

  // Tampered payload, original signature.
  const [, sig] = sign(payload()).split('.');
  const forged = `${Buffer.from(JSON.stringify(payload({ exp: NOW + 999 * 86400 }))).toString('base64url')}.${sig}`;
  assert.deepEqual(verifyCertificate(forged, opts), { ok: false, reason: 'signature' });
  // Signed with another key.
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal(verifyCertificate(sign(payload(), other), opts).reason, 'signature');
  // Another PC.
  assert.equal(verifyCertificate(sign(payload({ dev: hashDevice('autre-pc') })), opts).reason, 'device');
  // Expired: authentic, but refused.
  const expired = verifyCertificate(sign(payload({ iat: NOW - 20 * 86400, exp: NOW - 60 })), opts);
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');
  // Garbage.
  assert.equal(verifyCertificate('pas-un-certificat', opts).reason, 'format');
  assert.equal(verifyCertificate(undefined, opts).reason, 'format');
});

test('helpers: placeholders and MachineGuid parsing', () => {
  assert.equal(isPlaceholderConfig({ SUPABASE_URL: '__SUPABASE_URL__', SUPABASE_ANON_KEY: '__SUPABASE_ANON_KEY__' }), true);
  assert.equal(isPlaceholderConfig(CLOUD), false);
  const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    0A1B2C3D-0000-4000-8000-00000000ABCD\r\n';
  assert.equal(parseMachineGuid(out), '0a1b2c3d-0000-4000-8000-00000000abcd');
  assert.equal(parseMachineGuid('ERREUR'), null);
  assert.match(DEV, /^[0-9a-f]{64}$/);
});

test('gate closed without certificate: 402, SSE and sockets refused, then login / logout', async (t) => {
  const file = path.join(tmpDir('pixelqg-app-lic-'), 'license.json');
  let offline = false;
  const calls = [];
  const fetch = async (url, init) => {
    if (offline) throw new TypeError('fetch failed');
    const u = new URL(url);
    const body = JSON.parse(init.body);
    calls.push({ path: u.pathname, grant: u.searchParams.get('grant_type'), body, headers: init.headers });
    let status = 200;
    let json;
    if (u.pathname === '/auth/v1/token') {
      if (body.password === 'mauvais') {
        status = 400;
        json = { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' };
      } else {
        json = { access_token: `at-${body.email || 'refresh'}`, refresh_token: 'rt-1', user: { email: body.email || 'joueur@example.com' } };
      }
    } else if (init.headers.Authorization === 'Bearer at-sans@example.com') {
      status = 402;
      json = { error: 'Aucune licence active sur ce compte.' };
    } else if (init.headers.Authorization === 'Bearer at-plein@example.com') {
      status = 409;
      json = { error: 'Trop d’appareils.' };
    } else if (body.action === 'activate') {
      json = { certificate: sign(payload()), license: { status: 'active' }, devices: 1 };
    } else {
      json = { ok: true };
    }
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
  const app = await startServer(serverOpts({ cloud: CLOUD, publicKey: PUB, deviceHash: DEV, file, fetch }));
  t.after(() => app.close());
  const { port, token } = app;
  const auth = { 'X-HQ-Token': token };
  const login = (email, password) => request(port, { method: 'POST', path: '/api/license/login', headers: auth, body: { email, password } });

  await t.test('402 on gated routes, minimal config, locked state', async () => {
    for (const p of ['/api/agents', '/api/terminals', '/api/library', `/api/events?token=${token}`]) {
      const res = await request(port, { path: p, headers: auth });
      assert.equal(res.status, 402, p);
      assert.deepEqual(res.json, { ok: false, error: 'Licence requise', code: 'license_required' });
    }
    const spawn = await request(port, { method: 'POST', path: '/api/agents', headers: auth, body: { prompt: 'x' } });
    assert.equal(spawn.status, 402);
    const cfg = await request(port, { path: '/api/config', headers: auth });
    assert.equal(cfg.status, 200);
    assert.equal(cfg.json.config.license.licensed, false);
    assert.equal(cfg.json.config.claudePath, undefined);
    const lic = await request(port, { path: '/api/license', headers: auth });
    assert.equal(lic.json.license.mode, 'locked');
    assert.equal(lic.json.license.accountUrl, 'https://pixelqg-site.pages.dev/compte.html');
    assert.equal((await request(port, { path: '/api/license' })).status, 401, 'the HQ token is still required');
    assert.equal(await upgrade(port, `/api/terminals/t1/socket?token=${token}`), 402);
  });

  await t.test('clear French errors: wrong password, 402, 409, offline', async () => {
    const wrong = await login('joueur@example.com', 'mauvais');
    assert.equal(wrong.status, 400);
    assert.equal(wrong.json.error, 'E-mail ou mot de passe incorrect.');
    const none = await login('sans@example.com', 'secret');
    assert.equal(none.status, 402);
    assert.equal(none.json.code, 'no_license');
    assert.match(none.json.error, /Aucune licence active/);
    const full = await login('plein@example.com', 'secret');
    assert.equal(full.status, 409);
    assert.match(full.json.error, /Trop d’appareils/);
    offline = true;
    const off = await login('joueur@example.com', 'secret');
    offline = false;
    assert.equal(off.status, 503);
    assert.match(off.json.error, /connexion Internet/);
    assert.equal((await request(port, { path: '/api/agents', headers: auth })).status, 402);
  });

  await t.test('login activates this PC and opens the gate', async () => {
    const ok = await login('joueur@example.com', 'secret');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.license.licensed, true);
    assert.equal(ok.json.license.email, 'joueur@example.com');
    const activate = calls.filter((c) => c.path === '/functions/v1/license').pop();
    assert.deepEqual([activate.body.action, activate.body.device_hash], ['activate', DEV]);
    assert.equal(activate.headers.apikey, 'anon-test');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.refresh_token, 'rt-1');
    assert.equal(verifyCertificate(saved.certificate, { publicKey: PUB, deviceHash: DEV }).ok, true);
    assert.equal((await request(port, { path: '/api/agents', headers: auth })).status, 200);
  });

  await t.test('logout releases this PC and deletes the file', async () => {
    const out = await request(port, { method: 'POST', path: '/api/license/logout', headers: auth, body: {} });
    assert.equal(out.status, 200);
    assert.equal(out.json.released, true);
    assert.equal(calls.pop().body.action, 'release');
    assert.equal(fs.existsSync(file), false);
    assert.equal((await request(port, { path: '/api/agents', headers: auth })).status, 402);
  });
});

test('bypass option opens the gate (test-suite only)', async (t) => {
  const app = await startServer(serverOpts({ bypass: true, cloud: CLOUD, file: path.join(tmpDir(), 'absent.json') }));
  t.after(() => app.close());
  const auth = { 'X-HQ-Token': app.token };
  assert.equal((await request(app.port, { path: '/api/agents', headers: auth })).status, 200);
  const lic = await request(app.port, { path: '/api/license', headers: auth });
  assert.equal(lic.json.license.mode, 'bypass');
});

test('placeholder cloud-config opens the gate in developer mode', async (t) => {
  const cloud = { SUPABASE_URL: '__SUPABASE_URL__', SUPABASE_ANON_KEY: '__SUPABASE_ANON_KEY__' };
  const app = await startServer(serverOpts({ cloud, file: path.join(tmpDir(), 'absent.json') }));
  t.after(() => app.close());
  const auth = { 'X-HQ-Token': app.token };
  assert.equal((await request(app.port, { path: '/api/agents', headers: auth })).status, 200);
  const lic = (await request(app.port, { path: '/api/license', headers: auth })).json.license;
  assert.equal(lic.licensed, true);
  assert.equal(lic.devMode, true);
  assert.equal(lic.mode, 'dev');
  const cfg = await request(app.port, { path: '/api/config', headers: auth });
  assert.equal(cfg.json.config.license.devMode, true);
  const login = await request(app.port, { method: 'POST', path: '/api/license/login', headers: auth, body: { email: 'a@example.com', password: 'x' } });
  assert.equal(login.status, 503);
  assert.match(login.json.error, /Mode développeur/);
});
