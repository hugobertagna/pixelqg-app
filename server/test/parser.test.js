'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const {
  AgentManager,
  LineSplitter,
  validateCreateInput,
  validatePrompt,
  toolKind,
  toolLabel,
  HqError,
} = require('../agents');
const { readFixture, tmpDir } = require('./helpers');

const SESSION = '823cabf1-afa0-46e5-88c8-cc5b7920ad59';

function newRoot(m) {
  const root = m.createRoot({ source: 'spawned', name: 'Nova', cwd: os.tmpdir(), prompt: 'Liste les fichiers', status: 'starting' });
  m.beginTurn(root.id, 'Liste les fichiers');
  return root;
}

test('parser: real fixture creates one root and one subagent with correct usage', () => {
  const m = new AgentManager({ claude: null });
  const root = newRoot(m);
  const events = readFixture();
  const resultIndex = events.findIndex((e) => e.type === 'result');
  assert.ok(resultIndex > 0, 'the fixture must contain a result event');

  for (const ev of events.slice(0, resultIndex)) m.feed(root.id, ev);

  const agents = m.list();
  assert.equal(agents.length, 2, 'one root + one sub');
  const r = m.get(root.id);
  const sub = agents.find((a) => a.kind === 'sub');
  assert.ok(sub);
  assert.equal(sub.id, `${root.id}.s1`);
  assert.equal(sub.parentId, root.id);
  assert.equal(sub.role, 'general-purpose');
  assert.equal(sub.source, 'spawned');
  assert.equal(sub.cwd, r.cwd);
  assert.ok(sub.prompt.startsWith('Glob txt files and read a.txt\n\n'), 'sub prompt = description + prompt');
  assert.notEqual(sub.name, r.name);
  assert.notEqual(sub.color, r.color);

  assert.equal(r.status, 'working');
  assert.equal(r.sessionId, SESSION);
  assert.equal(r.model, 'claude-haiku-5-5');

  // Root own usage: msg …mzBLZ + msg …nSB2n, subagent usage excluded.
  assert.deepEqual(r.tokens, { input: 4, output: 22, cacheRead: 54445, cacheWrite: 55055, total: 109526 });
  // Sub usage: msg …nB7 (two events, counted once) + msg …nKT (two events, counted once),
  // with the final output of its last message taken from the hand-back usage (120).
  assert.deepEqual(sub.tokens, { input: 4, output: 137, cacheRead: 40593, cacheWrite: 48654, total: 89388 });

  assert.equal(r.toolCount, 1);
  assert.equal(sub.toolCount, 2);
  assert.equal(sub.status, 'done');
  assert.equal(sub.activity.kind, 'done');
  assert.equal(sub.activity.label, 'Terminé ✓');
  assert.ok(sub.endedAt > 0);
  assert.match(sub.resultText, /a\.txt/);
  assert.match(r.lastText, /subagent found/);

  // Result event: done, cost, turns, reconciled output tokens.
  m.feed(root.id, events[resultIndex]);
  const done = m.get(root.id);
  assert.equal(done.status, 'done');
  assert.equal(done.costUsd, 0.01839393);
  assert.equal(done.turns, 1);
  assert.equal(done.activity.kind, 'done');
  assert.equal(done.activity.label, 'Terminé ✓');
  assert.ok(done.endedAt > 0);
  assert.match(done.resultText, /a\.txt/);
  assert.equal(done.error, null);
  assert.deepEqual(done.tokens, { input: 4, output: 313, cacheRead: 54445, cacheWrite: 55055, total: 109817 });

  // Logs
  const rootLogs = m.getLogs(root.id);
  assert.equal(rootLogs[0].type, 'user');
  assert.ok(rootLogs.some((l) => l.type === 'tool' && l.tool === 'Agent' && l.kind === 'task' && l.text.startsWith('Délègue : ')));
  assert.ok(rootLogs.some((l) => l.type === 'result'));
  const subLogs = m.getLogs(sub.id);
  assert.ok(subLogs.some((l) => l.type === 'tool' && l.tool === 'Glob' && l.text === 'Cherche *.txt'));
  assert.ok(subLogs.some((l) => l.type === 'tool' && l.tool === 'Read' && l.text === 'Lit a.txt'));
  assert.ok(subLogs.some((l) => l.type === 'tool_result' && l.tool === 'Glob'));
  for (const l of [...rootLogs, ...subLogs]) {
    assert.ok(l.text.length <= 200, 'log text ≤ 200 chars');
    assert.ok(!l.detail || l.detail.length <= 4000, 'log detail ≤ 4000 chars');
    assert.ok(!/\n/.test(l.text), 'log text is one line');
  }
});

