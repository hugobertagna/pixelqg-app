#!/usr/bin/env node
'use strict';

// The `claude` command of a PixelQG terminal (docs/TERMINAL.md section 3).
//
// server/shim is first in the PATH of every HQ terminal, so typing `claude …` there runs this
// script (through server/shim/claude.cmd or the terminal's doskey macro). It links the interactive
// session to an agent of the office, runs the real Claude Code on the same console, reports its
// pid, then reports its exit. Linking problems never block Claude Code itself.
//
// Environment set by server/terminals.js:
//   PIXELQG_URL, PIXELQG_TOKEN, PIXELQG_TERMINAL   where and how to link
//   PIXELQG_REAL_CLAUDE (+ PIXELQG_REAL_PREFIX)     the real binary (a .js file runs with node)
//   PIXELQG_PLUGIN_DIR                                skills library folder (docs/LIBRARY.md §5):
//                                                       --plugin-dir is added when it holds a plugin
// Without them (shim used outside PixelQG) it simply runs the real claude found in PATH.

const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveClaude, parseCmdShim } = require('./claude-bin');

const LINK_TIMEOUT_MS = 2000;
const UNLINK_TIMEOUT_MS = 1000;
const PASSTHROUGH_FLAGS = new Set(['-p', '--print', '-v', '--version', '-h', '--help']);
const SUBCOMMANDS = new Set([
  'mcp', 'config', 'update', 'upgrade', 'doctor', 'install', 'plugin', 'plugins', 'agents',
  'setup-token', 'migrate-installer', 'auth', 'login', 'logout',
]);
const NO_PLUGIN_FLAGS = new Set(['-v', '--version', '-h', '--help']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_RE = /^[0-9a-zA-Z][0-9a-zA-Z_-]{7,127}$/;
const JS_EXT = /\.(c|m)?js$/i;
const SHIM_EXT = /\.(cmd|bat)$/i;

/** One-shot runs (print mode, version, help, subcommands) are not sessions: no linking. */
function isPassThrough(args) {
  if (args.length && SUBCOMMANDS.has(args[0])) return true;
  for (const a of args) {
    if (a === '--') break;
    if (PASSTHROUGH_FLAGS.has(a) || a.startsWith('--print=')) return true;
  }
  return false;
}

/**
 * Works out the session id of an interactive run and the final arguments.
 * --session-id X -> X · --resume <uuid> -> that id · --continue / bare --resume (picker) -> null ·
 * otherwise a fresh uuid is generated and passed with --session-id (also when forking a resumed session).
 * @returns {{sessionId: string|null, args: string[], name: string|null}}
 */
function planSession(args) {
  let explicit = null;
  let resume; // undefined: not resuming · null: picker / search term · string: session id
  let continued = false;
  let fork = false;
  let name = null;
  let profile = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const value = () => (inline !== undefined ? inline : i + 1 < args.length ? args[++i] : undefined);
    const optionalValue = () => {
      if (inline !== undefined) return inline;
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) return args[++i];
      return undefined;
    };
    switch (flag) {
      case '--session-id': {
        const v = value();
        if (typeof v === 'string' && v) explicit = v;
        break;
      }
      case '-r':
      case '--resume': {
        const v = optionalValue();
        resume = typeof v === 'string' && UUID_RE.test(v) ? v : null;
        break;
      }
      case '-c':
      case '--continue':
        continued = true;
        break;
      case '--fork-session':
        fork = true;
        break;
      case '-n':
      case '--name': {
        const v = value();
        if (typeof v === 'string') name = v;
        break;
      }
      case '--agent': {
        const v = value();
        if (typeof v === 'string' && v) profile = v;
        break;
      }
      default:
        break;
    }
  }
  const out = args.slice();
  let sessionId = null;
  if (explicit) {
    sessionId = SESSION_RE.test(explicit) ? explicit : null;
  } else if (fork && (resume !== undefined || continued)) {
    sessionId = crypto.randomUUID();
    out.push('--session-id', sessionId);
  } else if (typeof resume === 'string') {
    sessionId = resume;
  } else if (resume === null || continued) {
    sessionId = null; // found later by the transcript watcher
  } else {
    sessionId = crypto.randomUUID();
    out.push('--session-id', sessionId);
  }
  return { sessionId, args: out, name, profile };
}

/** The library folder when it holds at least one plugin (<dir>/<name>/.claude-plugin/plugin.json), else null. */
function libraryPluginDir(env = process.env) {
  const dir = String(env.PIXELQG_PLUGIN_DIR || '').trim();
  if (!dir || !path.isAbsolute(dir)) return null;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, '.claude-plugin', 'plugin.json'))) return dir;
    }
  } catch {
    /* no library yet */
  }
  return null;
}

/**
 * Appends --plugin-dir <dir> (before a "--", if any) unless the user passed --plugin-dir, or the
 * run is --version / --help / a subcommand. Print-mode (-p) runs get it too.
 */
function withPluginDir(args, dir) {
  if (!dir) return args;
  if (args.length && SUBCOMMANDS.has(args[0])) return args;
  let end = args.indexOf('--');
  if (end < 0) end = args.length;
  for (let i = 0; i < end; i++) {
    const a = args[i];
    if (NO_PLUGIN_FLAGS.has(a) || a === '--plugin-dir' || a.startsWith('--plugin-dir=')) return args;
  }
  return [...args.slice(0, end), '--plugin-dir', dir, ...args.slice(end)];
}

