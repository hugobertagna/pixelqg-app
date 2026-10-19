'use strict';

// Linking interactive terminal sessions to agents (AgentManager) and routing their transcripts
// (SessionWatcher), without any process: the transcripts are written by the test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { AgentManager, HqError } = require('../agents');
const { SessionWatcher, projectDirName } = require('../watcher');
const { tmpDir } = require('./helpers');

const SID = '0a1b2c3d-1111-4222-8333-444455556666';
const SID2 = '0f0f0f0f-1111-4222-8333-444455556666';
const CWD = 'C:\\Users\\dev\\mon-projet';
const TERM = { id: 't1', title: 'Terminal 1', name: 'Nova', color: '#7BC67E' };

function line(obj) {
  return JSON.stringify({ timestamp: new Date().toISOString(), cwd: CWD, ...obj }) + '\n';
}
const userPrompt = (sid, text) => line({ type: 'user', sessionId: sid, message: { role: 'user', content: text } });
const assistant = (sid, id, content, stop, usage) => line({
  type: 'assistant',
  sessionId: sid,
  message: { id, model: 'claude-opus-5-5', stop_reason: stop, content, usage: usage || { input_tokens: 5, output_tokens: 10 } },
});

function setup(t, watcherOpts = {}) {
  const projects = tmpDir('pixelqg-app-projects-');
  const dir = path.join(projects, projectDirName(CWD));
  fs.mkdirSync(dir, { recursive: true });
  let clock = Date.now();
  const m = new AgentManager({ claude: null, terminalReadyMs: 30 });
  const w = new SessionWatcher(m, { projectsDir: projects, autoPoll: false, minAgeMs: 2500, now: () => clock, ...watcherOpts });
  t.after(() => w.dispose());
  return { m, w, projects, dir, tick: (ms) => { clock += ms; } };
}

test('projects folder naming rule', () => {
  assert.equal(projectDirName('C:\\Users\\alex\\OneDrive\\Bureau'), 'C--Users-alex-OneDrive-Bureau');
  assert.equal(projectDirName('/home/dev/mon_projet.v2'), '-home-dev-mon-projet-v2');
});

test('link: validation, agent fields, child pid update, 404s', (t) => {
  const { m } = setup(t);
  const bad = (body, status, re) => assert.throws(() => m.linkTerminal(TERM, body), (e) => e instanceof HqError && e.status === status && re.test(e.message));
  bad(null, 400, /objet JSON/);
  bad({ cwd: 'relatif', pid: 12 }, 400, /chemin absolu/);
  bad({ cwd: CWD, pid: -1 }, 400, /pid/);
  bad({ cwd: CWD, pid: 12, sessionId: '../../etc' }, 400, /session/);
  bad({ linkId: 'zz' }, 400, /liaison/);
  bad({ linkId: 'ab'.repeat(12) }, 404, /Liaison introuvable/);

  const { agent, linkId, created } = m.linkTerminal(TERM, { sessionId: SID, cwd: CWD, pid: 4242, args: '--model haiku' });
  assert.equal(created, true);
  assert.match(linkId, /^[0-9a-f]{24}$/);
  assert.equal(agent.source, 'terminal');
  assert.equal(agent.kind, 'root');
  assert.equal(agent.terminalId, 't1');
  assert.equal(agent.interactive, true);
  assert.equal(agent.canControl, true);
  assert.equal(agent.name, 'Nova');
  assert.equal(agent.color, '#7BC67E');
  assert.equal(agent.prompt, '');
  assert.equal(agent.status, 'starting');
  assert.equal(agent.sessionId, SID);
  assert.equal(agent.costUsd, null);

  // Every agent carries the new fields.
  const observed = m.createRoot({ source: 'observed', cwd: CWD });
  assert.equal(observed.terminalId, null);
  assert.equal(observed.interactive, false);

  // A second session in the same terminal while the first runs: the name is made unique.
  const second = m.linkTerminal(TERM, { cwd: CWD, pid: 4343, name: 'Nova' }).agent;
  assert.equal(second.name, 'Nova 2');
  assert.equal(second.sessionId, null);
  const named = m.linkTerminal({ id: 't2', title: 'Terminal 2', name: null, color: null }, { cwd: CWD, pid: 4444, name: 'Mon\u0007 explorateur de code très long' }).agent;
  assert.equal(named.name, 'Mon explorateur de code');

  // The child pid arrives in an update; Claude Code then waits for the first prompt.
  const upd = m.linkTerminal(TERM, { linkId, childPid: 5151 });
  assert.equal(upd.linkId, linkId);
  assert.equal(upd.agent.id, agent.id);
  assert.throws(() => m.linkTerminal({ id: 't9' }, { linkId, childPid: 1 }), (e) => e.status === 404);
  return new Promise((resolve) => setTimeout(resolve, 80)).then(() => {
    assert.equal(m.get(agent.id).status, 'waiting');
    assert.equal(m.get(agent.id).activity.label, 'Attend ta réponse');
    // Follow-up messages go through the terminal, never through the API.
    assert.throws(() => m.sendMessage(agent.id, { prompt: 'salut' }), (e) => e.status === 409 && /terminal/.test(e.message));
  });
});

