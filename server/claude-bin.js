'use strict';

// Locates the Claude Code executable (contract section 4) without ever using a shell.
//
// Resolution order:
//   1. env CLAUDE_BIN (a .js/.mjs/.cjs file is run with the current Node binary,
//      a .cmd/.bat npm shim is unwrapped to its real target).
//   2. win32: every PATH directory, looking for claude.exe, then claude.cmd whose
//      content points at ...\claude.exe or cli.js (%dp0% resolved to the shim dir).
//      other OSes: an executable named "claude" in PATH.
//   3. A few well-known install locations (native installer, npm global prefix).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const JS_EXT = /\.(c|m)?js$/i;
const SHIM_EXT = /\.(cmd|bat)$/i;

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutable(p) {
  if (!isFile(p)) return false;
  if (process.platform === 'win32') return true;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Builds the spawn descriptor for a concrete target file. */
function describe(target) {
  const full = path.resolve(target);
  if (JS_EXT.test(full)) {
    return { command: process.execPath, prefixArgs: [full], path: full };
  }
  return { command: full, prefixArgs: [], path: full };
}

/**
 * Reads an npm-style .cmd shim and returns the real target it launches
 * (claude.exe or cli.js), or null when it cannot be determined.
 */
function parseCmdShim(shimPath) {
  let content;
  try {
    content = fs.readFileSync(shimPath, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(shimPath);
  const candidates = [];
  const quoted = /"([^"\r\n]*?(?:claude\.exe|cli\.js))"/gi;
  let m;
  while ((m = quoted.exec(content)) !== null) candidates.push(m[1]);
  if (candidates.length === 0) {
    const bare = /([^\s"]*?(?:claude\.exe|cli\.js))(?=\s|$)/gim;
    while ((m = bare.exec(content)) !== null) candidates.push(m[1]);
  }
  for (const raw of candidates) {
    const replaced = raw
      .replace(/%~dp0%?/gi, dir + path.sep)
      .replace(/%dp0%/gi, dir + path.sep)
      .replace(/%~?dp0/gi, dir + path.sep);
    if (/%[^%]+%/.test(replaced)) continue; // still references an unknown variable
    const resolved = path.isAbsolute(replaced) ? path.normalize(replaced) : path.resolve(dir, replaced);
    if (isFile(resolved)) return resolved;
  }
  return null;
}

function pathDirs(env) {
  const raw = env.PATH || env.Path || env.path || '';
  return raw
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function fromExplicit(file) {
  if (!isFile(file)) return null;
  if (SHIM_EXT.test(file)) {
    const target = parseCmdShim(file);
    return target ? describe(target) : null;
  }
  return describe(file);
}

function scanWindows(env) {
  for (const dir of pathDirs(env)) {
    const exe = path.join(dir, 'claude.exe');
    if (isFile(exe)) return describe(exe);
    const shim = path.join(dir, 'claude.cmd');
    if (isFile(shim)) {
      const target = parseCmdShim(shim);
      if (target) return describe(target);
    }
  }
  const home = os.homedir();
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const known = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
  ];
  for (const k of known) if (isFile(k)) return describe(k);
  const shim = path.join(appData, 'npm', 'claude.cmd');
  if (isFile(shim)) {
    const target = parseCmdShim(shim);
    if (target) return describe(target);
  }
  return null;
}

function scanPosix(env) {
  for (const dir of pathDirs(env)) {
    const candidate = path.join(dir, 'claude');
    if (isExecutable(candidate)) return describe(candidate);
  }
  const home = os.homedir();
  const known = [
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.claude', 'local', 'claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const k of known) if (isExecutable(k)) return describe(k);
  return null;
}

/**
 * Resolves the Claude Code binary.
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, onWarning?: (msg: string) => void}} [opts]
 * @returns {{command: string, prefixArgs: string[], path: string} | null}
 */
function resolveClaude(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const explicit = (env.CLAUDE_BIN || '').trim().replace(/^"(.*)"$/, '$1');
  if (explicit) {
    const found = fromExplicit(path.resolve(explicit));
    if (found) return found;
    if (typeof opts.onWarning === 'function') {
      opts.onWarning(`CLAUDE_BIN pointe vers « ${explicit} », introuvable ou inutilisable : recherche dans le PATH.`);
    }
  }
  return platform === 'win32' ? scanWindows(env) : scanPosix(env);
}

/**
 * Runs `<claude> --version` and resolves with the trimmed first line, or null.
 * @param {{command: string, prefixArgs: string[]} | null} resolved
 * @param {number} [timeoutMs]
 * @returns {Promise<string|null>}
 */
function getVersion(resolved, timeoutMs = 15000) {
  if (!resolved) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(
        resolved.command,
        [...resolved.prefixArgs, '--version'],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve(null);
          const line = String(stdout || '').trim().split(/\r?\n/)[0] || '';
          resolve(line || null);
        }
      );
    } catch {
      resolve(null);
    }
  });
}

module.exports = { resolveClaude, getVersion, parseCmdShim };
