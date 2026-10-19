'use strict';

// Integrated terminal end to end (Windows): REST routes, SSE events, WebSocket streaming through the
// ConPTY bridge, `claude` typed in the terminal (doskey macro -> shim -> FAKE interactive Claude Code
// writing a synthetic transcript) and the shim run directly (pass-through, exit codes, --continue,
// --resume, stop, link failure, use outside PixelQG). The real claude binary is never run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');

const { startServer } = require('../server');
const { BRIDGE_EXE, SHIM_DIR, SHIM_SCRIPT, MAX_TERMINALS } = require('../terminals');
const { projectDirName } = require('../watcher');
const { makePublicDir, request, waitFor, sseConnect, tmpDir } = require('./helpers');

const FAKE_TUI = path.join(__dirname, 'fake-claude-tui.js');
const skip = process.platform !== 'win32' ? 'Windows uniquement' : !fs.existsSync(BRIDGE_EXE) ? 'hq-pty.exe absent' : false;

function stripAnsi(s) {
  return s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Status of a WebSocket upgrade request (101 when accepted). */
function upgradeStatus(port, reqPath, headers = {}) {
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
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
}

function openSocket(port, token, id) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminals/${id}/socket?token=${token}`);
  const state = { ws, messages: [], output: '', closed: null };
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    state.messages.push(msg);
    if (msg.type === 'replay' || msg.type === 'output') state.output += msg.data;
  });
  ws.addEventListener('close', (e) => {
    state.closed = { code: e.code };
  });
  state.ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  state.input = (data) => ws.send(JSON.stringify({ type: 'input', data }));
  state.text = () => stripAnsi(state.output);
  return state;
}

function lastAgent(events, id) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].event === 'agent' && events[i].data.id === id) return events[i].data;
  return null;
}

function readCalls(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('integrated terminal: REST, WebSocket, shim and session linking', { skip }, async (t) => {
  const work = tmpDir('pixelqg-app-term-');
  const projects = path.join(work, 'projects');
  const ctl = path.join(work, 'ctl');
  const logFile = path.join(work, 'calls.jsonl');
  fs.mkdirSync(projects);
  fs.mkdirSync(ctl);
  const savedEnv = {};
  const setEnv = (vars) => {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in savedEnv)) savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
  };
  // Terminals inherit the server's environment: the fake Claude finds its settings there.
  setEnv({ HQ_FAKE_CLAUDE: '1', FAKE_CLAUDE_PROJECTS: projects, FAKE_CLAUDE_CTL: ctl, FAKE_CLAUDE_LOG: logFile, FAKE_CLAUDE_EXIT: '0' });

  const app = await startServer({
    port: 0,
    observe: false,
    publicDir: makePublicDir(),
    claude: { command: process.execPath, prefixArgs: [FAKE_TUI], path: FAKE_TUI },
    skipVersion: true,
    watcher: { projectsDir: projects, pollMs: 50 },
    terminals: { maxTerminals: 3 },
  });
  app.manager.terminalReadyMs = 150;
  const sse = sseConnect(app.port, app.token);
  const sockets = [];
  t.after(async () => {
    for (const s of sockets) s.ws.close();
    sse.close();
    await app.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  await sse.ready;
  const port = app.port;
  const auth = { 'X-HQ-Token': app.token };
  const agentsOf = async () => (await request(port, { path: '/api/agents', headers: auth })).json.agents;

  /** Runs the shim directly, as cmd.exe would, with the HQ environment of terminal t1. */
  const runShim = (args, { env = {}, cwd = work, ctlDir } = {}) => {
    const child = childProcess.spawn(process.execPath, [SHIM_SCRIPT, ...args], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PIXELQG_URL: `http://127.0.0.1:${port}`,
        PIXELQG_TOKEN: app.terminals.records.get('t1').linkToken,
        PIXELQG_TERMINAL: 't1',
        PIXELQG_REAL_CLAUDE: FAKE_TUI,
        FAKE_CLAUDE_CTL: ctlDir || ctl,
        ...env,
      },
    });
    const run = { child, out: '', err: '', code: undefined };
    child.stdout.on('data', (d) => {
      run.out += d;
    });
    child.stderr.on('data', (d) => {
      run.err += d;
    });
    run.done = new Promise((resolve) => child.on('exit', (code) => {
      run.code = code;
      resolve(code);
    }));
    return run;
  };
  const freshCtl = (...steps) => {
    const dir = tmpDir('pixelqg-app-ctl-');
    for (const s of steps) fs.writeFileSync(path.join(dir, s), '');
    return dir;
  };

  await t.test('config, validation and guards', async () => {
    const cfg = (await request(port, { path: '/api/config', headers: auth })).json.config;
    assert.deepEqual(cfg.terminal, { supported: true, reason: null, shell: 'cmd.exe' });
    assert.equal(MAX_TERMINALS, 8);
    assert.deepEqual((await request(port, { path: '/api/terminals', headers: auth })).json, { ok: true, terminals: [] });
    assert.equal((await request(port, { path: '/api/terminals' })).status, 401);
    const bad = async (body, re) => {
      const res = await request(port, { method: 'POST', path: '/api/terminals', headers: auth, body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.json.error, re);
    };
    await bad({ cwd: 'relatif' }, /chemin absolu/);
    await bad({ cwd: path.join(work, 'absent') }, /n'existe pas/);
    await bad({ launchClaude: 'oui' }, /launchClaude/);
    await bad({ model: 'gpt-9' }, /Modèle inconnu/);
    await bad({ permissionMode: 'tout' }, /permission/);
    await bad({ color: 'rouge' }, /Couleur/);
    await bad({ name: '-x' }, /Nom invalide/);
    const plain = await request(port, { method: 'POST', path: '/api/terminals', headers: { ...auth, 'Content-Type': 'text/plain' }, rawBody: '{}' });
    assert.equal(plain.status, 415);
    assert.equal((await request(port, { method: 'PUT', path: '/api/terminals', headers: auth })).status, 405);
    assert.equal((await request(port, { method: 'DELETE', path: '/api/terminals/t99', headers: auth })).status, 404);
    assert.equal((await request(port, { method: 'POST', path: '/api/terminals/t99/link', headers: auth, body: {} })).status, 404);
    assert.equal((await request(port, { path: '/api/terminals/..%2f..', headers: auth })).status, 404);
  });

  let socket;
  await t.test('a terminal streams over a WebSocket (replay, input, resize, several viewers)', async () => {
    const res = await request(port, { method: 'POST', path: '/api/terminals', headers: auth, body: { cwd: work, name: 'Testeur', color: '#5ba4e6' } });
    assert.equal(res.status, 201);
    const term = res.json.terminal;
    assert.deepEqual(Object.keys(term).sort(), ['agentIds', 'color', 'cols', 'createdAt', 'cwd', 'endedAt', 'exitCode', 'id', 'name', 'rows', 'shell', 'status', 'title'].sort());
    assert.equal(term.id, 't1');
    assert.equal(term.title, 'Terminal 1');
    assert.equal(term.shell, 'cmd.exe');
    assert.equal(term.status, 'running');
    assert.equal(term.color, '#5BA4E6');
    assert.equal(term.cols, 120);
    assert.equal(term.rows, 30);
    await waitFor(() => sse.events.some((e) => e.event === 'terminal' && e.data.id === 't1'), 3000, 'SSE terminal event');
    const sse2 = sseConnect(port, app.token);
    await sse2.ready;
    await waitFor(() => sse2.events.length, 3000, 'snapshot');
    assert.deepEqual(sse2.events[0].data.terminals.map((x) => x.id), ['t1']);
    sse2.close();

    // Same guards as the REST API, checked before the handshake completes.
    assert.equal(await upgradeStatus(port, '/api/terminals/t1/socket?token=mauvais'), 401);
    assert.equal(await upgradeStatus(port, '/api/terminals/t1/socket'), 401);
    assert.equal(await upgradeStatus(port, `/api/terminals/t1/socket?token=${app.token}`, { Origin: 'http://evil.example' }), 403);
    assert.equal(await upgradeStatus(port, `/api/terminals/t1/socket?token=${app.token}`, { Host: `evil.example:${port}` }), 403);
    assert.equal(await upgradeStatus(port, `/api/terminals/t42/socket?token=${app.token}`), 404);
    assert.equal(await upgradeStatus(port, `/api/agents?token=${app.token}`), 404);
    assert.equal(await upgradeStatus(port, `/api/terminals/t1/socket?token=${app.token}`, { Origin: `http://localhost:${port}` }), 101);
    assert.equal((await request(port, { path: '/api/terminals/t1/socket', headers: auth })).status, 426);

    socket = openSocket(port, app.token, 't1');
    sockets.push(socket);
    await socket.ready;
    await waitFor(() => socket.messages.length, 3000, 'first message');
    assert.equal(socket.messages[0].type, 'replay', 'replay comes first');
    await waitFor(() => socket.text().includes('>'), 10000, 'cmd prompt');
    socket.input('echo hq-test-ok\r');
    await waitFor(() => (socket.text().match(/hq-test-ok/g) || []).length >= 2, 10000, 'echo ok');

    socket.ws.send(JSON.stringify({ type: 'resize', cols: 100, rows: 40 }));
    await waitFor(() => { const x = app.terminals.get('t1'); return x.cols === 100 && x.rows === 40; }, 3000, 'resize');
    await waitFor(() => sse.events.some((e) => e.event === 'terminal' && e.data.cols === 100 && e.data.rows === 40), 3000, 'SSE resize');
    socket.ws.send(JSON.stringify({ type: 'resize', cols: 5, rows: 1000 }));
    await waitFor(() => { const x = app.terminals.get('t1'); return x.cols === 20 && x.rows === 200; }, 3000, 'clamped resize');
    socket.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 30 }));
    socket.ws.send('pas du json');

    const viewer = openSocket(port, app.token, 't1');
    sockets.push(viewer);
    await viewer.ready;
    await waitFor(() => viewer.messages.length, 3000, 'viewer replay');
    assert.equal(viewer.messages[0].type, 'replay');
    assert.ok(stripAnsi(viewer.messages[0].data).includes('hq-test-ok'), 'replay holds the earlier output');
    viewer.ws.close();
  });

  let agentId;
  let sessionId;
  await t.test('`claude` typed in the terminal becomes a linked agent (working -> waiting -> done)', async () => {
    socket.input('claude "Salut HQ"\r');
    await waitFor(() => app.manager.list().some((a) => a.source === 'terminal'), 10000, 'terminal agent');
    const created = app.manager.list().find((a) => a.source === 'terminal');
    agentId = created.id;
    assert.equal(created.terminalId, 't1');
    assert.equal(created.interactive, true);
    assert.equal(created.kind, 'root');
    assert.equal(created.name, 'Testeur');
    assert.equal(created.color, '#5BA4E6');
    assert.equal(created.canControl, true);
    assert.equal(path.resolve(created.cwd).toLowerCase(), path.resolve(work).toLowerCase());

    await waitFor(() => app.manager.get(agentId).status === 'working', 10000, 'working after the prompt');
    const working = app.manager.get(agentId);
    assert.equal(working.prompt, 'Salut HQ');
    assert.equal(working.activity.label, 'Réfléchit…');
    const call = readCalls(logFile).pop();
    sessionId = call.sessionId;
    assert.ok(call.args.includes('--session-id'), 'a session id is chosen by the shim');
    assert.equal(working.sessionId, sessionId);
    assert.ok(fs.existsSync(path.join(projects, projectDirName(call.cwd), `${sessionId}.jsonl`)));
    assert.ok(socket.text().includes(`FAKE-CLAUDE ${sessionId}`), 'Claude Code runs on the terminal console');
    await waitFor(() => app.terminals.get('t1').agentIds.includes(agentId), 3000, 'terminal agentIds');
    await waitFor(() => sse.events.some((e) => e.event === 'terminal' && e.data.agentIds.includes(agentId)), 3000, 'SSE terminal agentIds');

    const msg = await request(port, { method: 'POST', path: `/api/agents/${agentId}/message`, headers: auth, body: { prompt: 'coucou' } });
    assert.equal(msg.status, 409);
    assert.match(msg.json.error, /terminal/);

    fs.writeFileSync(path.join(ctl, 'turn'), '');
    await waitFor(() => app.manager.get(agentId).status === 'waiting', 10000, 'waiting after end_turn');
    const waiting = app.manager.get(agentId);
    assert.equal(waiting.activity.label, 'Attend ta réponse');
    assert.equal(waiting.turns, 1);
    assert.equal(waiting.toolCount, 1);
    assert.equal(waiting.tokens.total, 2265);
    assert.equal(waiting.lastText, 'Réponse à « Salut HQ »');
    assert.equal(waiting.model, 'claude-opus-5-5');
    assert.equal(waiting.costUsd, null);
    await waitFor(() => { const a = lastAgent(sse.events, agentId); return a && a.status === 'waiting'; }, 3000, 'SSE waiting');

    fs.writeFileSync(path.join(ctl, 'exit'), '');
    await waitFor(() => app.manager.get(agentId).status === 'done', 10000, 'done after exit');
    assert.ok(app.manager.get(agentId).endedAt);
    await waitFor(() => { const a = lastAgent(sse.events, agentId); return a && a.status === 'done'; }, 3000, 'SSE done');
    const seen = sse.events.filter((e) => e.event === 'agent' && e.data.id === agentId).map((e) => e.data.status);
    assert.ok(seen.indexOf('working') < seen.lastIndexOf('waiting') && seen.lastIndexOf('waiting') < seen.lastIndexOf('done'), seen.join(','));
    const logs = (await request(port, { path: `/api/agents/${agentId}/logs`, headers: auth })).json.logs;
    assert.ok(logs.some((l) => l.type === 'user' && l.text === 'Salut HQ'));
    assert.ok(logs.some((l) => l.type === 'tool' && l.tool === 'Read'));
  });

  await t.test('the token given to a terminal only links sessions of that terminal', async () => {
    const linkToken = app.terminals.records.get('t1').linkToken;
    assert.notEqual(linkToken, app.token, 'the page token never reaches terminal processes');
    const scoped = { 'X-HQ-Token': linkToken };
    assert.equal((await request(port, { path: '/api/agents', headers: scoped })).status, 401);
    assert.equal((await request(port, { method: 'POST', path: '/api/agents', headers: scoped, body: { prompt: 'x' } })).status, 401);
    assert.equal((await request(port, { method: 'POST', path: '/api/terminals', headers: scoped, body: {} })).status, 401);
    assert.equal(await upgradeStatus(port, `/api/terminals/t1/socket?token=${linkToken}`), 401);
    const bad = await request(port, { method: 'POST', path: '/api/terminals/t1/unlink', headers: scoped, body: { linkId: 'ab'.repeat(12), exitCode: 0 } });
    assert.equal(bad.status, 404, 'authorized, but no such link');
    assert.equal((await request(port, { method: 'POST', path: '/api/terminals/t2/link', headers: scoped, body: {} })).status, 401);
  });

  await t.test('shim: pass-through runs are not linked', async () => {
    const before = app.manager.list().length;
    const run = runShim(['--version']);
    assert.equal(await run.done, 0);
    assert.equal(run.out.trim(), '2.1.302 (Claude Code)');
    assert.equal(app.manager.list().length, before);
  });

  await t.test('shim: the exit code is propagated and a crash is an error', async () => {
    const run = runShim(['Plante'], { ctlDir: freshCtl('turn', 'exit'), env: { FAKE_CLAUDE_EXIT: '3' } });
    assert.equal(await run.done, 3);
    const a = (await agentsOf()).find((x) => x.prompt === 'Plante');
    assert.ok(a, 'agent linked');
    assert.equal(a.status, 'error');
    assert.equal(a.error, "Claude Code s'est arrêté (code 3)");
    assert.equal(a.tokens.total, 2265, 'the last transcript lines were read before closing');
    assert.equal(a.name, 'Testeur', 'terminal name reused once the previous session ended');
  });

  await t.test('shim: --continue adopts the continued transcript', async () => {
    const cwd = tmpDir('pixelqg-app-continue-');
    const dir = path.join(projects, projectDirName(cwd));
    fs.mkdirSync(dir, { recursive: true });
    const oldSid = crypto.randomUUID();
    const old = path.join(dir, `${oldSid}.jsonl`);
    fs.writeFileSync(old, JSON.stringify({ type: 'user', sessionId: oldSid, cwd, message: { role: 'user', content: 'Ancienne question' } }) + '\n');
    const past = new Date(Date.now() - 5 * 60 * 1000);
    fs.utimesSync(old, past, past);
    const ctlDir = freshCtl('turn');
    const run = runShim(['--continue'], { cwd, ctlDir });
    await waitFor(() => app.manager.list().some((a) => a.sessionId === oldSid && a.status === 'waiting'), 10000, 'adopted session waiting');
    const a = app.manager.list().find((x) => x.sessionId === oldSid);
    assert.equal(a.source, 'terminal');
    assert.equal(a.prompt, 'Ancienne question', 'history replayed for the adopting agent');
    assert.equal(a.turns, 1);
    assert.ok(!readCalls(logFile).pop().args.includes('--session-id'), 'no session id forced on --continue');
    fs.writeFileSync(path.join(ctlDir, 'exit'), '');
    assert.equal(await run.done, 0);
    await waitFor(() => app.manager.get(a.id).status === 'done', 5000, 'done');
  });

  await t.test('shim: --resume of a known session reuses its agent; never observed twice', async () => {
    const on = await request(port, { method: 'POST', path: '/api/observe', headers: auth, body: { enabled: true } });
    assert.equal(on.json.config.observe, true);
    const run = runShim(['--resume', sessionId, 'Et ensuite ?'], { ctlDir: freshCtl('turn', 'exit') });
    assert.equal(await run.done, 0);
    await waitFor(() => app.manager.get(agentId).turns === 2 && app.manager.get(agentId).status === 'done', 10000, 'second turn on the same agent');
    assert.equal(app.manager.list().filter((a) => a.sessionId === sessionId).length, 1, 'one agent per session');
    assert.equal(app.manager.list().filter((a) => a.source === 'observed').length, 0, 'no observed duplicate');
    assert.equal(app.manager.get(agentId).prompt, 'Salut HQ');
    const off = await request(port, { method: 'POST', path: '/api/observe', headers: auth, body: { enabled: false } });
    assert.equal(off.json.config.observe, false);
  });

  await t.test('stop kills the interactive Claude Code process (taskkill /T /F)', async () => {
    const run = runShim(['Arrête-moi'], { ctlDir: freshCtl() });
    await waitFor(() => app.manager.list().some((a) => a.prompt === 'Arrête-moi' && a.status === 'working'), 10000, 'working');
    const a = app.manager.list().find((x) => x.prompt === 'Arrête-moi');
    const fakePid = readCalls(logFile).pop().pid;
    assert.ok(alive(fakePid));
    const stop = await request(port, { method: 'POST', path: `/api/agents/${a.id}/stop`, headers: auth });
    assert.equal(stop.status, 200);
    assert.equal(stop.json.agent.status, 'stopped');
    assert.notEqual(await run.done, 0);
    await waitFor(() => !alive(fakePid), 5000, 'fake claude killed');
    assert.equal(app.manager.get(a.id).status, 'stopped', 'stays stopped after the exit report');
  });

  await t.test('shim: a failed link never blocks Claude Code; outside HQ it runs the real claude from PATH', async () => {
    const run = runShim(['Sans serveur'], { ctlDir: freshCtl('turn', 'exit'), env: { PIXELQG_URL: 'http://127.0.0.1:1' } });
    assert.equal(await run.done, 0);
    assert.match(run.err, /liaison impossible, la session tourne quand même/);
    assert.match(run.out, /FAKE-CLAUDE/);

    // npm-style install: claude.cmd -> node_modules/@anthropic-ai/claude-code/cli.js
    const bin = tmpDir('pixelqg-app-npm-');
    const pkg = path.join(bin, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    fs.copyFileSync(FAKE_TUI, path.join(pkg, 'cli.js'));
    fs.writeFileSync(path.join(bin, 'claude.cmd'), '@"%~dp0\\node.exe" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    const env = { ...process.env, PATH: `${SHIM_DIR};${bin}`, HQ_FAKE_CLAUDE: '1' };
    for (const k of Object.keys(env)) if (/^PIXELQG_|^path$/i.test(k) && k !== 'PATH') delete env[k];
    const out = childProcess.spawnSync(process.execPath, [SHIM_SCRIPT, '--version'], { env, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stdout.trim(), '2.1.302 (Claude Code)');
  });

  await t.test('launchClaude types `claude` with the validated options; cap of terminals; removal', async () => {
    const res = await request(port, { method: 'POST', path: '/api/terminals', headers: auth, body: { cwd: work, launchClaude: true, model: 'haiku', permissionMode: 'acceptEdits' } });
    assert.equal(res.status, 201);
    const t2 = res.json.terminal;
    assert.equal(t2.id, 't2');
    await waitFor(() => app.manager.list().some((a) => a.terminalId === 't2' && a.status === 'done'), 15000, 'session launched in t2');
    const call = readCalls(logFile).pop();
    assert.deepEqual(call.args.slice(0, 4), ['--model', 'haiku', '--permission-mode', 'acceptEdits']);

    // Sessions started in t3 block until told otherwise.
    setEnv({ FAKE_CLAUDE_CTL: freshCtl() });
    const t3 = (await request(port, { method: 'POST', path: '/api/terminals', headers: auth, body: { cwd: work, launchClaude: true } })).json.terminal;
    const full = await request(port, { method: 'POST', path: '/api/terminals', headers: auth, body: {} });
    assert.equal(full.status, 409);
    assert.match(full.json.error, /3 terminaux/);

    const bridge2 = app.terminals.records.get('t2').child.pid;
    const del = await request(port, { method: 'DELETE', path: '/api/terminals/t2', headers: auth });
    assert.deepEqual(del.json, { ok: true });
    await waitFor(() => sse.events.some((e) => e.event === 'terminal-remove' && e.data.id === 't2'), 3000, 'terminal-remove');
    await waitFor(() => !alive(bridge2), 5000, 'bridge t2 gone');
    assert.ok(app.manager.list().some((a) => a.terminalId === 't2'), 'its agents stay in the office');

    // Closing a terminal while its Claude Code session works stops the session.
    await waitFor(() => app.manager.list().some((a) => a.terminalId === t3.id && a.status === 'working'), 15000, 'working in t3');
    const busy = app.manager.list().find((a) => a.terminalId === t3.id);
    const fakePid = readCalls(logFile).pop().pid;
    await request(port, { method: 'DELETE', path: `/api/terminals/${t3.id}`, headers: auth });
    await waitFor(() => app.manager.get(busy.id).status === 'stopped', 5000, 'session stopped with its terminal');
    await waitFor(() => !alive(fakePid), 5000, 'its process tree is gone');
    assert.equal((await request(port, { path: '/api/terminals', headers: auth })).json.terminals.length, 1);
  });

  await t.test('exit of the shell is reported; shutdown kills every terminal', async () => {
    const res = await request(port, { method: 'POST', path: '/api/terminals', headers: auth, body: { cwd: work } });
    const id = res.json.terminal.id;
    const s = openSocket(port, app.token, id);
    sockets.push(s);
    await s.ready;
    await waitFor(() => s.text().includes('>'), 10000, 'prompt');
    s.input('exit 4\r');
    await waitFor(() => s.messages.some((m) => m.type === 'exit'), 10000, 'exit message');
    assert.deepEqual(s.messages.find((m) => m.type === 'exit'), { type: 'exit', code: 4 });
    const term = app.terminals.get(id);
    assert.equal(term.status, 'exited');
    assert.equal(term.exitCode, 4);
    assert.ok(term.endedAt);

    const bridge1 = app.terminals.records.get('t1').child.pid;
    assert.ok(alive(bridge1));
    await app.close();
    await waitFor(() => !alive(bridge1), 5000, 'bridge t1 gone');
    await waitFor(() => socket.closed, 5000, 'socket closed by the shutdown');
  });
});

// ------------------------------------------------------------------------------------------------
// macOS / Linux mode (experimental): simulated with a fake `script` process on any host. The real
// command lines were checked by hand in a Linux pseudo-terminal; nothing here ran on a real Mac.

function fakeScriptChild() {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.written = [];
  child.stdin.on('data', (b) => child.written.push(b));
  child.signals = [];
  child.kill = (sig) => {
    child.signals.push(sig);
    setImmediate(() => {
      child.stdout.end();
      child.emit('close', null, sig);
    });
    return true;
  };
  return child;
}

test('macOS / Linux mode: shell inside `script`, sized by the first resize, raw input, SIGKILL', async () => {
  const { EventEmitter } = require('node:events');
  const { TerminalManager } = require('../terminals');
  class StubManager extends EventEmitter {
    ensureClaude() { return { command: '/opt/claude/bin/claude', prefixArgs: [] }; }
    validateProfile() { return null; }
    endTerminalLinksOf(id, info) { this.ended = { id, info }; }
  }
  const dir = tmpDir('pixelqg-app-posix-');
  const exe = (name) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
    return p;
  };
  const script = exe('script');
  const bash = exe('bash');
  const zsh = exe('zsh');
  const calls = [];
  const spawn = (file, args, options) => {
    const child = fakeScriptChild();
    calls.push({ file, args, options, child });
    return child;
  };
  const make = (platform, extra = {}) => new TerminalManager({
    manager: new StubManager(), platform, scriptPath: script, shellPath: bash, spawn, posixStartWaitMs: 5000, ...extra,
  });
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const q = (s) => `'${s}'`;
  const bashrc = path.join(SHIM_DIR, 'posix', 'bashrc');

  // Linux: util-linux syntax, the shell waits for the page's size.
  const linux = make('linux');
  assert.deepEqual(await linux.init(), { supported: true, reason: null, shell: 'bash' });
  const t = linux.create({ cwd: dir });
  assert.equal(t.shell, 'bash');
  assert.equal(calls.length, 0, 'the shell waits for the first size');
  assert.match(linux.replay(t.id), /Terminal expérimental/);
  assert.equal(linux.resize(t.id, 100, 40), true);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.file, script);
  assert.deepEqual(c.args, ['-qefc', `stty cols 100 rows 40 2>/dev/null; exec ${q(bash)} ${q('--rcfile')} ${q(bashrc)}`, '/dev/null']);
  assert.equal(c.options.detached, true);
  assert.equal(c.options.windowsHide, true);
  assert.equal(c.options.cwd, dir);
  const env = c.options.env;
  assert.ok(env.PATH.startsWith(SHIM_DIR + path.delimiter), 'shim first in PATH');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.SHELL, bash);
  assert.equal(env.PIXELQG_TERMINAL, t.id);
  assert.equal(env.PIXELQG_SHIM, SHIM_SCRIPT);
  assert.equal(env.PIXELQG_REAL_CLAUDE, '/opt/claude/bin/claude');
  assert.equal(env.TERM_PROGRAM, undefined);
  assert.equal(linux.resize(t.id, 150, 50), false, 'no resize afterwards');
  assert.equal(linux.get(t.id).cols, 100);
  assert.equal(linux.get(t.id).rows, 40);
  assert.equal(linux.write(t.id, 'ls -la\r'), true);
  await tick();
  assert.equal(Buffer.concat(c.child.written).toString('utf8'), 'ls -la\r', 'raw keystrokes, no bridge frames');
  c.child.stdout.write('user@host:~$ ');
  await tick();
  assert.match(linux.replay(t.id), /user@host:~\$ $/);
  await linux.kill(t.id);
  assert.deepEqual(c.child.signals, ['SIGKILL']);
  assert.equal(linux.get(t.id).status, 'exited');

  // « Lancer Claude Code »: `claude` is typed once the shell printed something, never before it runs.
  const t2 = linux.create({ cwd: dir, launchClaude: true });
  await tick();
  assert.equal(calls.length, 1);
  linux.resize(t2.id, 80, 24);
  const c2 = calls[1];
  await tick();
  assert.equal(c2.child.written.length, 0);
  c2.child.stdout.write('$ ');
  await tick();
  assert.equal(Buffer.concat(c2.child.written).toString('utf8'), 'claude\r');

  // Closed before its shell started: nothing is spawned.
  const t3 = linux.create({ cwd: dir });
  await linux.kill(t3.id);
  assert.equal(linux.get(t3.id).status, 'exited');
  assert.equal(calls.length, 2);
  await linux.shutdown();

  // No size from the page: starts after the wait with 120×30.
  const late = make('linux', { posixStartWaitMs: 20 });
  await late.init();
  late.create({ cwd: dir });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(calls.length, 3);
  assert.match(calls[2].args[1], /^stty cols 120 rows 30 /);
  await late.shutdown();

  // macOS: BSD syntax; zsh gets its startup wrapper through ZDOTDIR.
  const mac = make('darwin', { shellPath: zsh });
  assert.deepEqual(await mac.init(), { supported: true, reason: null, shell: 'zsh' });
  const m = mac.create({ cwd: dir });
  mac.resize(m.id, 90, 30);
  const cm = calls[3];
  assert.deepEqual(cm.args, ['-q', '/dev/null', '/bin/sh', '-c', `stty cols 90 rows 30 2>/dev/null; exec ${q(zsh)}`]);
  assert.equal(cm.options.env.ZDOTDIR, path.join(SHIM_DIR, 'posix', 'zsh'));
  assert.equal(typeof cm.options.env.PIXELQG_USER_ZDOTDIR, 'string');
  await mac.shutdown();

  // Unavailable: no `script` command, or another system.
  const noScript = make('linux', { scriptPath: path.join(dir, 'absent') });
  const cfg = await noScript.init();
  assert.equal(cfg.supported, false);
  assert.match(cfg.reason, /commande « script »/);
  assert.throws(() => noScript.create({ cwd: dir }), /script/);
  const other = make('aix');
  assert.match((await other.init()).reason, /Windows, macOS et Linux/);
});