test('unlink: done on exit 0 (and Ctrl+C), error otherwise, idempotent', (t) => {
  const { m } = setup(t);
  const a = m.linkTerminal(TERM, { sessionId: SID, cwd: CWD, pid: 1 });
  m.unlinkTerminal(TERM, { linkId: a.linkId, exitCode: 0 });
  assert.equal(m.get(a.agent.id).status, 'done');
  assert.equal(m.get(a.agent.id).activity.kind, 'done');
  assert.ok(m.get(a.agent.id).endedAt);
  m.unlinkTerminal(TERM, { linkId: a.linkId, exitCode: 7 });
  assert.equal(m.get(a.agent.id).status, 'done', 'a second unlink changes nothing');

  const b = m.linkTerminal(TERM, { cwd: CWD, pid: 2 });
  m.unlinkTerminal(TERM, { linkId: b.linkId, exitCode: 3 });
  assert.equal(m.get(b.agent.id).status, 'error');
  assert.equal(m.get(b.agent.id).error, "Claude Code s'est arrêté (code 3)");
  assert.equal(m.get(b.agent.id).activity.kind, 'error');

  const c = m.linkTerminal(TERM, { cwd: CWD, pid: 3 });
  m.unlinkTerminal(TERM, { linkId: c.linkId, exitCode: 3221225786 });
  assert.equal(m.get(c.agent.id).status, 'done', 'Ctrl+C exit is a normal end');
  assert.throws(() => m.unlinkTerminal(TERM, { linkId: c.linkId, exitCode: 'x' }), (e) => e.status === 400);

  // Terminal closed while a session runs: stopped.
  const d = m.linkTerminal(TERM, { cwd: CWD, pid: 4 });
  m.endTerminalLinksOf('t1', { killed: true, reason: 'Arrêté : terminal fermé' });
  assert.equal(m.get(d.agent.id).status, 'stopped');

  // Relaunching a known session (claude --resume <id>) reuses its agent.
  const again = m.linkTerminal({ id: 't3', title: 'Terminal 3', name: null, color: null }, { sessionId: SID, cwd: CWD, pid: 5 });
  assert.equal(again.created, false);
  assert.equal(again.agent.id, a.agent.id);
  assert.equal(again.agent.terminalId, 't3');
  assert.equal(again.agent.status, 'starting');
  assert.equal(again.agent.endedAt, null);
});

test('watcher: linked session tracked with observation disabled, turns, tokens, exit', async (t) => {
  const { m, w, dir, tick } = setup(t);
  assert.equal(w.enabled, false, 'observation disabled');
  const file = path.join(dir, `${SID}.jsonl`);
  // An unrelated external session in the same folder must stay ignored (observation is off).
  fs.writeFileSync(path.join(dir, `${SID2}.jsonl`), userPrompt(SID2, 'autre chose'));

  const { agent, linkId } = m.linkTerminal(TERM, { sessionId: SID, cwd: CWD, pid: 1 });
  await w.poll();
  assert.equal(m.get(agent.id).status, 'starting', 'no transcript yet');

  fs.writeFileSync(file, [
    line({ type: 'custom-title', customTitle: 'Titre automatique', sessionId: SID }),
    userPrompt(SID, '<command-name>/model</command-name>'),
    userPrompt(SID, 'Corrige le bug du panier'),
  ].join(''));
  tick(100);
  await w.poll();
  let a = m.get(agent.id);
  assert.equal(a.status, 'working');
  assert.equal(a.activity.label, 'Réfléchit…');
  assert.equal(a.prompt, 'Corrige le bug du panier');
  assert.equal(a.name, 'Nova', 'automatic titles never rename a terminal agent');
  assert.ok(m.getLogs(agent.id).some((l) => l.type === 'user' && l.text === 'Corrige le bug du panier'));
  assert.equal(m.list().length, 1, 'no observed agent for the other session');

  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 };
  fs.appendFileSync(file, [
    assistant(SID, 'msg_1', [{ type: 'tool_use', id: 'tu_1', name: 'Grep', input: { pattern: 'panier' } }], 'tool_use', usage),
  ].join(''));
  tick(100);
  await w.poll();
  a = m.get(agent.id);
  assert.equal(a.activity.kind, 'search');
  assert.equal(a.toolCount, 1);

  // One message written as two lines, both carrying stop_reason end_turn: one turn only.
  fs.appendFileSync(file, [
    line({ type: 'user', sessionId: SID, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'src/panier.ts' }] } }),
    assistant(SID, 'msg_2', [{ type: 'thinking', thinking: 'ok' }], 'end_turn', usage),
    assistant(SID, 'msg_2', [{ type: 'text', text: 'Corrigé : le panier ne se vide plus.' }], 'end_turn', usage),
  ].join(''));
  tick(100);
  await w.poll();
  a = m.get(agent.id);
  assert.equal(a.status, 'waiting');
  assert.equal(a.activity.kind, 'idle');
  assert.equal(a.activity.label, 'Attend ta réponse');
  assert.equal(a.turns, 1);
  assert.equal(a.lastText, 'Corrigé : le panier ne se vide plus.');
  assert.equal(a.tokens.total, 2 * 1130);
  assert.equal(a.costUsd, null);

  // Idle timers never touch an interactive session (no "En pause", no removal).
  tick(30 * 60 * 1000);
  await w.poll();
  assert.equal(m.get(agent.id).status, 'waiting');

  // Next turn, interrupted with Esc.
  fs.appendFileSync(file, userPrompt(SID, 'Ajoute des tests'));
  tick(100);
  await w.poll();
  assert.equal(m.get(agent.id).status, 'working');
  assert.equal(m.get(agent.id).prompt, 'Corrige le bug du panier', 'prompt keeps the first one');
  fs.appendFileSync(file, line({ type: 'user', sessionId: SID, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }));
  tick(100);
  await w.poll();
  assert.equal(m.get(agent.id).status, 'waiting');
  assert.equal(m.get(agent.id).turns, 1);

  // Last lines written right before exit are read by the flush, then the session ends.
  fs.appendFileSync(file, assistant(SID, 'msg_3', [{ type: 'text', text: 'Au revoir.' }], 'end_turn'));
  await w.flushLinked();
  m.unlinkTerminal(TERM, { linkId, exitCode: 0 });
  a = m.get(agent.id);
  assert.equal(a.lastText, 'Au revoir.');
  assert.equal(a.turns, 2);
  assert.equal(a.status, 'done');
  // Once unlinked (and observation off) nothing polls any more.
  assert.equal(w._active(), false);
});

