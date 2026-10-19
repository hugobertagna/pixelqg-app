'use strict';

// `claude` shim of the integrated terminal: argument analysis (no process involved).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { planSession, isPassThrough, realClaude } = require('../claude-shim');
const { SHIM_DIR } = require('../terminals');
const { tmpDir } = require('./helpers');

const UUID = '123e4567-e89b-42d3-a456-426614174000';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('shim: one-shot runs pass through without linking', () => {
  for (const args of [['-p', 'bonjour'], ['--print'], ['--print=json'], ['-v'], ['--version'], ['-h'], ['--help'],
    ['mcp', 'list'], ['config'], ['update'], ['doctor'], ['install'], ['plugin', 'add', 'x'], ['agents'], ['setup-token'], ['migrate-installer']]) {
    assert.equal(isPassThrough(args), true, args.join(' '));
  }
  for (const args of [[], ['explique ce projet'], ['--model', 'haiku'], ['-c'], ['--', '-p'], ['dis', 'mcp']]) {
    assert.equal(isPassThrough(args), false, args.join(' '));
  }
});

test('shim: session id planning', () => {
  const fresh = planSession(['--model', 'haiku', 'Salut']);
  assert.match(fresh.sessionId, UUID_RE);
  assert.deepEqual(fresh.args, ['--model', 'haiku', 'Salut', '--session-id', fresh.sessionId]);
  assert.equal(fresh.name, null);

  assert.deepEqual(planSession(['--session-id', UUID]), { sessionId: UUID, args: ['--session-id', UUID], name: null });
  assert.equal(planSession([`--session-id=${UUID}`]).sessionId, UUID);
  assert.deepEqual(planSession(['-r', UUID]), { sessionId: UUID, args: ['-r', UUID], name: null });
  assert.equal(planSession([`--resume=${UUID}`]).sessionId, UUID);

  for (const args of [['-c'], ['--continue', 'suite'], ['--resume'], ['-r', '--model', 'opus'], ['--resume', 'mot clé']]) {
    const plan = planSession(args);
    assert.equal(plan.sessionId, null, args.join(' '));
    assert.deepEqual(plan.args, args, 'nothing added');
  }

  const fork = planSession(['--resume', UUID, '--fork-session']);
  assert.match(fork.sessionId, UUID_RE);
  assert.notEqual(fork.sessionId, UUID);
  assert.deepEqual(fork.args.slice(-2), ['--session-id', fork.sessionId]);

  assert.equal(planSession(['-n', 'Explorateur']).name, 'Explorateur');
  assert.equal(planSession(['--name=Mochi', 'go']).name, 'Mochi');
  assert.equal(planSession(['--session-id', '../../x']).sessionId, null, 'unsafe ids are never sent');
});

test('shim: real claude resolution', () => {
  const js = path.join(tmpDir(), 'cli.js');
  fs.writeFileSync(js, '');
  assert.deepEqual(realClaude({ PIXELQG_REAL_CLAUDE: js }), { command: process.execPath, prefixArgs: [js] });
  assert.deepEqual(realClaude({ PIXELQG_REAL_CLAUDE: process.execPath, PIXELQG_REAL_PREFIX: JSON.stringify([js]) }), { command: process.execPath, prefixArgs: [js] });
  assert.deepEqual(realClaude({ PIXELQG_REAL_CLAUDE: 'C:\\outils\\claude.exe', PIXELQG_REAL_PREFIX: '{pas un tableau' }), { command: 'C:\\outils\\claude.exe', prefixArgs: [] });
  // Outside HQ, the shim directory itself is skipped (never resolves to itself; it may still find
  // an installed Claude Code in its usual locations).
  const outside = realClaude({ PATH: SHIM_DIR });
  assert.ok(!outside || !path.resolve(outside.command).toLowerCase().startsWith(path.resolve(SHIM_DIR).toLowerCase()));
  assert.ok(fs.readFileSync(path.join(SHIM_DIR, 'claude.cmd'), 'utf8').endsWith('%*\r\n'), 'claude.cmd uses CRLF');
});
