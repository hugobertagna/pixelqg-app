'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AgentManager } = require('../agents');
const { SessionWatcher } = require('../watcher');
const { tmpDir } = require('./helpers');

const SID = 'a1b2c3d4-1111-4222-8333-444455556666';
const SID_SPAWNED = 'ffffffff-1111-4222-8333-444455556666';

function line(obj) {
  return JSON.stringify(obj) + '\n';
}

function assistant(id, content, usage, extra = {}) {
  return line({
    type: 'assistant',
    sessionId: SID,
    cwd: extra.cwd || 'C:\\Users\\dev\\mon-projet',
    timestamp: new Date().toISOString(),
    message: { id, model: 'claude-opus-5-5', role: 'assistant', content, usage },
    ...extra,
  });
}

test('watcher: tails external transcripts like the stream parser', async (t) => {
  const projects = tmpDir('pixelqg-app-projects-');
  const projectDir = path.join(projects, 'C--Users-dev-mon-projet');
  fs.mkdirSync(projectDir);
  const file = path.join(projectDir, `${SID}.jsonl`);

  let clock = Date.now();
  const m = new AgentManager({ claude: null });
  const w = new SessionWatcher(m, {
    projectsDir: projects,
    autoPoll: false,
    minAgeMs: 0,
    idleMs: 90 * 1000,
    removeMs: 20 * 60 * 1000,
    now: () => clock,
  });
  t.after(() => w.dispose());
  const tokenEvents = [];
  const logEvents = [];
  const removed = [];
  m.on('tokens', (d) => tokenEvents.push(d));
  m.on('log', (d) => logEvents.push(d));
  m.on('remove', (d) => removed.push(d.id));

  const usage = { input_tokens: 3, output_tokens: 8, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 };
  fs.writeFileSync(file, [
    line({ type: 'queue-operation', operation: 'enqueue', sessionId: SID }),
    line({ type: 'user', sessionId: SID, cwd: 'C:\\Users\\dev\\mon-projet', timestamp: new Date().toISOString(), message: { role: 'user', content: 'Corrige le bug de la page panier' } }),
    assistant('msg_A', [{ type: 'thinking', thinking: '' }], usage),
    assistant('msg_A', [{ type: 'tool_use', id: 'tu_read', name: 'Read', input: { file_path: 'C:\\Users\\dev\\mon-projet\\src\\panier.ts' } }], { ...usage, output_tokens: 431 }),
    line({ type: 'user', sessionId: SID, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_read', content: '1\texport const panier = [];' }] }, toolUseResult: { type: 'text' } }),
    '{"type":"assistant", this line is broken\n',
  ].join(''));

  w.start();
  await w.poll();

  const id = `o-${SID.slice(0, 8)}`;
  const a = m.get(id);
  assert.ok(a, 'observed agent created');
  assert.equal(a.source, 'observed');
  assert.equal(a.canControl, false);
  assert.equal(a.kind, 'root');
  assert.equal(a.name, 'mon-projet');
  assert.equal(a.sessionId, SID);
  assert.equal(a.cwd, 'C:\\Users\\dev\\mon-projet');
  assert.equal(a.prompt, 'Corrige le bug de la page panier');
  assert.equal(a.model, 'claude-opus-5-5');
  assert.equal(a.status, 'working');
  assert.equal(a.activity.kind, 'think');
  assert.equal(a.toolCount, 1);
  assert.deepEqual(a.tokens, { input: 3, output: 431, cacheRead: 1000, cacheWrite: 200, total: 1634 });
  assert.equal(tokenEvents.length, 0, 'history catch-up does not trigger token FX');
  assert.equal(logEvents.length, 0, 'history catch-up does not stream logs');
  assert.ok(m.getLogs(id).some((l) => l.type === 'tool' && l.text === 'Lit panier.ts'));

  // Appended lines (name line + new message + a partial line still being written).
  fs.appendFileSync(file, line({ type: 'agent-name', agentName: 'Explorateur du panier' , sessionId: SID }));
  fs.appendFileSync(file, assistant('msg_B', [{ type: 'text', text: 'Le panier est vidé trop tôt.' }], { input_tokens: 1, output_tokens: 50, cache_read_input_tokens: 1200, cache_creation_input_tokens: 10 }));
  const partial = assistant('msg_C', [{ type: 'tool_use', id: 'tu_edit', name: 'Edit', input: { file_path: 'src/panier.ts' } }], { input_tokens: 1, output_tokens: 5 });
  fs.appendFileSync(file, partial.slice(0, 40));
  clock += 1000;
  await w.poll();
  const b = m.get(id);
  assert.equal(b.name, 'Explorateur du panier'.slice(0, 24));
  assert.equal(b.lastText, 'Le panier est vidé trop tôt.');
  assert.equal(b.tokens.total, 1634 + 1261);
  assert.deepEqual(tokenEvents.map((e) => e.delta), [1261]);
  assert.ok(logEvents.length > 0, 'live lines stream logs');
  assert.equal(b.toolCount, 1, 'partial line not parsed yet');

  fs.appendFileSync(file, partial.slice(40));
  clock += 1000;
  await w.poll();
  assert.equal(m.get(id).toolCount, 2);
  assert.equal(m.get(id).activity.kind, 'edit');

  // Subagent transcript with its meta file.
  const subDir = path.join(projectDir, SID, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.appendFileSync(file, assistant('msg_D', [{ type: 'tool_use', id: 'toolu_SUB', name: 'Agent', input: { description: 'Explorer les tests', subagent_type: 'Explore', prompt: 'Trouve les tests du panier' } }], { input_tokens: 1, output_tokens: 20 }));
  fs.writeFileSync(path.join(subDir, 'agent-a123.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Explorer les tests', toolUseId: 'toolu_SUB' }));
  fs.writeFileSync(path.join(subDir, 'agent-a123.jsonl'), [
    line({ type: 'user', isSidechain: true, agentId: 'a123', sessionId: SID, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Trouve les tests du panier' } }),
    line({ type: 'assistant', isSidechain: true, agentId: 'a123', sessionId: SID, timestamp: new Date().toISOString(), message: { id: 'msg_S1', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'tu_g', name: 'Glob', input: { pattern: 'tests/**/*.test.ts' } }], usage: { input_tokens: 2, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 } } }),
    line({ type: 'assistant', isSidechain: true, agentId: 'a123', sessionId: SID, timestamp: new Date().toISOString(), message: { id: 'msg_S1', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'Deux fichiers de test trouvés.' }], usage: { input_tokens: 2, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 } } }),
  ].join(''));
  clock += 1000;
  await w.poll();
  const subs = m.list().filter((x) => x.parentId === id);
  assert.equal(subs.length, 1, 'one subagent (tool_use and transcript share the key)');
  const sub = subs[0];
  assert.equal(sub.role, 'Explore');
  assert.equal(sub.source, 'observed');
  assert.equal(sub.canControl, false);
  assert.equal(sub.model, 'claude-haiku-5-5');
  assert.equal(sub.toolCount, 1);
  assert.equal(sub.tokens.total, 5032);
  assert.equal(sub.lastText, 'Deux fichiers de test trouvés.');
  assert.equal(sub.status, 'working');
  fs.appendFileSync(file, line({ type: 'user', sessionId: SID, timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_SUB', content: [{ type: 'text', text: 'Deux fichiers de test trouvés.' }] }] }, toolUseResult: { status: 'completed' } }));
  clock += 1000;
  await w.poll();
  assert.equal(m.get(sub.id).status, 'done');

  // Idle -> waiting, then back to working on new activity.
  clock += 91 * 1000;
  await w.poll();
  assert.equal(m.get(id).status, 'waiting');
  assert.equal(m.get(id).activity.kind, 'idle');
  assert.equal(m.get(id).activity.label, 'En pause');
  fs.appendFileSync(file, assistant('msg_E', [{ type: 'text', text: 'Je reprends.' }], { input_tokens: 1, output_tokens: 3 }));
  clock += 1000;
  await w.poll();
  assert.equal(m.get(id).status, 'working');

  // Removed by the user: hidden until new activity, then it comes back.
  m.remove(id);
  clock += 1000;
  await w.poll();
  assert.equal(m.get(id), null, 'stays hidden without new lines');
  fs.appendFileSync(file, assistant('msg_F', [{ type: 'text', text: 'Toujours là.' }], { input_tokens: 1, output_tokens: 3 }));
  clock += 1000;
  await w.poll();
  assert.ok(m.get(id), 'reappears on new activity');
  assert.equal(m.get(id).lastText, 'Toujours là.');

  // No change for 20 minutes -> removed.
  removed.length = 0;
  clock += 21 * 60 * 1000;
  await w.poll();
  assert.equal(m.get(id), null);
  assert.ok(removed.includes(id));
});

test('watcher: skips sessions spawned by PixelQG and old files; disabling removes observed agents', async (t) => {
  const projects = tmpDir('pixelqg-app-projects-');
  const projectDir = path.join(projects, 'C--projet');
  fs.mkdirSync(projectDir);
  const m = new AgentManager({ claude: null });
  const w = new SessionWatcher(m, { projectsDir: projects, autoPoll: false, minAgeMs: 0 });
  t.after(() => w.dispose());

  m.spawnedSessionIds.add(SID_SPAWNED);
  fs.writeFileSync(path.join(projectDir, `${SID_SPAWNED}.jsonl`), assistant('m1', [{ type: 'text', text: 'moi-même' }], { input_tokens: 1 }));
  const oldFile = path.join(projectDir, '99999999-1111-4222-8333-444455556666.jsonl');
  fs.writeFileSync(oldFile, assistant('m2', [{ type: 'text', text: 'vieux' }], { input_tokens: 1 }));
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(oldFile, old, old);
  fs.writeFileSync(path.join(projectDir, `${SID}.jsonl`), assistant('m3', [{ type: 'text', text: 'externe' }], { input_tokens: 1 }));
  // A stray non-session file and an unreadable directory entry must not break the scan.
  fs.writeFileSync(path.join(projectDir, 'notes.txt'), 'hello');

  w.start();
  await w.poll();
  const ids = m.list().map((a) => a.id).sort();
  assert.deepEqual(ids, [`o-${SID.slice(0, 8)}`]);

  // A session that becomes "spawned" later is dropped.
  const removed = [];
  m.on('remove', (d) => removed.push(d.id));
  m.spawnedSessionIds.add(SID);
  m.emit('session', { id: 'a1', sessionId: SID });
  assert.deepEqual(removed, [`o-${SID.slice(0, 8)}`]);
  fs.appendFileSync(path.join(projectDir, `${SID}.jsonl`), assistant('m5', [{ type: 'text', text: 'ignoré' }], { input_tokens: 1 }));
  await w.poll();
  assert.equal(m.list().length, 0, 'a session claimed by HQ stays ignored');

  // Disable / re-enable: a fresh scan picks up other recent sessions again.
  w.stop();
  w.start();
  await w.poll();
  assert.equal(m.list().length, 0);
  const other = '12121212-1111-4222-8333-444455556666';
  fs.writeFileSync(path.join(projectDir, `${other}.jsonl`), assistant('m4', [{ type: 'text', text: 'nouveau' }], { input_tokens: 1 }));
  await w.poll();
  assert.deepEqual(m.list().map((a) => a.id), ['o-12121212']);
  w.setEnabled(false);
  assert.equal(m.list().length, 0);
  assert.equal(w.enabled, false);
});

test('watcher: big transcripts are read from the last 4 MB, starting at a line boundary', async (t) => {
  const projects = tmpDir('pixelqg-app-projects-');
  const projectDir = path.join(projects, 'C--gros');
  fs.mkdirSync(projectDir);
  const m = new AgentManager({ claude: null });
  const w = new SessionWatcher(m, { projectsDir: projects, autoPoll: false, minAgeMs: 0, maxInitialBytes: 4000, tailBytes: 1500 });
  t.after(() => w.dispose());
  let content = '';
  for (let i = 0; i < 40; i++) content += assistant(`m${i}`, [{ type: 'text', text: `message numéro ${i}` }], { input_tokens: 1 });
  fs.writeFileSync(path.join(projectDir, `${SID}.jsonl`), content);
  w.start();
  await w.poll();
  const a = m.get(`o-${SID.slice(0, 8)}`);
  assert.ok(a);
  assert.equal(a.lastText, 'message numéro 39');
  assert.ok(a.tokens.input > 0 && a.tokens.input < 40, 'only the tail was read');
});