test('watcher: --continue adopts the first transcript written after the link', async (t) => {
  const { m, w, dir, tick } = setup(t);
  const oldFile = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(oldFile, userPrompt(SID, 'Ancienne question') + assistant(SID, 'old_1', [{ type: 'text', text: 'Ancienne réponse' }], 'end_turn'));
  const past = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(oldFile, past, past);

  const { agent } = m.linkTerminal(TERM, { sessionId: null, cwd: CWD, pid: 1 });
  await w.poll();
  assert.equal(m.get(agent.id).sessionId, null, 'old transcript not adopted');

  fs.appendFileSync(oldFile, userPrompt(SID, 'On continue'));
  tick(100);
  await w.poll();
  const a = m.get(agent.id);
  assert.equal(a.sessionId, SID, 'adopted');
  assert.equal(a.status, 'working');
  assert.equal(a.turns, 1, 'history replayed for the adopting agent');
  assert.deepEqual(m.terminalLinks().map((l) => l.sessionId), [SID]);
});

test('watcher: a linked session replaces its observed duplicate and is re-read for the terminal agent', async (t) => {
  const { m, w, dir, tick } = setup(t, { minAgeMs: 0 });
  const file = path.join(dir, `${SID}.jsonl`);
  fs.writeFileSync(file, userPrompt(SID, 'Bonjour') + assistant(SID, 'm1', [{ type: 'text', text: 'Salut' }], 'end_turn', { input_tokens: 1, output_tokens: 2 }));
  w.start();
  await w.poll();
  const observed = m.list().find((a) => a.source === 'observed');
  assert.ok(observed, 'observed first');

  const { agent } = m.linkTerminal(TERM, { sessionId: SID, cwd: CWD, pid: 1 });
  assert.equal(m.get(observed.id), null, 'observed duplicate removed');
  tick(100);
  await w.poll();
  const a = m.get(agent.id);
  assert.equal(a.tokens.total, 3, 'history counted for the terminal agent');
  assert.equal(a.status, 'waiting');
  fs.appendFileSync(file, userPrompt(SID, 'Encore'));
  tick(100);
  await w.poll();
  assert.equal(m.get(agent.id).status, 'working');
  assert.equal(m.list().filter((x) => x.source === 'observed').length, 0, 'never observed twice');

  // Turning observation off keeps the linked session.
  w.stop();
  fs.appendFileSync(file, assistant(SID, 'm2', [{ type: 'text', text: 'Fini' }], 'end_turn'));
  tick(100);
  await w.poll();
  assert.equal(m.get(agent.id).status, 'waiting');
  assert.equal(m.get(agent.id).lastText, 'Fini');
});

test('watcher: a linked transcript is found outside the expected folder', async (t) => {
  const { m, w, projects, tick } = setup(t);
  const elsewhere = path.join(projects, 'C--Users-dev-mon-projet-raccourci-12345');
  fs.mkdirSync(elsewhere);
  const { agent } = m.linkTerminal(TERM, { sessionId: SID, cwd: CWD, pid: 1 });
  fs.writeFileSync(path.join(elsewhere, `${SID}.jsonl`), userPrompt(SID, 'Chemin long'));
  tick(100);
  await w.poll();
  assert.equal(m.get(agent.id).status, 'working');
  assert.equal(m.get(agent.id).prompt, 'Chemin long');
});
