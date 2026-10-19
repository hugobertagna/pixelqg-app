'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

const { AgentManager } = require('../agents');
const { DemoRunner, SCENARIOS, buildScenarioEvents } = require('../demo');
const { waitFor } = require('./helpers');

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('demo agents produce events through the shared parser and never spawn a process', async (t) => {
  const calls = [];
  const originals = {};
  for (const fn of ['spawn', 'execFile', 'fork', 'exec', 'spawnSync', 'execFileSync', 'execSync']) {
    originals[fn] = childProcess[fn];
    childProcess[fn] = (...args) => {
      calls.push(fn);
      return originals[fn](...args);
    };
  }
  const spawnCalls = [];
  const m = new AgentManager({ claude: null, spawn: (...args) => { spawnCalls.push(args); throw new Error('interdit'); } });
  const demo = new DemoRunner(m, { speed: 120, random: seeded(7) });
  t.after(() => {
    demo.stopAll();
    Object.assign(childProcess, originals);
  });

  const events = { agent: 0, log: 0, tokens: 0, remove: 0 };
  m.on('agent', () => events.agent++);
  m.on('log', () => events.log++);
  m.on('tokens', () => events.tokens++);
  m.on('remove', () => events.remove++);

  const agents = demo.start(2);
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map((a) => a.id), ['d1', 'd2']);
  assert.ok(agents.every((a) => a.source === 'demo' && a.kind === 'root' && a.canControl === true));
  assert.equal(new Set(agents.map((a) => a.name)).size, 2);
  assert.equal(new Set(agents.map((a) => a.color)).size, 2);
  assert.equal(demo.active, true);

  // Scenario 2 ("Écrire les tests de l'API") delegates to an Explore subagent.
  await waitFor(() => m.get('d2') && m.get('d2').turns >= 1, 20000, 'first demo scenario finished');
  const d2 = m.get('d2');
  assert.ok(d2.costUsd > 0);
  assert.ok(d2.tokens.total > 0);
  assert.ok(d2.toolCount >= 5);
  assert.ok(d2.sessionId);
  assert.match(d2.model, /^claude-/);
  const sub = m.list().find((a) => a.parentId === 'd2');
  assert.ok(sub, 'a demo subagent was created');
  assert.equal(sub.role, 'Explore');
  assert.equal(sub.source, 'demo');
  assert.equal(sub.status, 'done');
  assert.ok(sub.toolCount >= 3);
  assert.ok(sub.tokens.total > 0);
  const logs = m.getLogs('d2');
  assert.ok(logs.some((l) => l.type === 'tool' && l.kind === 'task'));
  assert.ok(logs.some((l) => l.type === 'result'));
  assert.ok(events.log > 10 && events.tokens > 5 && events.agent > 10);

  // Stop = freeze.
  await waitFor(() => ['working', 'starting'].includes(m.get('d1').status), 20000, 'd1 active');
  m.stop('d1');
  assert.equal(m.get('d1').status, 'stopped');
  const frozen = m.get('d1').tokens.total;
  const frozenLogs = m.getLogs('d1').length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(m.get('d1').status, 'stopped');
  assert.equal(m.get('d1').tokens.total, frozen);
  assert.equal(m.getLogs('d1').length, frozenLogs);

  // Message = new scenario with the given prompt.
  m.sendMessage('d1', { prompt: 'Ajoute un mode sombre' });
  await waitFor(() => m.get('d1').status === 'working', 10000, 'd1 working again');
  assert.ok(m.getLogs('d1').some((l) => l.type === 'user' && l.text === 'Ajoute un mode sombre'));

  // Removal through the manager disposes the simulation.
  m.remove('d1');
  assert.equal(m.get('d1'), null);
  assert.equal(demo.sessions.has('d1'), false);
  demo.stopAll();
  assert.equal(m.list().length, 0);
  assert.equal(demo.active, false);
  const removed = events.remove;
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.remove, removed);
  assert.equal(m.list().length, 0, 'no demo agent comes back after stopAll');

  assert.deepEqual(spawnCalls, []);
  assert.deepEqual(calls, [], 'no child process API was used by the demo');
});

test('demo scenarios: 8–20 steps, delays 0.8–3.5 s, consistent final result', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rng = seeded(seed);
    const scenario = SCENARIOS[seed % SCENARIOS.length];
    const { items } = buildScenarioEvents({ rng, scenario, prompt: scenario.prompt, sessionId: 's', cwd: '/tmp/projet', model: 'claude-haiku-5-5', speed: 1 });
    for (const it of items) assert.ok(it.delay >= 800 && it.delay <= 3500, `delay ${it.delay}`);
    assert.equal(items[0].event.type, 'system');
    assert.equal(items[0].event.subtype, 'init');
    const result = items.at(-1).event;
    assert.equal(result.type, 'result');
    assert.equal(result.is_error, false);
    assert.ok(result.total_cost_usd > 0);
    assert.ok(result.num_turns >= 8 && result.num_turns <= 20, `steps ${result.num_turns}`);
    const toolUses = items.filter((i) => i.event.type === 'assistant' && i.event.message.content[0].type === 'tool_use');
    assert.ok(toolUses.length >= 5);
  }
  // Every scenario is French and has a prompt.
  for (const s of SCENARIOS) {
    assert.ok(s.prompt.length > 10);
    assert.ok(s.final.length > 10);
  }
});

test('demo: finished subagents of the previous run leave when a new scenario starts', async (t) => {
  const m = new AgentManager({ claude: null, spawn: () => { throw new Error('interdit'); } });
  const demo = new DemoRunner(m, { speed: 120, random: seeded(7) });
  t.after(() => demo.stopAll());
  const removed = [];
  m.on('remove', (e) => removed.push(e.id));

  demo.start(2);
  // d2's first scenario delegates to a subagent; wait until that run is over.
  await waitFor(() => m.get('d2') && m.get('d2').turns >= 1, 20000, 'first d2 scenario finished');
  const firstSubs = m.subIdsOf('d2');
  assert.ok(firstSubs.length >= 1, 'the first run created a subagent');
  assert.ok(firstSubs.every((id) => m.get(id).status === 'done'));

  // The next scenario starts after the rest period: the old helpers are removed then.
  await waitFor(() => firstSubs.every((id) => m.get(id) === null), 20000, 'old subagents pruned');
  assert.ok(firstSubs.every((id) => removed.includes(id)), 'a remove event was emitted for each pruned subagent');
  assert.ok(m.get('d2'), 'the demo root itself stays');
});