function sameDir(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** The real Claude Code binary: { command, prefixArgs } or null. */
function realClaude(env = process.env) {
  const configured = (env.PIXELQG_REAL_CLAUDE || '').trim();
  if (configured) {
    let prefix = [];
    try {
      prefix = JSON.parse(env.PIXELQG_REAL_PREFIX || '[]');
    } catch {
      prefix = [];
    }
    if (!Array.isArray(prefix) || !prefix.every((s) => typeof s === 'string')) prefix = [];
    if (JS_EXT.test(configured)) return { command: process.execPath, prefixArgs: [configured, ...prefix] };
    if (SHIM_EXT.test(configured)) {
      const target = parseCmdShim(configured);
      if (!target) return null;
      return JS_EXT.test(target) ? { command: process.execPath, prefixArgs: [target] } : { command: target, prefixArgs: [] };
    }
    return { command: configured, prefixArgs: prefix };
  }
  // Outside PixelQG: the real claude from PATH, this shim's own directory excluded.
  const own = path.join(__dirname, 'shim');
  const pathKey = Object.keys(env).find((k) => /^path$/i.test(k)) || 'PATH';
  const dirs = String(env[pathKey] || '')
    .split(path.delimiter)
    .filter((d) => {
      const clean = d.trim().replace(/^"(.*)"$/, '$1');
      return clean && !sameDir(clean, own);
    });
  const cleanEnv = { ...env };
  delete cleanEnv[pathKey];
  cleanEnv.PATH = dirs.join(path.delimiter);
  const found = resolveClaude({ env: cleanEnv });
  return found ? { command: found.command, prefixArgs: found.prefixArgs } : null;
}

/** POSTs JSON to the HQ server; resolves { status, json } or null (never rejects). */
function post(pathname, body, timeoutMs, env = process.env) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(pathname, env.PIXELQG_URL);
    } catch {
      resolve(null);
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      agent: false,
      headers: {
        Host: url.host,
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        'X-HQ-Token': env.PIXELQG_TOKEN || '',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          json = null;
        }
        done({ status: res.statusCode, json });
      });
      res.on('error', () => done(null));
    });
    const timer = setTimeout(() => {
      req.destroy();
      done(null);
    }, timeoutMs);
    req.on('error', () => done(null));
    req.end(payload);
  });
}

function dim(text) {
  return `\x1b[2m${text}\x1b[0m\r\n`;
}

/**
 * Runs the real claude on this console and resolves with its exit code. While it runs, Ctrl+C /
 * Ctrl+Break are left to Claude Code (the shim must survive them to report the exit).
 */
function runClaude(real, args, onSpawn) {
  return new Promise((resolve) => {
    const ignore = () => {};
    process.on('SIGINT', ignore);
    process.on('SIGBREAK', ignore);
    let child;
    try {
      child = spawn(real.command, [...real.prefixArgs, ...args], { stdio: 'inherit', windowsHide: false });
    } catch (err) {
      process.stderr.write(`Impossible de lancer Claude Code : ${err && err.message ? err.message : err}\r\n`);
      resolve(1);
      return;
    }
    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      resolve(code);
    };
    child.on('error', (err) => {
      process.stderr.write(`Impossible de lancer Claude Code : ${err.code === 'ENOENT' ? `exécutable introuvable (${real.command})` : err.message}\r\n`);
      finish(1);
    });
    child.on('exit', (code, signal) => finish(typeof code === 'number' ? code : signal ? 1 : 0));
    if (child.pid && onSpawn) onSpawn(child.pid);
  });
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const real = realClaude(env);
  if (!real) {
    process.stderr.write('Claude Code est introuvable : installe-le (npm install -g @anthropic-ai/claude-code) ou définis la variable CLAUDE_BIN.\r\n');
    return 1;
  }
  const inHq = Boolean(env.PIXELQG_URL && env.PIXELQG_TOKEN && env.PIXELQG_TERMINAL);
  const pluginDir = libraryPluginDir(env);
  if (!inHq || isPassThrough(argv)) return runClaude(real, withPluginDir(argv, pluginDir), null);

  const plan = planSession(argv);
  const base = `/api/terminals/${encodeURIComponent(env.PIXELQG_TERMINAL)}`;
  const res = await post(`${base}/link`, {
    sessionId: plan.sessionId,
    cwd: process.cwd(),
    pid: process.pid,
    name: plan.name,
    profile: plan.profile,
    args: argv.join(' ').slice(0, 300),
  }, LINK_TIMEOUT_MS, env);
  const linkId = res && res.status === 200 && res.json && res.json.ok && typeof res.json.linkId === 'string' ? res.json.linkId : null;
  if (!linkId) process.stderr.write(dim('PixelQG : liaison impossible, la session tourne quand même.'));

  let reported = Promise.resolve();
  const code = await runClaude(real, withPluginDir(plan.args, pluginDir), (childPid) => {
    if (linkId) reported = post(`${base}/link`, { linkId, childPid }, LINK_TIMEOUT_MS, env);
  });
  if (linkId) {
    await reported;
    await post(`${base}/unlink`, { linkId, exitCode: code }, UNLINK_TIMEOUT_MS, env);
  }
  return code;
}

// Terminals opened before the rename to PixelQG still carry CLAUDE_HQ_* variables: accept them.
for (const key of Object.keys(process.env)) {
  if (key.toUpperCase().startsWith('CLAUDE_HQ_')) {
    const next = 'PIXELQG_' + key.slice('CLAUDE_HQ_'.length).toUpperCase();
    if (process.env[next] === undefined) process.env[next] = process.env[key];
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`PixelQG : erreur inattendue du lanceur (${err && err.message ? err.message : err}).\r\n`);
      process.exit(1);
    }
  );
}

module.exports = { planSession, isPassThrough, realClaude, libraryPluginDir, withPluginDir, main };
