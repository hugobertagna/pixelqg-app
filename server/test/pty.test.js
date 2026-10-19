'use strict';

// ConPTY bridge (server/bin/hq-pty.exe), driven hidden from Node exactly like terminals.js does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const { BRIDGE_EXE, frame, FRAME_INPUT, FRAME_RESIZE, FRAME_TERMINATE } = require('../terminals');
const { tmpDir, waitFor } = require('./helpers');

const skip = process.platform !== 'win32' ? 'Windows uniquement' : !fs.existsSync(BRIDGE_EXE) ? 'hq-pty.exe absent' : false;

function stripAnsi(s) {
  return s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function startBridge(cmd, { cols = 120, rows = 30, cwd = tmpDir('pixelqg-app-pty-') } = {}) {
  const child = childProcess.spawn(BRIDGE_EXE, ['--cols', String(cols), '--rows', String(rows), '--cwd', cwd, '--cmd', cmd], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = { child, out: '', err: '', exit: null, cwd };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    state.out += d;
  });
  child.stderr.on('data', (d) => {
    state.err += d.toString('utf8');
  });
  child.stdin.on('error', () => {});
  child.on('exit', (code) => {
    state.exit = { code };
  });
  state.send = (type, payload) => child.stdin.write(frame(type, payload));
  state.text = () => stripAnsi(state.out);
  return state;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Starts a node grandchild inside the shell that writes "<pid> <ppid>" to a file, and returns both pids. */
async function startGrandchild(b) {
  const pidFile = path.join(b.cwd, `enfant-${Date.now()}.txt`);
  const code = "require('fs').writeFileSync(process.argv[1], process.pid + ' ' + process.ppid); setInterval(() => {}, 1000)";
  b.send(FRAME_INPUT, `"${process.execPath}" -e "${code}" "${pidFile}"\r`);
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').includes(' '), 10000, 'grandchild started');
  const [pid, ppid] = fs.readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
  return { pid, shellPid: ppid };
}

test('pty bridge: round-trip, UTF-8, resize and terminate frame', { skip }, async (t) => {
  const b = startBridge('cmd.exe /k');
  t.after(() => b.child.kill());
  await waitFor(() => b.text().includes('>'), 10000, 'prompt');
  b.send(FRAME_INPUT, 'echo bonjour é\r');
  await waitFor(() => (b.text().match(/bonjour é/g) || []).length >= 2, 10000, 'echo output');

  const size = Buffer.alloc(4);
  size.writeUInt16LE(100, 0);
  size.writeUInt16LE(40, 2);
  b.send(FRAME_RESIZE, size);
  await new Promise((r) => setTimeout(r, 100));
  const before = b.text().length;
  b.send(FRAME_INPUT, 'mode con\r');
  // `mode con` prints the console size: 40 lines, 100 columns (labels depend on the Windows language).
  await waitFor(() => {
    const after = b.text().slice(before);
    return /\b40\b/.test(after) && /\b100\b/.test(after);
  }, 10000, 'mode con reports 100x40');

  const { pid, shellPid } = await startGrandchild(b);
  assert.ok(alive(pid) && alive(shellPid));
  b.send(FRAME_TERMINATE);
  await waitFor(() => b.exit, 5000, 'bridge exit');
  await waitFor(() => !alive(pid) && !alive(shellPid), 5000, 'shell tree gone');
  assert.equal(b.err, '');
});

test('pty bridge: child exit code is propagated', { skip }, async () => {
  const b = startBridge('cmd.exe /c exit 3');
  await waitFor(() => b.exit, 10000, 'bridge exit');
  assert.equal(b.exit.code, 3);
});

test('pty bridge: EOF on stdin terminates the shell', { skip }, async () => {
  const b = startBridge('cmd.exe /k');
  await waitFor(() => b.text().includes('>'), 10000, 'prompt');
  const { pid, shellPid } = await startGrandchild(b);
  b.child.stdin.end();
  await waitFor(() => b.exit, 5000, 'bridge exit');
  await waitFor(() => !alive(pid) && !alive(shellPid), 5000, 'shell tree gone');
});

test('pty bridge: killing the bridge kills the whole tree (kill-on-close job)', { skip }, async () => {
  const b = startBridge('cmd.exe /k');
  await waitFor(() => b.text().includes('>'), 10000, 'prompt');
  const { pid, shellPid } = await startGrandchild(b);
  const bridgePid = b.child.pid;
  b.child.kill(); // TerminateProcess: no chance to clean up, only the job object can do it
  await waitFor(() => b.exit, 5000, 'bridge exit');
  await waitFor(() => !alive(pid) && !alive(shellPid), 5000, 'shell tree gone');
  // No orphan left behind either (conhost included): nothing still runs with the bridge as parent.
  const orphans = childProcess.execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${bridgePid}").Count`,
  ], { windowsHide: true, encoding: 'utf8' }).trim();
  assert.equal(orphans, '0');
});

test('pty bridge: errors are reported in French with exit codes 90+', { skip }, async () => {
  const missing = path.join(tmpDir(), 'absent');
  const b = startBridge('cmd.exe /k', { cwd: missing });
  await waitFor(() => b.exit, 5000, 'bridge exit');
  assert.equal(b.exit.code, 92);
  assert.match(b.err, /Dossier de travail introuvable/);

  const bad = childProcess.spawnSync(BRIDGE_EXE, ['--cols'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(bad.status, 90);
  assert.match(bad.stderr, /Arguments invalides/);
});
