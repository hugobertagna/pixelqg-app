'use strict';

// End-to-end: real HTTP API + SSE, real child processes running the fake Claude CLI
// (resolved through CLAUDE_BIN=fake-claude.js, exactly like a user override).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startServer } = require('../server');
const { FAKE_CLAUDE, makePublicDir, request, waitFor, sseConnect, tmpDir } = require('./helpers');

const FIXED_SESSION = '11111111-2222-4333-8444-555555555555';

function statusesOf(events, id) {
  const out = [];
  for (const e of events) {
    if (e.event === 'agent' && e.data.id === id && out[out.length - 1] !== e.data.status) out.push(e.data.status);
  }
  return out;
}

function lastAgent(events, id) {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].event === 'agent' && events[i].data.id === id) return events[i].data;
  }
  return null;
}

function readInvocations(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('end-to-end with the fake Claude Code CLI', async (t) => {
  const saved = {
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    HQ_FAKE_CLAUDE: process.env.HQ_FAKE_CLAUDE,
    FAKE_CLAUDE_LOG: process.env.FAKE_CLAUDE_LOG,
  };
  const work = tmpDir('pixelqg-app-e2e-');
  const logFile = path.join(work, 'invocations.jsonl');
  process.env.CLAUDE_BIN = FAKE_CLAUDE;
  process.env.HQ_FAKE_CLAUDE = '1';
  process.env.FAKE_CLAUDE_LOG = logFile;

  const app = await startServer({
    license: { bypass: true },
    port: 0,
    observe: false,
    publicDir: makePublicDir(),
    watcher: { projectsDir: tmpDir('pixelqg-app-projects-'), autoPoll: false },
  });
  const sse = sseConnect(app.port, app.token);
  t.after(async () => {
    sse.close();
    await app.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  await sse.ready;
  const auth = { 'X-HQ-Token': app.token };
  const port = app.port;

  await t.test('CLAUDE_BIN pointing to a .js file is run with node and its version is read', async () => {
    const res = await request(port, { path: '/api/config', headers: auth });
    assert.equal(res.json.config.claudeFound, true);
    assert.equal(res.json.config.claudePath, FAKE_CLAUDE);
    assert.equal(res.json.config.claudeVersion, '2.1.302 (Claude Code)');
    assert.equal(sse.status, 200);
    assert.match(sse.headers['content-type'], /^text\/event-stream/);
    await waitFor(() => sse.events.length > 0, 3000, 'snapshot');
    assert.equal(sse.events[0].event, 'snapshot');
    assert.deepEqual(sse.events[0].data.agents, []);
    assert.equal(sse.events[0].data.config.port, port);
  });

  let agentId;
  await t.test('an agent goes starting -> working -> done', async () => {
    const res = await request(port, { method: 'POST', path: '/api/agents', headers: auth, body: { prompt: 'Liste les fichiers texte', cwd: work, model: 'haiku', effort: 'low' } });
    assert.equal(res.status, 201);
    const agent = res.json.agent;
    agentId = agent.id;
    assert.equal(agent.id, 'a1');
    assert.equal(agent.status, 'starting');
    assert.equal(agent.name, 'Nova');
    assert.equal(agent.color, '#D97757');
    assert.equal(agent.model, 'haiku');
    assert.equal(agent.source, 'spawned');
    assert.equal(agent.canControl, true);
    assert.equal(agent.cwd, path.resolve(work));

    await waitFor(() => { const a = lastAgent(sse.events, agentId); return a && a.status === 'done'; }, 15000, 'agent done');
    const seq = statusesOf(sse.events, agentId);
    assert.deepEqual(seq, ['starting', 'working', 'done']);
    const final = (await request(port, { path: '/api/agents', headers: auth })).json.agents.find((a) => a.id === agentId);
    assert.equal(final.sessionId, FIXED_SESSION);
    assert.equal(final.model, 'claude-haiku-5-5');
    assert.equal(final.costUsd, 0.01839393);
    assert.equal(final.turns, 1);
    assert.equal(final.toolCount, 1);
    assert.equal(final.tokens.total, 109817);
    assert.ok(final.endedAt >= final.startedAt);
    const sub = (await request(port, { path: '/api/agents', headers: auth })).json.agents.find((a) => a.parentId === agentId);
    assert.ok(sub, 'subagent listed');
    assert.equal(sub.id, 'a1.s1');
    assert.equal(sub.status, 'done');

    // Prompt passed on stdin, never as an argument.
    const calls = readInvocations(logFile);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].prompt, 'Liste les fichiers texte');
    assert.ok(!calls[0].args.includes('Liste les fichiers texte'));
    assert.deepEqual(calls[0].args, [
      '-p', '--output-format', 'stream-json', '--verbose', '--forward-subagent-text',
      '--permission-prompts', 'none', '--permission-mode', 'default', '--name=Nova',
      '--model', 'haiku', '--effort', 'low',
    ]);
    assert.equal(path.resolve(calls[0].cwd).toLowerCase(), path.resolve(work).toLowerCase());

    // SSE side effects.
    assert.ok(sse.events.some((e) => e.event === 'tokens' && e.data.id === agentId && e.data.delta > 0));
    assert.ok(sse.events.some((e) => e.event === 'log' && e.data.id === 'a1.s1' && e.data.entry.tool === 'Glob'));
    assert.ok(sse.events.some((e) => e.event === 'agent' && e.data.id === 'a1.s1'));

    // Throttle: consecutive "agent" events for one agent are ≥ ~150 ms apart.
    const times = sse.events.filter((e) => e.event === 'agent' && e.data.id === agentId).map((e) => e.at);
    for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 120, `agent events too close: ${times[i] - times[i - 1]} ms`);

    const logs = (await request(port, { path: `/api/agents/${agentId}/logs`, headers: auth })).json.logs;
    assert.equal(logs[0].type, 'user');
    assert.equal(logs[0].text, 'Liste les fichiers texte');
    assert.ok(logs.some((l) => l.type === 'result'));
  });

  await t.test('a sub cannot receive a follow-up message', async () => {
    const res = await request(port, { method: 'POST', path: '/api/agents/a1.s1/message', headers: auth, body: { prompt: 'Salut' } });
    assert.equal(res.status, 409);
  });

  await t.test('a follow-up message resumes the session with --resume', async () => {
    const res = await request(port, { method: 'POST', path: `/api/agents/${agentId}/message`, headers: auth, body: { prompt: 'Et maintenant ?' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.agent.status, 'starting');
    assert.equal(res.json.agent.endedAt, null);
    await waitFor(() => { const a = lastAgent(sse.events, agentId); return a && a.status === 'done' && a.turns === 2; }, 15000, 'second turn done');
    const calls = readInvocations(logFile);
    assert.equal(calls.length, 2);
    const args = calls[1].args;
    assert.deepEqual(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2), ['--resume', FIXED_SESSION]);
    assert.equal(calls[1].prompt, 'Et maintenant ?');
    const a = lastAgent(sse.events, agentId);
    assert.equal(a.costUsd, 0.03678786);
    assert.equal(a.sessionId, FIXED_SESSION);
    assert.ok(app.manager.spawnedSessionIds.has(FIXED_SESSION));
    // The replay reuses the same Agent tool_use id: the same subagent is resumed, then done again.
    const subs = (await request(port, { path: '/api/agents', headers: auth })).json.agents.filter((x) => x.parentId === agentId);
    assert.deepEqual(subs.map((s) => s.id), ['a1.s1']);
    assert.equal(subs[0].status, 'done');
    assert.equal(subs[0].toolCount, 4);
    assert.deepEqual(statusesOf(sse.events, 'a1.s1'), ['working', 'done', 'working', 'done']);
  });

  await t.test('a crashing process ends in error with the stderr message', async () => {
    const res = await request(port, { method: 'POST', path: '/api/agents', headers: auth, body: { prompt: 'CRASH immédiat', cwd: work } });
    assert.equal(res.status, 201);
    const id = res.json.agent.id;
    await waitFor(() => { const a = lastAgent(sse.events, id); return a && a.status === 'error'; }, 15000, 'error status');
    const a = lastAgent(sse.events, id);
    assert.match(a.error, /plantage simulé/);
    assert.equal(a.activity.kind, 'error');
    assert.ok(a.endedAt);
    const logs = (await request(port, { path: `/api/agents/${id}/logs`, headers: auth })).json.logs;
    assert.ok(logs.some((l) => l.type === 'error' && /plantage simulé/.test(l.text)));
  });

  await t.test('stopping a slow agent kills it and marks it stopped', async () => {
    const res = await request(port, { method: 'POST', path: '/api/agents', headers: auth, body: { prompt: 'SLOW travail très long', cwd: work, name: 'Lent' } });
    const id = res.json.agent.id;
    assert.equal(res.json.agent.name, 'Lent');
    await waitFor(() => { const a = lastAgent(sse.events, id); return a && a.status === 'working'; }, 15000, 'working');
    const busy = await request(port, { method: 'POST', path: `/api/agents/${id}/message`, headers: auth, body: { prompt: 'encore' } });
    assert.equal(busy.status, 409);
    const stop = await request(port, { method: 'POST', path: `/api/agents/${id}/stop`, headers: auth });
    assert.equal(stop.status, 200);
    assert.equal(stop.json.agent.status, 'stopped');
    await waitFor(() => app.manager.runningProcesses() === 0, 10000, 'process killed');
    const after = (await request(port, { path: '/api/agents', headers: auth })).json.agents.find((x) => x.id === id);
    assert.equal(after.status, 'stopped');
    assert.ok(after.endedAt);
    const again = await request(port, { method: 'POST', path: `/api/agents/${id}/stop`, headers: auth });
    assert.equal(again.status, 200);
    assert.equal(again.json.agent.status, 'stopped');
  });

  await t.test('removing an agent removes its subagents too', async () => {
    const res = await request(port, { method: 'DELETE', path: `/api/agents/${agentId}`, headers: auth });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });
    await waitFor(() => ['a1', 'a1.s1'].every((id) => sse.events.some((e) => e.event === 'remove' && e.data.id === id)), 3000, 'remove events');
    const list = (await request(port, { path: '/api/agents', headers: auth })).json.agents;
    assert.ok(!list.some((a) => a.id === agentId || a.parentId === agentId));
  });

  await t.test('removing a running agent stops its process first', async () => {
    const res = await request(port, { method: 'POST', path: '/api/agents', headers: auth, body: { prompt: 'SLOW encore', cwd: work } });
    const id = res.json.agent.id;
    await waitFor(() => { const a = lastAgent(sse.events, id); return a && a.status === 'working'; }, 15000, 'working');
    const del = await request(port, { method: 'DELETE', path: `/api/agents/${id}`, headers: auth });
    assert.equal(del.status, 200);
    await waitFor(() => app.manager.runningProcesses() === 0, 10000, 'process killed');
    assert.equal(app.manager.get(id), null);
  });
});