test('parser: replaying every event twice never double counts usage', () => {
  const m = new AgentManager({ claude: null });
  const root = newRoot(m);
  const events = readFixture().filter((e) => e.type !== 'result');
  for (const ev of events) {
    m.feed(root.id, ev);
    if (ev.type === 'assistant') m.feed(root.id, ev);
  }
  const r = m.get(root.id);
  assert.deepEqual(r.tokens, { input: 4, output: 22, cacheRead: 54445, cacheWrite: 55055, total: 109526 });
});

test('parser: same message id with growing usage only adds the difference', () => {
  const m = new AgentManager({ claude: null });
  const root = newRoot(m);
  const tokenEvents = [];
  m.on('tokens', (d) => tokenEvents.push(d));
  const base = { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 };
  m.feed(root.id, { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_1', content: [{ type: 'thinking', thinking: '' }], usage: { ...base, output_tokens: 8 } } });
  m.feed(root.id, { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_1', content: [{ type: 'text', text: 'Je regarde.' }], usage: { ...base, output_tokens: 8 } } });
  m.feed(root.id, { type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Lance les tests' } }], usage: { ...base, output_tokens: 431 } } });
  const r = m.get(root.id);
  assert.deepEqual(r.tokens, { input: 2, output: 431, cacheRead: 1000, cacheWrite: 500, total: 1933 });
  assert.deepEqual(tokenEvents.map((e) => e.delta), [1510, 423]);
  assert.equal(r.activity.kind, 'bash');
  assert.equal(r.activity.tool, 'Bash');
  assert.equal(r.activity.label, 'Exécute Lance les tests');
  assert.equal(r.lastText, 'Je regarde.');
  assert.equal(r.toolCount, 1);

  m.feed(root.id, { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }], is_error: true }] } });
  assert.equal(m.get(root.id).activity.kind, 'think');
  assert.equal(m.get(root.id).activity.label, 'Réfléchit…');
  const last = m.getLogs(root.id).at(-1);
  assert.equal(last.type, 'tool_result');
  assert.equal(last.kind, 'error');
  assert.match(last.text, /^Échec de Bash/);
});

test('parser: subagent created from an unknown parent_tool_use_id, finished by task_notification', () => {
  const m = new AgentManager({ claude: null });
  const root = newRoot(m);
  m.feed(root.id, { type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-opus-5-5' });
  m.feed(root.id, {
    type: 'assistant',
    parent_tool_use_id: 'toolu_X',
    subagent_type: 'Explore',
    task_description: 'Explorer le code',
    message: { id: 'm_s1', content: [{ type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'calculerTotal' } }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  const sub = m.list().find((a) => a.kind === 'sub');
  assert.equal(sub.role, 'Explore');
  assert.equal(sub.sessionId, 's-1');
  assert.equal(sub.activity.label, 'Cherche calculerTotal');
  m.feed(root.id, { type: 'system', subtype: 'task_progress', tool_use_id: 'toolu_X', description: 'Lecture de main.ts', last_tool_name: 'Read' });
  assert.equal(m.get(sub.id).activity.kind, 'read');
  assert.equal(m.get(sub.id).activity.label, 'Lecture de main.ts');
  m.feed(root.id, { type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_X', status: 'failed', summary: 'Impossible de lire le dossier' });
  const finished = m.get(sub.id);
  assert.equal(finished.status, 'error');
  assert.equal(finished.activity.kind, 'error');
  assert.equal(finished.resultText, 'Impossible de lire le dossier');
  // An Agent tool_use announced as a background launch does not finish the sub.
  m.feed(root.id, { type: 'assistant', parent_tool_use_id: null, message: { id: 'm_r2', content: [{ type: 'tool_use', id: 'toolu_BG', name: 'Agent', input: { description: 'Veille', subagent_type: 'general-purpose', prompt: 'Surveille', run_in_background: true } }] } });
  m.feed(root.id, { type: 'user', parent_tool_use_id: null, tool_use_result: { status: 'async_launched' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_BG', content: 'Async agent launched successfully.' }] } });
  const bg = m.list().find((a) => a.kind === 'sub' && a.prompt.startsWith('Veille'));
  assert.equal(bg.status, 'working');
  // The result closes any subagent still running.
  m.feed(root.id, { type: 'result', subtype: 'success', is_error: false, result: 'Fini', total_cost_usd: 0.5 });
  assert.equal(m.get(bg.id).status, 'done');
});

test('parser: error result and cost accumulation over turns', () => {
  const m = new AgentManager({ claude: null });
  const root = newRoot(m);
  m.feed(root.id, { type: 'result', subtype: 'success', is_error: false, result: 'Un', total_cost_usd: 0.1 });
  m.beginTurn(root.id, 'encore');
  assert.equal(m.get(root.id).status, 'starting');
  assert.equal(m.get(root.id).endedAt, null);
  m.feed(root.id, { type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.2 });
  const r = m.get(root.id);
  assert.equal(r.status, 'error');
  assert.equal(r.error, 'Nombre maximal de tours atteint.');
  assert.equal(r.activity.kind, 'error');
  assert.equal(r.turns, 2);
  assert.equal(r.costUsd, 0.3);
});

test('tool kinds and French labels', () => {
  assert.equal(toolKind('Read'), 'read');
  assert.equal(toolKind('ToolSearch'), 'search');
  assert.equal(toolKind('MultiEdit'), 'edit');
  assert.equal(toolKind('PowerShell'), 'bash');
  assert.equal(toolKind('TaskStop'), 'bash');
  assert.equal(toolKind('WebSearch'), 'web');
  assert.equal(toolKind('Workflow'), 'task');
  assert.equal(toolKind('ExitPlanMode'), 'todo');
  assert.equal(toolKind('AskUserQuestion'), 'talk');
  assert.equal(toolKind('mcp__github__create_issue'), 'tool');
  assert.equal(toolKind('Inconnu'), 'tool');

  assert.equal(toolLabel('Read', { file_path: 'C:\\projet\\server\\server.js' }), 'Lit server.js');
  assert.equal(toolLabel('Edit', { file_path: '/home/a/src/paiement/stripe.ts' }), 'Modifie stripe.ts');
  assert.equal(toolLabel('Write', { file_path: 'docs/guide.md' }), 'Écrit guide.md');
  assert.equal(toolLabel('Glob', { pattern: 'src/**/*.ts' }), 'Cherche src/**/*.ts');
  assert.equal(toolLabel('Grep', { pattern: 'calculerTotal' }), 'Cherche calculerTotal');
  assert.equal(toolLabel('Bash', { command: 'npm test' }), 'Exécute npm test');
  assert.equal(toolLabel('Bash', { command: 'x'.repeat(100) }), 'Exécute ' + 'x'.repeat(39) + '…');
  assert.equal(toolLabel('WebFetch', { url: 'https://docs.anthropic.com/fr/page' }), 'Consulte docs.anthropic.com');
  assert.equal(toolLabel('WebSearch', { query: 'node test runner' }), 'Recherche « node test runner »');
  assert.equal(toolLabel('Agent', { description: 'Explorer le code' }), 'Délègue : Explorer le code');
  assert.equal(toolLabel('TodoWrite', {}), 'Organise ses tâches');
  assert.equal(toolLabel('mcp__github__create_issue', {}), 'Utilise create_issue');
  assert.ok(toolLabel('Read', { file_path: 'a'.repeat(200) }).length <= 60);
});

test('LineSplitter handles chunk boundaries, CRLF, UTF-8 and huge lines', () => {
  const lines = [];
  const s = new LineSplitter((l) => lines.push(l));
  const text = Buffer.from('{"a":"é"}\r\n{"b":2}\n\n', 'utf8');
  for (let i = 0; i < text.length; i++) s.push(text.subarray(i, i + 1));
  const huge = 'x'.repeat(3 * 1024 * 1024);
  s.push(Buffer.from(`{"big":"${huge.slice(0, 1000)}`));
  s.push(Buffer.from(`${huge.slice(1000)}"}\n{"tail":true}`));
  s.end();
  assert.equal(lines.length, 4);
  assert.deepEqual(JSON.parse(lines[0]), { a: 'é' });
  assert.deepEqual(JSON.parse(lines[1]), { b: 2 });
  assert.equal(JSON.parse(lines[2]).big.length, huge.length);
  assert.deepEqual(JSON.parse(lines[3]), { tail: true });
});

test('validation of POST /api/agents bodies (French messages)', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'fichier.txt');
  fs.writeFileSync(file, 'x');
  const ok = validateCreateInput({ prompt: 'Bonjour' });
  assert.deepEqual(ok, { prompt: 'Bonjour', name: null, color: null, model: '', cwd: os.homedir(), permissionMode: 'default', effort: '' });

  const full = validateCreateInput({ prompt: 'p', name: 'Zéphyr 2', color: '#a1b2c3', model: 'haiku', cwd: dir, permissionMode: 'acceptEdits', effort: 'max' });
  assert.equal(full.name, 'Zéphyr 2');
  assert.equal(full.color, '#A1B2C3');
  assert.equal(full.cwd, path.resolve(dir));

  const bad = (body, re) => {
    assert.throws(() => validateCreateInput(body), (err) => err instanceof HqError && err.status === 400 && re.test(err.message));
  };
  bad(null, /objet JSON/);
  bad({}, /^Le prompt est requis\.$/);
  bad({ prompt: '   ' }, /prompt est requis/);
  bad({ prompt: 42 }, /prompt est requis/);
  bad({ prompt: 'x'.repeat(100001) }, /trop long/);
  bad({ prompt: 'p', name: '-moi' }, /Nom invalide/);
  bad({ prompt: 'p', name: 'x'.repeat(25) }, /Nom invalide/);
  bad({ prompt: 'p', name: 'a<b>' }, /Nom invalide/);
  bad({ prompt: 'p', name: 12 }, /Nom invalide/);
  bad({ prompt: 'p', color: '#12345' }, /Couleur invalide/);
  bad({ prompt: 'p', color: 'red' }, /Couleur invalide/);
  bad({ prompt: 'p', model: 'gpt-4' }, /Modèle inconnu/);
  bad({ prompt: 'p', cwd: 'relatif/dossier' }, /chemin absolu/);
  bad({ prompt: 'p', cwd: path.join(dir, 'absent') }, /n'existe pas/);
  bad({ prompt: 'p', cwd: file }, /n'existe pas ou n'est pas un dossier/);
  bad({ prompt: 'p', permissionMode: 'yolo' }, /Mode de permission inconnu/);
  bad({ prompt: 'p', effort: 'ultra' }, /effort inconnu/);
  assert.equal(validatePrompt('x'.repeat(100000)).length, 100000);
});

test('manager: stop/message/remove guards', () => {
  const m = new AgentManager({ claude: null });
  const observed = m.createRoot({ source: 'observed', id: 'o-12345678', cwd: os.tmpdir(), status: 'working', canControl: false });
  assert.throws(() => m.stop(observed.id), (e) => e.status === 409);
  assert.throws(() => m.sendMessage(observed.id, { prompt: 'x' }), (e) => e.status === 409);
  assert.throws(() => m.stop('nope'), (e) => e.status === 404 && e.message === 'Agent introuvable.');
  const root = newRoot(m);
  assert.throws(() => m.sendMessage(root.id, { prompt: 'x' }), (e) => e.status === 409 && /travaille encore/.test(e.message));
  m.feed(root.id, { type: 'result', is_error: false, result: 'ok' });
  assert.throws(() => m.sendMessage(root.id, { prompt: 'x' }), (e) => e.status === 409 && /sessionId/.test(e.message));
  assert.throws(() => m.sendMessage(root.id, { prompt: '' }), (e) => e.status === 400);
  const removed = [];
  m.on('remove', (d) => removed.push(d.id));
  m.feed(root.id, { type: 'assistant', parent_tool_use_id: 'toolu_Z', message: { id: 'q', content: [{ type: 'text', text: 'hi' }] } });
  const sub = m.list().find((a) => a.kind === 'sub');
  m.remove(sub.id);
  // Events for a removed sub are dropped instead of recreating it.
  m.feed(root.id, { type: 'assistant', parent_tool_use_id: 'toolu_Z', message: { id: 'q2', content: [{ type: 'text', text: 'encore' }] } });
  assert.equal(m.list().filter((a) => a.kind === 'sub').length, 0);
  m.remove(root.id);
  assert.deepEqual(removed, [sub.id, root.id]);
  assert.equal(m.get(root.id), null);
});

test('logs are capped at 500 entries per agent', () => {
  const m = new AgentManager({ claude: null });
  const root = newRoot(m);
  for (let i = 0; i < 620; i++) {
    m.feed(root.id, { type: 'assistant', parent_tool_use_id: null, message: { id: `m${i}`, content: [{ type: 'text', text: `ligne ${i}` }] } });
  }
  const logs = m.getLogs(root.id);
  assert.equal(logs.length, 500);
  assert.equal(logs.at(-1).text, 'ligne 619');
});
