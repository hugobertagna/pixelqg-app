#!/usr/bin/env node
'use strict';

// Fake INTERACTIVE Claude Code used by the terminal tests (never calls any API).
// It behaves like a TUI session from the transcript's point of view: it writes a synthetic
// transcript into FAKE_CLAUDE_PROJECTS/<cwd with non-alphanumerics replaced by "-">/<session>.jsonl.
//
//   --version                 prints "2.1.302 (Claude Code)"
//   --session-id X / --resume X   session id X; --continue: the newest transcript of the cwd
//   first positional argument  the prompt (default "Bonjour")
//
// Script (each step waits for a file in FAKE_CLAUDE_CTL, or 150 ms when it is not set):
//   start: prints "FAKE-CLAUDE <session id>" on stdout
//   1. user prompt line                                 waits for <ctl>/turn
//   2. assistant thinking+tool_use (stop_reason tool_use, usage), tool_result,
//      assistant thinking+text sharing one message id, both with stop_reason end_turn
//                                                       waits for <ctl>/exit
//   exits with FAKE_CLAUDE_EXIT (default 0).
// Env FAKE_CLAUDE_LOG=<file> appends one JSON line per invocation {args, cwd, pid, sessionId}.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// When `node --test` collects every .js file of a test directory, do nothing.
if (process.env.NODE_TEST_CONTEXT && !process.env.HQ_FAKE_CLAUDE) process.exit(0);

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('2.1.302 (Claude Code)\n');
  process.exit(0);
}

const projects = process.env.FAKE_CLAUDE_PROJECTS;
const ctl = process.env.FAKE_CLAUDE_CTL || '';
const exitCode = Number(process.env.FAKE_CLAUDE_EXIT || 0);
const cwd = process.cwd();
const dir = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'));
fs.mkdirSync(dir, { recursive: true });

function valueOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function newestSession() {
  let best = null;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const st = fs.statSync(path.join(dir, name));
    if (!best || st.mtimeMs > best.mtime) best = { id: name.slice(0, -6), mtime: st.mtimeMs };
  }
  return best ? best.id : null;
}

let sessionId = valueOf('--session-id') || valueOf('--resume') || valueOf('-r');
if (!sessionId && (args.includes('--continue') || args.includes('-c'))) sessionId = newestSession();
if (!sessionId) sessionId = crypto.randomUUID();
const positional = args.filter((a, i) => !a.startsWith('-') && !(i > 0 && args[i - 1].startsWith('-')));
const prompt = positional[0] || 'Bonjour';
const file = path.join(dir, `${sessionId}.jsonl`);

if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, cwd, pid: process.pid, sessionId }) + '\n');
}

function write(obj) {
  fs.appendFileSync(file, JSON.stringify({ sessionId, cwd, timestamp: new Date().toISOString(), ...obj }) + '\n');
}

function waitFor(name) {
  return new Promise((resolve) => {
    if (!ctl) {
      setTimeout(resolve, 150);
      return;
    }
    const target = path.join(ctl, name);
    const tick = () => (fs.existsSync(target) ? resolve() : setTimeout(tick, 20));
    tick();
  });
}

const usage = (output) => ({ input_tokens: 10, output_tokens: output, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100 });
const tag = crypto.randomBytes(4).toString('hex');

async function run() {
  process.stdout.write(`FAKE-CLAUDE ${sessionId}\r\n`);
  write({ type: 'user', message: { role: 'user', content: prompt } });
  await waitFor('turn');
  write({ type: 'assistant', message: { id: `msg_1_${tag}`, model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'Je regarde.' }], usage: usage(20) } });
  write({ type: 'assistant', message: { id: `msg_1_${tag}`, model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `tu_${tag}`, name: 'Read', input: { file_path: path.join(cwd, 'README.md') } }], usage: usage(40) } });
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tu_${tag}`, content: 'contenu du fichier' }] }, toolUseResult: { type: 'text' } });
  write({ type: 'assistant', message: { id: `msg_2_${tag}`, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'Je réponds.' }], usage: usage(5) } });
  write({ type: 'assistant', message: { id: `msg_2_${tag}`, model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: `Réponse à « ${prompt} »` }], usage: usage(5) } });
  await waitFor('exit');
  process.exit(exitCode);
}

process.on('SIGINT', () => {});
run();
