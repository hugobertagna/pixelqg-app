'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { COLORS, NAMES, pickName, pickColor } = require('../names');
const { resolveClaude, getVersion, parseCmdShim } = require('../claude-bin');
const { AgentManager } = require('../agents');
const { FAKE_CLAUDE, tmpDir } = require('./helpers');

test('names: pool order, live names avoided, numbered when exhausted', () => {
  assert.equal(NAMES.length, 24);
  assert.equal(NAMES[0], 'Nova');
  assert.equal(NAMES[5], 'Zéphyr');
  assert.equal(pickName([]), 'Nova');
  assert.equal(pickName(['Nova', 'pixel']), 'Biscotte');
  assert.equal(pickName(NAMES), 'Nova 2');
  assert.equal(pickName([...NAMES, 'Nova 2']), 'Pixel 2');
  for (const n of NAMES) assert.match(n, /^[\p{L}\p{N} _.-]+$/u);
});

test('colors: palette order, live colors avoided, least used when all taken', () => {
  assert.deepEqual(COLORS, ['#D97757', '#5BA4E6', '#7BC67E', '#B48EE0', '#F2C14E', '#E0709B', '#4FC1B9', '#E8955A', '#8E9BF0', '#C9D86B', '#F07C6C', '#A0A7B8']);
  assert.equal(pickColor([]), '#D97757');
  assert.equal(pickColor(['#d97757']), '#5BA4E6');
  assert.equal(pickColor([...COLORS, ...COLORS.slice(0, 3)]), '#B48EE0');
});

test('manager allocates distinct names and colors to live agents only', () => {
  const m = new AgentManager({ claude: null });
  const a = m.createRoot({ source: 'demo', cwd: '/tmp', status: 'starting' });
  const b = m.createRoot({ source: 'demo', cwd: '/tmp', status: 'starting' });
  assert.equal(a.name, 'Nova');
  assert.equal(b.name, 'Pixel');
  assert.equal(a.color, '#D97757');
  assert.equal(b.color, '#5BA4E6');
  m.remove(a.id);
  const c = m.createRoot({ source: 'demo', cwd: '/tmp', status: 'starting' });
  assert.equal(c.name, 'Nova', 'a freed name is reused');
  assert.equal(c.color, '#D97757');
});

test('claude-bin: CLAUDE_BIN .js file runs with the current node', async () => {
  const resolved = resolveClaude({ env: { CLAUDE_BIN: FAKE_CLAUDE, PATH: '' } });
  assert.deepEqual(resolved, { command: process.execPath, prefixArgs: [FAKE_CLAUDE], path: FAKE_CLAUDE });
  const prev = process.env.HQ_FAKE_CLAUDE;
  process.env.HQ_FAKE_CLAUDE = '1';
  try {
    assert.equal(await getVersion(resolved), '2.1.302 (Claude Code)');
  } finally {
    if (prev === undefined) delete process.env.HQ_FAKE_CLAUDE;
    else process.env.HQ_FAKE_CLAUDE = prev;
  }
  assert.equal(await getVersion(null), null);
  assert.equal(await getVersion({ command: path.join(tmpDir(), 'absent.exe'), prefixArgs: [] }), null);
});

test('claude-bin: npm .cmd shims are unwrapped to their real target (no shell)', () => {
  const dir = tmpDir();
  const target = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'claude.exe'), '');
  const shim = path.join(dir, 'claude.cmd');
  fs.writeFileSync(shim, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
  assert.equal(parseCmdShim(shim), path.join(target, 'claude.exe'));

  const legacy = path.join(dir, 'legacy');
  fs.mkdirSync(path.join(legacy, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true });
  const cli = path.join(legacy, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
  fs.writeFileSync(cli, '');
  const legacyShim = path.join(legacy, 'claude.cmd');
  fs.writeFileSync(legacyShim, '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n)\r\n');
  assert.equal(parseCmdShim(legacyShim), cli);

  // Through CLAUDE_BIN and through a PATH scan (win32 rules).
  assert.deepEqual(resolveClaude({ env: { CLAUDE_BIN: shim, PATH: '' }, platform: 'win32' }).command, path.join(target, 'claude.exe'));
  const viaPath = resolveClaude({ env: { PATH: `${tmpDir()}${path.delimiter}${legacy}` }, platform: 'win32' });
  assert.deepEqual(viaPath, { command: process.execPath, prefixArgs: [cli], path: cli });

  const exeDir = tmpDir();
  fs.writeFileSync(path.join(exeDir, 'claude.exe'), '');
  const direct = resolveClaude({ env: { PATH: `"${exeDir}"` }, platform: 'win32' });
  assert.equal(direct.command, path.join(exeDir, 'claude.exe'));
  assert.deepEqual(direct.prefixArgs, []);

  const warnings = [];
  const missing = resolveClaude({ env: { CLAUDE_BIN: path.join(dir, 'nope.exe'), PATH: exeDir }, platform: 'win32', onWarning: (w) => warnings.push(w) });
  assert.equal(missing.command, path.join(exeDir, 'claude.exe'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CLAUDE_BIN/);
});
