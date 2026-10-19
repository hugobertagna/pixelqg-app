#!/usr/bin/env node
'use strict';

// Fake Claude Code CLI used by the end-to-end tests (never calls any API).
//
//   --version            prints "2.1.302 (Claude Code)"
//   otherwise            reads the prompt from stdin, then replays
//                        fixtures/sample-stream.jsonl on stdout (≈40 ms per line),
//                        with session_id rewritten to a fixed uuid, or to X when
//                        "--resume X" is given. Exits 0.
//   prompt has "CRASH"   writes an error on stderr and exits 1 without a result.
//   prompt has "SLOW"    waits 30 s between lines (used by the stop tests).
//
// Env: FAKE_CLAUDE_LOG=<file> appends one JSON line per invocation {args, prompt, cwd, pid}.

const fs = require('node:fs');
const path = require('node:path');

// When `node --test` collects every .js file of a test directory, do nothing.
if (process.env.NODE_TEST_CONTEXT && !process.env.HQ_FAKE_CLAUDE) process.exit(0);

const FIXED_SESSION = '11111111-2222-4333-8444-555555555555';
const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('2.1.302 (Claude Code)\n');
  process.exit(0);
}

const resumeAt = args.indexOf('--resume');
const sessionId = resumeAt >= 0 && args[resumeAt + 1] ? args[resumeAt + 1] : FIXED_SESSION;

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  if (process.env.FAKE_CLAUDE_LOG) {
    try {
      fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt, cwd: process.cwd(), pid: process.pid }) + '\n');
    } catch {
      /* logging is best effort */
    }
  }
  if (prompt.includes('CRASH')) {
    process.stderr.write('Erreur : plantage simulé de Claude Code (CRASH demandé).\n');
    process.exit(1);
    return;
  }
  const fixture = path.join(__dirname, 'fixtures', 'sample-stream.jsonl');
  const lines = fs.readFileSync(fixture, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  const delay = prompt.includes('SLOW') ? 30000 : Number(process.env.FAKE_CLAUDE_DELAY || 40);
  let i = 0;
  const next = () => {
    if (i >= lines.length) {
      process.exitCode = 0;
      return;
    }
    let line = lines[i++];
    try {
      const obj = JSON.parse(line);
      if (typeof obj.session_id === 'string') obj.session_id = sessionId;
      line = JSON.stringify(obj);
    } catch {
      /* replay as-is */
    }
    process.stdout.write(line + '\n');
    setTimeout(next, delay);
  };
  next();
});