test('closing the server kills running Claude Code processes', async () => {
  const saved = { CLAUDE_BIN: process.env.CLAUDE_BIN, HQ_FAKE_CLAUDE: process.env.HQ_FAKE_CLAUDE };
  process.env.HQ_FAKE_CLAUDE = '1';
  const app = await startServer({
    license: { bypass: true },
    port: 0,
    observe: false,
    publicDir: makePublicDir(),
    claude: { command: process.execPath, prefixArgs: [FAKE_CLAUDE], path: FAKE_CLAUDE },
    skipVersion: true,
    watcher: { projectsDir: tmpDir('pixelqg-app-projects-'), autoPoll: false },
  });
  try {
    const res = await request(app.port, { method: 'POST', path: '/api/agents', headers: { 'X-HQ-Token': app.token }, body: { prompt: 'SLOW arrêt du serveur', cwd: tmpDir() } });
    assert.equal(res.status, 201);
    const id = res.json.agent.id;
    await waitFor(() => app.manager.get(id).status === 'working', 15000, 'working');
    const pid = app.manager._rec(id).proc.pid;
    assert.ok(pid > 0);
    await app.close();
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    await waitFor(() => !alive(), 10000, 'child process gone');
    assert.equal(app.manager.get(id).status, 'stopped');
  } finally {
    await app.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
