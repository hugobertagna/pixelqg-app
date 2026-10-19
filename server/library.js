'use strict';

/*
 * PixelQG skills & agents library (docs/LIBRARY.md §2-§5).
 *
 * Links public GitHub repositories of Claude Code skills / agents / commands: clones them (depth 1,
 * hidden git, never prompting), scans what they contain, and generates one "wrapper" plugin per
 * enabled repo under <HQ_HOME>/library. Every claude process HQ spawns then gets
 * `--plugin-dir <HQ_HOME>/library` (see pluginDirArgs()). Hooks, MCP / LSP servers and output styles
 * are never copied into a wrapper. The user's global Claude Code configuration is never touched.
 *
 * Module shape: { Library, parseRepoInput, scanRepo, parseFrontmatter, normalizeName }.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const IS_WIN = process.platform === 'win32';

// ---------------------------------------------------------------------------------------------
// Limits & constants

const MAX_INPUT_LENGTH = 500;
const MAX_SUBPATH_SEGMENTS = 10;
const MAX_SCAN_DEPTH = 10;
const MAX_SCAN_ENTRIES = 20000;
const MAX_PARSE_BYTES = 1024 * 1024;
const MAX_ITEMS = 500;
const MAX_SKILL_BYTES = 20 * 1024 * 1024;
const MAX_SKILL_FILES = 5000;
const MAX_DESCRIPTION = 300;
const FIRST_PARAGRAPH_MAX = 200;
const MAX_FRONTMATTER_LINES = 2000;
const MAX_YAML_DEPTH = 6;
const MAX_OUTPUT = 256 * 1024;
const DEFAULT_MAX_CLONE_BYTES = 300 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT = 180000;
const DEFAULT_VALIDATE_TIMEOUT = 30000;
const DEFAULT_MAX_REPOS = 30;
const MANY_ENABLED_ITEMS = 50;
const MAX_REPO_WARNINGS = 30;
const MAX_VALIDATION_WARNINGS = 5;
const BUILD_VERSION = 1;
const WRAPPER_SIGNATURE = '(lié par PixelQG)';

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SUBPATH_SEGMENT_RE = /^[A-Za-z0-9._ -]{1,100}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PLUGIN_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const COMMIT_RE = /^[0-9a-f]{4,64}$/;
const RAND_RE = '[0-9a-f]{10}';

const ITEM_TYPES = ['skill', 'agent', 'command'];
const TYPE_LABEL = { skill: 'Skill', agent: 'Agent', command: 'Commande' };
const TYPE_DIR = { skill: 'skills', agent: 'agents', command: 'commands' };
const STATUSES = new Set(['cloning', 'updating', 'ready', 'error']);
const KINDS = new Set(['plugin', 'marketplace', 'loose']);
const SKIP_DIRS = new Set(['.git', 'node_modules']);
const IGNORED_DOCS = new Set(['readme', 'changelog', 'license', 'licence', 'contributing', 'claude', 'agents', 'code_of_conduct', 'security']);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const MSG = {
  invalid: 'Lien GitHub invalide. Exemple : anthropics/skills ou https://github.com/anthropics/skills',
  duplicate: 'Ce dépôt est déjà lié.',
  noGit: "Git n'est pas installé. Installe-le depuis https://git-scm.com",
  notFound: 'Dépôt introuvable ou privé (seuls les dépôts publics sont pris en charge)',
  unknownRepo: 'Dépôt inconnu : il a peut-être déjà été retiré.',
  unknownItem: 'Élément inconnu dans ce dépôt.',
  busy: 'Une opération est déjà en cours sur ce dépôt : attends quelques secondes.',
  badEnabled: 'Le champ « enabled » doit valoir true ou false.',
  tooMany: (n) => `Tu as déjà lié ${n} dépôts : retires-en un avant d'en ajouter un autre.`,
  closed: "La bibliothèque est en cours d'arrêt.",
  notReady: "La bibliothèque n'est pas encore prête.",
  tooBig: 'Dépôt trop volumineux (plus de 300 Mo) : il a été supprimé.',
  timeout: 'Git a mis trop de temps à répondre (plus de 3 minutes) : opération annulée.',
  network: 'Impossible de joindre GitHub : vérifie ta connexion internet.',
  branch: (b) => `Branche « ${b} » introuvable dans ce dépôt.`,
  subpath: (p) => `Le dossier « ${p} » est introuvable dans ce dépôt.`,
  cloneMissing: 'Le clone local a disparu : clique sur « Mettre à jour » pour le récupérer.',
  interrupted: "L'opération a été interrompue (PixelQG s'est arrêté). Clique sur « Mettre à jour » pour réessayer.",
  updateFailed: (m) => `La dernière mise à jour a échoué : ${m}`,
  hooks: 'Ce dépôt contient des hooks (commandes automatiques) : ignorés pour ta sécurité.',
  mcp: 'Ce dépôt contient des serveurs MCP : ignorés pour ta sécurité.',
  lsp: 'Ce dépôt contient des serveurs LSP ou des styles de sortie : non chargés.',
  external: (n) => `Ce catalogue référence ${n} plugin(s) hébergé(s) ailleurs : non chargé(s).`,
  capItems: `Plus de ${MAX_ITEMS} éléments trouvés : seuls les ${MAX_ITEMS} premiers sont gardés.`,
  capEntries: 'Dépôt très volumineux : analyse arrêtée après 20 000 fichiers.',
  tooDeep: "Certains dossiers trop profonds (plus de 10 niveaux) n'ont pas été analysés.",
  bigFiles: (n) => `${n} fichier(s) Markdown de plus de 1 Mo ignoré(s).`,
  symlinks: (n) => `${n} lien(s) symbolique(s) ignoré(s) pour ta sécurité.`,
  empty: 'Aucun skill, agent ni commande trouvé dans ce dépôt.',
  noDir: 'Dossier introuvable dans ce dépôt.',
  manyItems: (n) => `${n} éléments activés : chaque skill et agent ajoute sa description au contexte de Claude. Désactive ceux dont tu n'as pas besoin.`,
  pluginRefused: (m) => `Le plugin généré est refusé par Claude Code : ${m}`,
  fileRefused: (m) => `Claude Code refuse ce fichier : ${m}`,
  buildFailed: (m) => `Impossible de préparer le plugin : ${m}`,
  validationWarning: (f, m) => `Claude Code signale (${f}) : ${m}`,
  moreValidationWarnings: (n) => `… et ${n} autre(s) avertissement(s) de Claude Code.`,
};

// ---------------------------------------------------------------------------------------------
// Generic helpers

function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function userError(message) {
  const err = new Error(message);
  err.userMessage = message;
  return err;
}

function abortedError() {
  const err = new Error('aborted');
  err.code = 'ABORTED';
  return err;
}

function clip(s, n) {
  const str = String(s);
  return str.length > n ? `${str.slice(0, n - 1).trimEnd()}…` : str;
}

function randomSuffix() {
  return crypto.randomBytes(5).toString('hex');
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* ignore */
  }
}

function lstatSafe(p) {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

function isRealDir(p) {
  const st = lstatSafe(p);
  return !!st && st.isDirectory();
}

function isRealFile(p) {
  const st = lstatSafe(p);
  return !!st && st.isFile();
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function readJsonSafe(file, maxBytes = MAX_PARSE_BYTES) {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > maxBytes) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function hasOwn(obj, key) {
  return !!obj && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key);
}

/** Recursive delete that never throws (retries EBUSY/EPERM on Windows); resolves true when gone. */
async function rmrf(p) {
  try {
    await fsp.rm(p, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    return true;
  } catch {
    return !lstatSafe(p);
  }
}

async function renameRetry(from, to, attempts = 10) {
  for (let i = 0; ; i += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (i >= attempts || !['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) throw err;
      await sleep(40 * (i + 1));
    }
  }
}

/**
 * Resolves a "/"-separated relative path inside root without ever crossing a symlink / junction.
 * Returns the absolute path or null.
 */
function resolveInside(root, rel) {
  if (rel === '.' || rel === '') return root;
  if (typeof rel !== 'string' || rel.length > 2000 || /[\\:\0]/.test(rel) || rel.startsWith('/')) return null;
  const segs = rel.split('/');
  if (segs.some((s) => !s || s === '.' || s === '..')) return null;
  let cur = root;
  for (const s of segs) {
    cur = path.join(cur, s);
    const st = lstatSafe(cur);
    if (!st || st.isSymbolicLink()) return null;
  }
  const check = path.relative(root, cur);
  if (!check || check.startsWith('..') || path.isAbsolute(check)) return null;
  return cur;
}

/** Normalises a relative path found in a manifest ("./plugins/x/") to "plugins/x"; null when unsafe. */
function normRel(p) {
  if (typeof p !== 'string' || p.length > 500) return null;
  const s = p.trim().replace(/\\/g, '/');
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) || s.startsWith('/')) return null;
  const segs = s.split('/').filter((x) => x !== '' && x !== '.');
  if (segs.some((x) => x === '..')) return null;
  return segs.join('/');
}

function joinRel(a, b) {
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

// ---------------------------------------------------------------------------------------------
// Names

/**
 * Normalises a skill / agent / command name to ^[a-z0-9][a-z0-9-]{0,63}$ (lowercase, accents
 * stripped, every other run of characters becomes "-"). Returns null when nothing usable is left.
 * @param {unknown} s
 * @returns {string|null}
 */
function normalizeName(s) {
  if (typeof s !== 'string') return null;
  let n = s
    .slice(0, 1000)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  if (n.length > 64) n = n.slice(0, 64).replace(/-+$/, '');
  return NAME_RE.test(n) ? n : null;
}

// Claude Code (verified on 2.1.302) refuses third-party plugin names that start with "claude-",
// "anthropic-", "anthropics-" or "cc-plugin-", equal "claude", "anthropic", "anthropics",
// "claude-code", "claude-mods", or put "official" beside "claude"/"anthropic"; any "claude" /
// "anthropic(s)" segment only draws a warning. Wrapper names therefore drop those segments.
const BRAND_SEGMENTS = new Set(['claude', 'anthropic', 'anthropics']);

function isAllowedPluginName(n) {
  if (typeof n !== 'string' || !PLUGIN_RE.test(n) || n.endsWith('-')) return false;
  if (/^cc-plugin-/.test(n)) return false;
  return !n.split('-').some((s) => BRAND_SEGMENTS.has(s));
}

function makePluginName(owner, repo) {
  let n = `${owner}-${repo}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter((s) => s && !BRAND_SEGMENTS.has(s))
    .join('-');
  if (/^cc-plugin(-|$)/.test(n)) n = `hq-${n}`;
  if (n.length > 40) n = n.slice(0, 40).replace(/-+$/, '');
  return isAllowedPluginName(n) ? n : 'depot';
}

function withSuffix(base, n, max) {
  const suffix = `-${n}`;
  return `${base.slice(0, max - suffix.length).replace(/-+$/, '')}${suffix}`;
}

function uniqueName(base, used, max = 64) {
  let name = base;
  for (let n = 2; used.has(name); n += 1) name = withSuffix(base, n, max);
  used.add(name);
  return name;
}

// ---------------------------------------------------------------------------------------------
// Repository input (§3)

function invalidInput() {
  return httpError(400, MSG.invalid, 'INVALID_REPO');
}

function decodeSegment(seg) {
  if (!seg.includes('%')) return seg;
  try {
    return decodeURIComponent(seg);
  } catch {
    throw invalidInput();
  }
}

function validBranch(b) {
  return (
    typeof b === 'string' &&
    BRANCH_RE.test(b) &&
    !b.startsWith('-') &&
    !b.startsWith('.') &&
    !b.endsWith('.') &&
    !b.includes('..') &&
    !/\.lock$/i.test(b) &&
    b !== 'HEAD'
  );
}

function validRepoName(r) {
  return typeof r === 'string' && REPO_RE.test(r) && r !== '.' && r !== '..' && !r.startsWith('-') && !r.endsWith('.');
}

function validSubpathSegment(s) {
  return (
    typeof s === 'string' &&
    SUBPATH_SEGMENT_RE.test(s) &&
    !s.includes('..') &&
    s === s.trim() &&
    !s.endsWith('.')
  );
}

function makeId(owner, repo, branch, subpath) {
  let id = `${owner}__${repo}`.toLowerCase();
  if (branch) id += `__${branch.toLowerCase()}`;
  if (subpath) id += `__${subpath.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
  if (id.length > 100) id = `${id.slice(0, 90).replace(/[._-]+$/, '')}-${sha1(id).slice(0, 8)}`;
  return id;
}

/**
 * Parses what the user typed in « Lien GitHub ».
 * Accepted: owner/repo, https://github.com/owner/repo[.git][/tree/<branch>[/<subpath…>]],
 * git@github.com:owner/repo[.git] (http://, www. and a trailing ?query / #fragment are tolerated).
 * @param {string} input
 * @returns {{owner: string, repo: string, branch: string|null, subpath: string|null, url: string, id: string, plugin: string}}
 * @throws {Error} status 400 with the French message of §3.
 */
function parseRepoInput(input) {
  if (typeof input !== 'string') throw invalidInput();
  const s = input.trim();
  if (!s || s.length > MAX_INPUT_LENGTH) throw invalidInput();
  if (/[\u0000-\u001f\u007f\\]/.test(s)) throw invalidInput();

  let owner;
  let repo;
  let branch = null;
  let subSegs = [];
  let m;
  if ((m = /^git@github\.com:([^/]+)\/([^/]+?)\/?$/i.exec(s))) {
    owner = m[1];
    repo = m[2];
  } else if ((m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.*)$/i.exec(s))) {
    let rest = m[1].replace(/[?#].*$/, '');
    if (rest.endsWith('/')) rest = rest.slice(0, -1);
    const segs = rest.split('/');
    if (segs.length < 2 || segs.some((x) => x === '')) throw invalidInput();
    owner = decodeSegment(segs[0]);
    repo = decodeSegment(segs[1]);
    if (segs.length > 2) {
      if (segs[2] !== 'tree' || segs.length < 4) throw invalidInput();
      branch = decodeSegment(segs[3]);
      subSegs = segs.slice(4).map(decodeSegment);
    }
  } else if ((m = /^([^/:@\s]+)\/([^/:@\s]+?)\/?$/.exec(s))) {
    owner = m[1];
    repo = m[2];
  } else {
    throw invalidInput();
  }

  if (/\.git$/i.test(repo)) repo = repo.slice(0, -4);
  if (!OWNER_RE.test(owner) || !validRepoName(repo)) throw invalidInput();
  if (branch !== null && !validBranch(branch)) throw invalidInput();
  if (subSegs.length > MAX_SUBPATH_SEGMENTS || !subSegs.every(validSubpathSegment)) throw invalidInput();
  const subpath = subSegs.length ? subSegs.join('/') : null;

  let url = `https://github.com/${owner}/${repo}`;
  if (branch) {
    url += `/tree/${branch}`;
    if (subpath) url += `/${subSegs.map(encodeURIComponent).join('/')}`;
  }
  return { owner, repo, branch, subpath, url, id: makeId(owner, repo, branch, subpath), plugin: makePluginName(owner, repo) };
}

// ---------------------------------------------------------------------------------------------
// Frontmatter: tolerant mini YAML reader (key: value, quoted strings, |/> block scalars,
// [a, b] flow lists, "- item" block lists, one-level nested maps). Never throws.

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[A-Za-z0-9_$][^:#]*?)[ \t]*:(?:[ \t]+(.*?))?[ \t]*$/;

function splitFrontmatter(text) {
  let s = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  if (/^---[ \t]*$/.test(lines[0])) {
    const limit = Math.min(lines.length, MAX_FRONTMATTER_LINES + 1);
    for (let i = 1; i < limit; i += 1) {
      if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) {
        return { found: true, fmLines: lines.slice(1, i), body: lines.slice(i + 1).join('\n') };
      }
    }
  }
  return { found: false, fmLines: null, body: s };
}

function indentOf(line) {
  return /^[ \t]*/.exec(line)[0].length;
}

function isSkippable(line) {
  const t = line.trim();
  return t === '' || t.startsWith('#');
}

function stripComment(s) {
  const m = /(^|[ \t])#/.exec(s);
  return (m ? s.slice(0, m.index) : s).trim();
}

function unquoteKey(k) {
  if (k.startsWith('"')) return parseQuotedText(k, '"').value;
  if (k.startsWith("'")) return k.slice(1, -1).replace(/''/g, "'");
  return k.trim();
}

const DQ_ESCAPES = {
  0: '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b',
  ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\x85', _: '\xa0', L: '\u2028', P: '\u2029',
};

/** Parses a quoted scalar starting at s[0]; returns { value, closed }. */
function parseQuotedText(s, quote) {
  let out = '';
  for (let k = 1; k < s.length; k += 1) {
    const ch = s[k];
    if (quote === "'") {
      if (ch === "'") {
        if (s[k + 1] === "'") {
          out += "'";
          k += 1;
          continue;
        }
        return { value: out, closed: true };
      }
      out += ch;
      continue;
    }
    if (ch === '"') return { value: out, closed: true };
    if (ch === '\\' && k + 1 < s.length) {
      const e = s[k + 1];
      const hexLen = e === 'x' ? 2 : e === 'u' ? 4 : e === 'U' ? 8 : 0;
      if (hexLen) {
        const hex = s.slice(k + 2, k + 2 + hexLen);
        const code = /^[0-9a-fA-F]+$/.test(hex) && hex.length === hexLen ? parseInt(hex, 16) : NaN;
        if (Number.isFinite(code) && code <= 0x10ffff) {
          out += String.fromCodePoint(code);
          k += 1 + hexLen;
          continue;
        }
      }
      out += hasOwn(DQ_ESCAPES, e) ? DQ_ESCAPES[e] : e;
      k += 1;
      continue;
    }
    out += ch;
  }
  return { value: out, closed: false };
}

function parseQuoted(ctx, first, indent) {
  const quote = first[0];
  let text = first;
  let res = parseQuotedText(text, quote);
  let guard = 0;
  // Multi-line quoted scalar: only continue on blank or more-indented lines.
  while (!res.closed && ctx.i < ctx.lines.length && guard < 200) {
    const next = ctx.lines[ctx.i];
    if (next.trim() !== '' && indentOf(next) <= indent) break;
    ctx.i += 1;
    guard += 1;
    text = next.trim() === '' ? `${text}\n` : `${text.replace(/[ \t]+$/, '')}${text.endsWith('\n') ? '' : ' '}${next.trim()}`;
    res = parseQuotedText(text, quote);
  }
  return res.closed ? res.value : res.value.trim();
}

/** Accumulates a flow collection ([...] or {...}) possibly spanning lines; returns raw text or null. */
function collectFlow(ctx, first, indent) {
  let text = first;
  let guard = 0;
  for (;;) {
    const state = flowState(text);
    if (state.depth === 0 && state.closedAt >= 0) return { text, end: state.closedAt };
    if (ctx.i >= ctx.lines.length || guard > 200) return null;
    const next = ctx.lines[ctx.i];
    if (next.trim() !== '' && indentOf(next) <= indent) return null;
    ctx.i += 1;
    guard += 1;
    text = `${text} ${next.trim()}`;
  }
}

function flowState(text) {
  let depth = 0;
  let quote = null;
  for (let k = 0; k < text.length; k += 1) {
    const ch = text[k];
    if (quote) {
      if (ch === '\\' && quote === '"') k += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return { depth, closedAt: k };
      if (depth < 0) return { depth: -1, closedAt: -1 };
    }
  }
  return { depth, closedAt: -1 };
}

function splitFlowItems(inner) {
  const items = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let k = 0; k < inner.length; k += 1) {
    const ch = inner[k];
    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && k + 1 < inner.length) {
        cur += inner[k + 1];
        k += 1;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      items.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  items.push(cur);
  return items
    .map((x) => x.trim())
    .filter((x) => x !== '')
    .map((x) => (x[0] === '"' || x[0] === "'" ? parseQuotedText(x, x[0]).value : x));
}

function parseBlockScalar(ctx, header, indent) {
  const hm = /^([|>])([1-9])?([+-])?([1-9])?[ \t]*(?:#.*)?$/.exec(header);
  if (!hm) return stripComment(header);
  const folded = hm[1] === '>';
  const chomp = hm[3] || '';
  const explicit = hm[2] || hm[4];
  let blockIndent = explicit ? indent + Number(explicit) : -1;
  const raw = [];
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i];
    if (line.trim() === '') {
      raw.push('');
      ctx.i += 1;
      continue;
    }
    const ind = indentOf(line);
    if (blockIndent < 0) {
      if (ind <= indent) break;
      blockIndent = ind;
    }
    if (ind < blockIndent) break;
    raw.push(line.slice(blockIndent));
    ctx.i += 1;
  }
  let end = raw.length;
  while (end > 0 && raw[end - 1] === '') end -= 1;
  const content = raw.slice(0, end);
  const trailing = raw.length - end;
  let text;
  if (!folded) {
    text = content.join('\n');
  } else {
    text = '';
    for (let k = 0; k < content.length; k += 1) {
      const l = content[k];
      if (k === 0) {
        text = l;
        continue;
      }
      const prev = content[k - 1];
      if (l === '') text += '\n';
      else if (prev === '') text += l;
      else if (/^[ \t]/.test(l) || /^[ \t]/.test(prev)) text += `\n${l}`;
      else text += ` ${l}`;
    }
  }
  if (chomp === '-') return text;
  if (chomp === '+') return `${text}\n${'\n'.repeat(trailing)}`;
  return content.length ? `${text}\n` : '';
}

function nextContentIndex(ctx) {
  let j = ctx.i;
  while (j < ctx.lines.length && isSkippable(ctx.lines[j])) j += 1;
  return j;
}

function parseValue(ctx, rest, indent, depth) {
  const t = (rest || '').trim();
  if (t === '' || t.startsWith('#')) {
    const j = nextContentIndex(ctx);
    if (j >= ctx.lines.length) return '';
    const nl = ctx.lines[j];
    const nind = indentOf(nl);
    const nt = nl.slice(nind);
    if ((nt === '-' || nt.startsWith('- ')) && nind >= indent && depth < MAX_YAML_DEPTH) {
      ctx.i = j;
      return parseListAt(ctx, nind, depth + 1);
    }
    if (nind > indent) {
      if (KEY_RE.test(nt) && depth < MAX_YAML_DEPTH) {
        ctx.i = j;
        return parseMapAt(ctx, nind, depth + 1);
      }
      // Multi-line plain scalar starting on the next line.
      ctx.i = j;
      const parts = [];
      while (ctx.i < ctx.lines.length) {
        const l = ctx.lines[ctx.i];
        if (l.trim() === '' || indentOf(l) <= indent) break;
        parts.push(stripComment(l.trim()));
        ctx.i += 1;
      }
      return parts.join(' ').trim();
    }
    return '';
  }
  if (t[0] === '|' || t[0] === '>') return parseBlockScalar(ctx, t, indent);
  if (t[0] === '"' || t[0] === "'") return parseQuoted(ctx, t, indent);
  if (t[0] === '[' || t[0] === '{') {
    const save = ctx.i;
    const flow = collectFlow(ctx, t, indent);
    if (!flow) {
      ctx.i = save;
      return stripComment(t);
    }
    if (t[0] === '{') return flow.text.slice(0, flow.end + 1).trim();
    return splitFlowItems(flow.text.slice(1, flow.end));
  }
  // Plain scalar, possibly folded over more-indented continuation lines.
  let value = stripComment(t);
  while (ctx.i < ctx.lines.length) {
    const l = ctx.lines[ctx.i];
    if (l.trim() === '' || indentOf(l) <= indent || l.trim().startsWith('#')) break;
    value = `${value} ${stripComment(l.trim())}`.trim();
    ctx.i += 1;
  }
  return value;
}

function parseListAt(ctx, indent, depth) {
  const arr = [];
  while (ctx.i < ctx.lines.length && arr.length < 1000) {
    const line = ctx.lines[ctx.i];
    if (isSkippable(line)) {
      ctx.i += 1;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) {
      ctx.i += 1;
      continue;
    }
    const c = line.slice(ind);
    if (!(c === '-' || c.startsWith('- '))) break;
    ctx.i += 1;
    arr.push(parseValue(ctx, c === '-' ? '' : c.slice(2), ind, depth));
  }
  return arr;
}

function parseMapAt(ctx, indent, depth) {
  const obj = {};
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i];
    if (isSkippable(line)) {
      ctx.i += 1;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) {
      ctx.i += 1;
      continue;
    }
    const m = KEY_RE.exec(line.slice(ind));
    ctx.i += 1;
    if (!m) continue;
    const key = unquoteKey(m[1]);
    const value = parseValue(ctx, m[2] === undefined ? '' : m[2], indent, depth);
    if (key && !UNSAFE_KEYS.has(key)) obj[key] = value;
  }
  return obj;
}

function parseYamlLines(lines) {
  const ctx = { lines, i: 0 };
  const j = nextContentIndex(ctx);
  if (j >= lines.length) return {};
  ctx.i = j;
  return parseMapAt(ctx, indentOf(lines[j]), 0);
}

function readFrontmatter(text) {
  let parts;
  try {
    parts = splitFrontmatter(text);
  } catch {
    return { found: false, data: {}, body: typeof text === 'string' ? text : '' };
  }
  if (!parts.found) return { found: false, data: {}, body: parts.body };
  let data = {};
  try {
    data = parseYamlLines(parts.fmLines);
  } catch {
    data = {};
  }
  return { found: true, data, body: parts.body };
}

/**
 * Reads the YAML frontmatter of a Markdown file (tolerant, never throws). The body is returned with
 * the BOM removed and line endings normalised to "\n".
 * @param {string} text
 * @returns {{data: object, body: string}}
 */
function parseFrontmatter(text) {
  const { data, body } = readFrontmatter(text);
  return { data, body };
}

// ---------------------------------------------------------------------------------------------
// Markdown rewriting for the wrapper copies: force the normalised name, add a missing description,
// and quote the plain scalars a strict YAML parser would reject ("description: Use when: …").

function flowIsBalanced(text) {
  const st = flowState(text);
  if (st.closedAt < 0) return false;
  return stripComment(text.slice(st.closedAt + 1)) === '';
}

function needsQuoting(value, cont) {
  const first = value[0];
  if (first === '"' || first === "'" || first === '|' || first === '>' || first === '#') return false;
  if (first === '[' || first === '{') return !flowIsBalanced([value, ...cont.map((c) => c.trim())].join(' '));
  if ('*&!%@`'.includes(first)) return true;
  if (/^[-?:,](\s|$)/.test(value)) return true;
  if (/:(\s|$)/.test(value)) return true;
  return cont.some((c) => {
    const t = c.trim();
    return /:(\s|$)/.test(t) || /^[-?](\s|$)/.test(t) || t.startsWith('#');
  });
}

function prepareMarkdown(text, { name = null, description = '' } = {}) {
  let src = String(text || '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  let end = -1;
  if (/^---[ \t]*$/.test(lines[0])) {
    const limit = Math.min(lines.length, MAX_FRONTMATTER_LINES + 1);
    for (let i = 1; i < limit; i += 1) {
      if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    const head = [];
    if (name) head.push(`name: ${name}`);
    if (description) head.push(`description: ${JSON.stringify(description)}`);
    if (!head.length) return src;
    return `${['---', ...head, '---'].join(eol)}${eol}${src}`;
  }
  const fm = lines.slice(1, end);
  const out = [];
  let hasName = false;
  let hasDesc = false;
  for (let i = 0; i < fm.length; i += 1) {
    const line = fm[i];
    const m = /^([A-Za-z0-9_][\w.-]*)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const key = m[1];
    const value = (m[2] || '').trim();
    const cont = [];
    let j = i + 1;
    while (j < fm.length && /^[ \t]+\S/.test(fm[j])) {
      cont.push(fm[j]);
      j += 1;
    }
    if (key === 'name' && name) {
      hasName = true;
      out.push(`name: ${name}`);
      i = j - 1;
      continue;
    }
    if (key === 'description' && (value !== '' || cont.length > 0)) hasDesc = true;
    if (value && needsQuoting(value, cont)) {
      const folded = [value, ...cont.map((c) => c.trim())].join(' ');
      out.push(`${key}: ${JSON.stringify(folded)}`);
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  const extra = [];
  if (name && !hasName) extra.push(`name: ${name}`);
  if (description && !hasDesc) extra.push(`description: ${JSON.stringify(description)}`);
  return ['---', ...extra, ...out, ...lines.slice(end)].join(eol);
}

// ---------------------------------------------------------------------------------------------
// Scanning (§4) — pure fs read, never follows symlinks / junctions.

function firstParagraph(body) {
  const paras = String(body || '').split(/\n[ \t]*\n/);
  for (const p of paras) {
    const t = p.trim();
    if (!t) continue;
    if (/^(#|<!--|```|~~~|---|\||!\[|<[a-zA-Z/])/.test(t)) continue;
    return clip(t.replace(/\s+/g, ' '), FIRST_PARAGRAPH_MAX);
  }
  return '';
}

function asText(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function describeItem(data, body) {
  let d = data ? data.description : undefined;
  if (Array.isArray(d)) d = d.filter((x) => typeof x === 'string').join(' ');
  if (typeof d === 'string' && d.trim()) return clip(d.replace(/\s+/g, ' ').trim(), MAX_DESCRIPTION);
  return firstParagraph(body);
}

function toolsOf(data) {
  let t = hasOwn(data, 'tools') ? data.tools : hasOwn(data, 'allowed-tools') ? data['allowed-tools'] : null;
  if (Array.isArray(t)) t = t.filter((x) => typeof x === 'string' && x.trim()).join(', ');
  if (typeof t !== 'string' || !t.trim()) return null;
  return clip(t.replace(/\s+/g, ' ').trim(), 200);
}

function modelOf(data) {
  const m = hasOwn(data, 'model') ? data.model : null;
  if (typeof m !== 'string' || !m.trim() || m.trim().length > 60) return null;
  return m.trim();
}

function readMarkdownFile(abs) {
  try {
    return readFrontmatter(fs.readFileSync(abs, 'utf8'));
  } catch {
    return null;
  }
}

function hasAncestorIn(set, dirRel) {
  if (set.has('')) return true;
  if (!dirRel) return false;
  let acc = '';
  for (const s of dirRel.split('/')) {
    acc = acc ? `${acc}/${s}` : s;
    if (set.has(acc)) return true;
  }
  return false;
}

function groupFor(rel, candidates) {
  let best = null;
  for (const c of candidates) {
    if (rel === c.prefix || rel.startsWith(`${c.prefix}/`)) {
      if (!best || c.prefix.length > best.prefix.length) best = c;
    }
  }
  return best ? best.name : null;
}

function parentRel(rel) {
  const k = rel.lastIndexOf('/');
  return k < 0 ? '' : rel.slice(0, k);
}

function lastSegment(rel) {
  const k = rel.lastIndexOf('/');
  return k < 0 ? rel : rel.slice(k + 1);
}

function flagManifestKeys(obj, flags) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.hooks) flags.hooks = true;
  if (obj.mcpServers) flags.mcp = true;
  if (obj.lspServers || obj.outputStyles) flags.lsp = true;
}

/**
 * Scans a cloned repository (or its linked sub-folder) for skills, agents and commands.
 * @param {string} dir absolute folder to scan
 * @param {{pluginName?: string, rootName?: string}} [opts] pluginName prefixes fullName; rootName
 *   names a SKILL.md found at the scan root (defaults to the folder name).
 * @returns {{kind: 'plugin'|'marketplace'|'loose', items: object[], warnings: string[]}}
 */
function scanRepo(dir, opts = {}) {
  const pluginName = typeof opts.pluginName === 'string' && opts.pluginName ? opts.pluginName : null;
  const rootName = typeof opts.rootName === 'string' && opts.rootName ? opts.rootName : null;
  const warnings = [];
  const root = path.resolve(String(dir || '.'));
  if (!isRealDir(root)) return { kind: 'loose', items: [], warnings: [MSG.noDir] };

  let kind = 'loose';
  if (isRealFile(path.join(root, '.claude-plugin', 'plugin.json'))) kind = 'plugin';
  else if (isRealFile(path.join(root, '.claude-plugin', 'marketplace.json'))) kind = 'marketplace';

  // 1. Walk (sorted, depth-first, files of a folder before its sub-folders).
  const files = [];
  let entries = 0;
  let truncated = false;
  let tooDeep = false;
  let symlinks = 0;
  const stack = [{ abs: root, rel: '', depth: 0 }];
  while (stack.length && !truncated) {
    const cur = stack.pop();
    let dirents;
    try {
      dirents = fs.readdirSync(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs = [];
    for (const d of dirents) {
      if (entries >= MAX_SCAN_ENTRIES) {
        truncated = true;
        break;
      }
      entries += 1;
      const abs = path.join(cur.abs, d.name);
      const rel = cur.rel ? `${cur.rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) {
        symlinks += 1;
        continue;
      }
      const st = lstatSafe(abs);
      if (!st) continue;
      if (st.isSymbolicLink()) {
        symlinks += 1;
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(d.name)) continue;
        if (cur.depth + 1 > MAX_SCAN_DEPTH) {
          tooDeep = true;
          continue;
        }
        subdirs.push({ abs, rel, depth: cur.depth + 1 });
      } else if (st.isFile()) {
        files.push({ abs, rel, dirRel: cur.rel, name: d.name, size: st.size });
      }
    }
    for (let i = subdirs.length - 1; i >= 0; i -= 1) stack.push(subdirs[i]);
  }

  // 2. Manifests, hooks, MCP servers, groups.
  const flags = { hooks: false, mcp: false, lsp: false };
  const groupCands = [];
  let external = 0;
  let marketplace = null;
  for (const f of files) {
    const lower = f.name.toLowerCase();
    const parent = lastSegment(f.dirRel).toLowerCase();
    if (lower === 'hooks.json' && parent === 'hooks') flags.hooks = true;
    else if (lower === '.mcp.json') flags.mcp = true;
    else if (lower === '.lsp.json') flags.lsp = true;
    else if (parent === 'output-styles' && lower.endsWith('.md')) flags.lsp = true;
    else if ((lower === 'settings.json' || lower === 'settings.local.json') && parent === '.claude') {
      const json = readJsonSafe(f.abs);
      if (json && json.hooks) flags.hooks = true;
    } else if (lower === 'plugin.json' && parent === '.claude-plugin') {
      const json = readJsonSafe(f.abs);
      flagManifestKeys(json, flags);
      const ownerRel = parentRel(f.dirRel);
      if (ownerRel === '') continue;
      const gname = (json && normalizeName(asText(json.name))) || normalizeName(lastSegment(ownerRel));
      if (!gname) continue;
      groupCands.push({ prefix: ownerRel, name: gname });
      for (const key of ['skills', 'agents', 'commands']) {
        const list = json && typeof json[key] === 'string' ? [json[key]] : json && Array.isArray(json[key]) ? json[key] : [];
        for (const e of list.slice(0, 1000)) {
          const r = normRel(e);
          if (r) groupCands.push({ prefix: joinRel(ownerRel, r), name: gname });
        }
      }
    } else if (lower === 'marketplace.json' && f.rel === '.claude-plugin/marketplace.json') {
      marketplace = readJsonSafe(f.abs);
    }
  }
  if (marketplace && Array.isArray(marketplace.plugins)) {
    const base = marketplace.metadata && typeof marketplace.metadata.pluginRoot === 'string' ? normRel(marketplace.metadata.pluginRoot) || '' : '';
    for (const p of marketplace.plugins.slice(0, 1000)) {
      if (!p || typeof p !== 'object') continue;
      flagManifestKeys(p, flags);
      if (typeof p.source !== 'string') {
        if (p.source) external += 1;
        continue;
      }
      const gname = normalizeName(asText(p.name));
      const src = normRel(p.source);
      if (!gname || src === null) continue;
      const srcRel = base && !/^\.{1,2}\//.test(p.source.trim()) ? joinRel(base, src) : src;
      if (srcRel) groupCands.push({ prefix: srcRel, name: gname });
      for (const key of ['skills', 'agents', 'commands']) {
        const list = typeof p[key] === 'string' ? [p[key]] : Array.isArray(p[key]) ? p[key] : [];
        for (const e of list.slice(0, 1000)) {
          const r = normRel(e);
          if (r) groupCands.push({ prefix: joinRel(srcRel, r), name: gname });
        }
      }
    }
  }

  // 3. Skill folders (outermost SKILL.md wins; nested ones are supporting files).
  const depthOf = (rel) => (rel ? rel.split('/').length : 0);
  const skillFiles = files
    .map((f, idx) => ({ f, idx }))
    .filter(({ f }) => f.name.toLowerCase() === 'skill.md')
    .sort((a, b) => depthOf(a.f.dirRel) - depthOf(b.f.dirRel) || a.idx - b.idx);
  const skillDirs = new Set();
  for (const { f } of skillFiles) {
    if (!hasAncestorIn(skillDirs, f.dirRel)) skillDirs.add(f.dirRel);
  }

  // 4. Items, in walk order.
  const candidates = [];
  const emittedSkills = new Set();
  let bigFiles = 0;
  for (const f of files) {
    const lower = f.name.toLowerCase();
    if (lower === 'skill.md') {
      if (!skillDirs.has(f.dirRel) || emittedSkills.has(f.dirRel)) continue;
      emittedSkills.add(f.dirRel);
      const fm = f.size <= MAX_PARSE_BYTES ? readMarkdownFile(f.abs) : null;
      if (f.size > MAX_PARSE_BYTES) bigFiles += 1;
      const data = fm ? fm.data : {};
      const folderName = f.dirRel ? lastSegment(f.dirRel) : rootName || path.basename(root);
      candidates.push({
        type: 'skill',
        baseName: normalizeName(asText(data.name)) || normalizeName(folderName) || 'skill',
        description: describeItem(data, fm ? fm.body : ''),
        relPath: f.dirRel || '.',
        group: groupFor(f.dirRel, groupCands),
        tools: toolsOf(data),
        model: modelOf(data),
      });
      continue;
    }
    if (!lower.endsWith('.md')) continue;
    if (hasAncestorIn(skillDirs, f.dirRel)) continue;
    if (IGNORED_DOCS.has(lower.slice(0, -3).split('.')[0])) continue;
    const segs = f.dirRel ? f.dirRel.toLowerCase().split('/') : [];
    const agentsIdx = segs.lastIndexOf('agents');
    const commandsIdx = segs.lastIndexOf('commands');
    if (f.size > MAX_PARSE_BYTES) {
      if (agentsIdx >= 0 || commandsIdx >= 0) bigFiles += 1;
      continue;
    }
    const fm = readMarkdownFile(f.abs);
    if (!fm || !fm.found) continue;
    const stem = f.name.slice(0, -3);
    if (commandsIdx > agentsIdx) {
      candidates.push({
        type: 'command',
        baseName: normalizeName(stem) || 'commande',
        description: describeItem(fm.data, fm.body),
        relPath: f.rel,
        group: groupFor(f.rel, groupCands),
        tools: toolsOf(fm.data),
        model: modelOf(fm.data),
      });
      continue;
    }
    const d = fm.data;
    if (!asText(d.name) || !asText(d.description) || typeof d.name !== 'string') continue;
    if (agentsIdx < 0 && !hasOwn(d, 'tools') && !hasOwn(d, 'model') && !hasOwn(d, 'color')) continue;
    candidates.push({
      type: 'agent',
      baseName: normalizeName(d.name) || normalizeName(stem) || 'agent',
      description: describeItem(d, fm.body),
      relPath: f.rel,
      group: groupFor(f.rel, groupCands),
      tools: toolsOf(d),
      model: modelOf(d),
    });
  }

  if (candidates.length > MAX_ITEMS) {
    warnings.push(MSG.capItems);
    candidates.length = MAX_ITEMS;
  }
  const used = { skill: new Set(), agent: new Set(), command: new Set() };
  const items = candidates.map((c) => {
    const name = uniqueName(c.baseName, used[c.type]);
    return {
      key: `${c.type}:${name}`,
      type: c.type,
      name,
      fullName: pluginName ? `${pluginName}:${name}` : name,
      description: c.description,
      relPath: c.relPath,
      enabled: true,
      group: c.group,
      tools: c.tools,
      model: c.model,
      error: null,
    };
  });

  if (flags.hooks) warnings.unshift(MSG.hooks);
  if (flags.mcp) warnings.splice(flags.hooks ? 1 : 0, 0, MSG.mcp);
  if (flags.lsp) warnings.push(MSG.lsp);
  if (external) warnings.push(MSG.external(external));
  if (truncated) warnings.push(MSG.capEntries);
  if (tooDeep) warnings.push(MSG.tooDeep);
  if (bigFiles) warnings.push(MSG.bigFiles(bigFiles));
  if (symlinks) warnings.push(MSG.symlinks(symlinks));
  if (!items.length) warnings.push(MSG.empty);
  return { kind, items, warnings };
}

// ---------------------------------------------------------------------------------------------
// Processes (hidden, never prompting)

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (IS_WIN) {
    try {
      const taskkill = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'taskkill.exe');
      const k = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      });
    } catch {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
}

function pathDirs(env) {
  const raw = env.PATH || env.Path || env.path || '';
  return raw
    .split(path.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && path.isAbsolute(d));
}

function isExecutable(p) {
  if (!isFile(p)) return false;
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** macOS ships a /usr/bin/git stub that opens an "install developer tools" dialog: avoid it. */
function isDarwinStub(p) {
  if (process.platform !== 'darwin' || p !== '/usr/bin/git') return false;
  return !isFile('/Library/Developer/CommandLineTools/usr/bin/git') && !isFile('/Applications/Xcode.app/Contents/Developer/usr/bin/git');
}

function findGit(env = process.env) {
  if (IS_WIN) {
    for (const d of pathDirs(env)) {
      const p = path.join(d, 'git.exe');
      if (isFile(p)) return p;
    }
    const bases = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')];
    for (const b of bases.filter(Boolean)) {
      const p = path.join(b, 'Git', 'cmd', 'git.exe');
      if (isFile(p)) return p;
    }
    return null;
  }
  const candidates = [...pathDirs(env).map((d) => path.join(d, 'git')), '/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
  for (const p of candidates) if (isExecutable(p) && !isDarwinStub(p)) return p;
  return null;
}

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GIT_/i.test(k) && !/^GIT_(SSL_|HTTP_|PROXY_|CURL_)/i.test(k)) continue;
    if (/^(GCM_INTERACTIVE|GCM_GUI_PROMPT|SSH_ASKPASS|LC_ALL|LANG|LANGUAGE)$/i.test(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GCM_GUI_PROMPT: 'false',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GIT_LFS_SKIP_SMUDGE: '1',
    LC_ALL: 'C',
    LANG: 'C',
    LANGUAGE: 'C',
  });
}

function lastGitLine(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const fatal = lines.filter((l) => /^(fatal|error):/i.test(l));
  const line = (fatal.length ? fatal[fatal.length - 1] : lines[lines.length - 1]) || 'erreur inconnue';
  return clip(line.replace(/^(fatal|error):\s*/i, ''), 200);
}

function gitErrorMessage(res, branch) {
  if (res.timedOut) return MSG.timeout;
  if (res.error && res.error.code === 'ENOENT') return MSG.noGit;
  const text = `${res.stderr || ''}\n${res.stdout || ''}`;
  if (/remote branch .* not found|couldn't find remote ref|could not find remote branch/i.test(text)) return MSG.branch(branch || 'HEAD');
  if (
    /repository .*not found|not found|could not read (username|password)|terminal prompts disabled|authentication failed|returned error: (401|403|404)|does not appear to be a git repository|does not exist|invalid username|access denied/i.test(
      text
    )
  ) {
    return MSG.notFound;
  }
  if (/could not resolve (host|proxy)|unable to access|failed to connect|connection (timed out|refused|reset)|network is unreachable|ssl|tls|proxy|timed out/i.test(text)) {
    return MSG.network;
  }
  return `Échec de git : ${lastGitLine(res.stderr || res.stdout)}`;
}

function dirSizeExceeds(dir, limit) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      const p = path.join(cur, e.name);
      const st = lstatSafe(p);
      if (!st || st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(p);
      else {
        total += st.size;
        if (total > limit) return true;
      }
    }
  }
  return false;
}

function packSize(cloneDir) {
  const packDir = path.join(cloneDir, '.git', 'objects', 'pack');
  let total = 0;
  for (const name of safeReaddir(packDir)) {
    const st = lstatSafe(path.join(packDir, name));
    if (st && st.isFile()) total += st.size;
  }
  return total;
}

async function copyTree(src, dest, budget, depth = 0) {
  if (depth > MAX_SCAN_DEPTH) return;
  await fsp.mkdir(dest, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    let st;
    try {
      st = await fsp.lstat(s);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      await copyTree(s, d, budget, depth + 1);
    } else if (st.isFile()) {
      budget.bytes += st.size;
      budget.files += 1;
      if (budget.bytes > MAX_SKILL_BYTES || budget.files > MAX_SKILL_FILES) throw userError('dossier de plus de 20 Mo');
      await fsp.copyFile(s, d);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Persisted state sanitising (library.json is never trusted blindly: ids become paths)

function emptyCounts() {
  return { skills: 0, agents: 0, commands: 0, enabledSkills: 0, enabledAgents: 0, enabledCommands: 0 };
}

function emptyMeta() {
  return { scanWarnings: [], buildWarnings: [], updateWarning: null, fingerprint: null };
}

function stringList(v, max = 50) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, max).map((x) => clip(x, 500)) : [];
}

function nullableString(v, max) {
  return typeof v === 'string' && v ? clip(v, max) : null;
}

function safeRelPath(rel) {
  if (rel === '.') return true;
  if (typeof rel !== 'string' || !rel || rel.length > 1000 || /[\\:\0]/.test(rel) || rel.startsWith('/')) return false;
  return rel.split('/').every((s) => s && s !== '.' && s !== '..');
}

function sanitizeItem(it, plugin) {
  if (!it || typeof it !== 'object') return null;
  if (!ITEM_TYPES.includes(it.type) || typeof it.name !== 'string' || !NAME_RE.test(it.name)) return null;
  if (!safeRelPath(it.relPath)) return null;
  return {
    key: `${it.type}:${it.name}`,
    type: it.type,
    name: it.name,
    fullName: `${plugin}:${it.name}`,
    description: typeof it.description === 'string' ? clip(it.description, MAX_DESCRIPTION) : '',
    relPath: it.relPath,
    enabled: it.enabled !== false,
    group: typeof it.group === 'string' && NAME_RE.test(it.group) ? it.group : null,
    tools: nullableString(it.tools, 200),
    model: nullableString(it.model, 60),
    error: nullableString(it.error, 300),
  };
}

function sanitizeRepo(e) {
  if (!e || typeof e !== 'object') return null;
  if (typeof e.owner !== 'string' || typeof e.repo !== 'string') return null;
  if (e.branch !== null && e.branch !== undefined && typeof e.branch !== 'string') return null;
  if (e.subpath !== null && e.subpath !== undefined && typeof e.subpath !== 'string') return null;
  if (e.subpath && !e.branch) return null;
  let parsed;
  try {
    let input = `https://github.com/${e.owner}/${e.repo}`;
    if (e.branch) input += `/tree/${e.branch}${e.subpath ? `/${e.subpath}` : ''}`;
    parsed = parseRepoInput(input);
  } catch {
    return null;
  }
  if (parsed.owner !== e.owner || parsed.repo !== e.repo || e.id !== parsed.id || !ID_RE.test(parsed.id)) return null;
  if (typeof e.plugin !== 'string' || !PLUGIN_RE.test(e.plugin)) return null;
  // A name Claude Code would refuse (older state) is re-derived; _load keeps it unique.
  const plugin = isAllowedPluginName(e.plugin) ? e.plugin : parsed.plugin;
  const items = [];
  const keys = new Set();
  for (const raw of Array.isArray(e.items) ? e.items.slice(0, MAX_ITEMS) : []) {
    const it = sanitizeItem(raw, plugin);
    if (!it || keys.has(it.key)) continue;
    keys.add(it.key);
    items.push(it);
  }
  return {
    id: parsed.id,
    url: parsed.url,
    owner: parsed.owner,
    repo: parsed.repo,
    branch: parsed.branch,
    subpath: parsed.subpath,
    plugin,
    status: STATUSES.has(e.status) ? e.status : 'error',
    error: nullableString(e.error, 500),
    enabled: e.enabled !== false,
    commit: typeof e.commit === 'string' && COMMIT_RE.test(e.commit) ? e.commit : null,
    clonedAt: Number.isFinite(e.clonedAt) ? e.clonedAt : null,
    updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : null,
    kind: KINDS.has(e.kind) ? e.kind : null,
    counts: emptyCounts(),
    warnings: stringList(e.warnings, MAX_REPO_WARNINGS),
    items,
  };
}

function sanitizeMeta(m) {
  const out = emptyMeta();
  if (!m || typeof m !== 'object') return out;
  out.scanWarnings = stringList(m.scanWarnings);
  out.buildWarnings = stringList(m.buildWarnings);
  out.updateWarning = nullableString(m.updateWarning, 500);
  out.fingerprint = typeof m.fingerprint === 'string' && /^[0-9a-f]{40}$/.test(m.fingerprint) ? m.fingerprint : null;
  return out;
}

function isOurWrapper(dir) {
  const manifest = readJsonSafe(path.join(dir, '.claude-plugin', 'plugin.json'));
  return !!manifest && typeof manifest.description === 'string' && manifest.description.endsWith(WRAPPER_SIGNATURE);
}

// ---------------------------------------------------------------------------------------------
// Library

class Library extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.home] data dir (default env PIXELQG_HOME or ~/.pixelqg)
   * @param {{command: string, prefixArgs?: string[]}|null} [opts.claudeBin] resolved claude binary (validation only)
   * @param {string} [opts.gitBin] explicit git executable (a missing file means "git not installed")
   * @param {string} [opts.baseUrl] clone base, default https://github.com (tests may pass a file:// base)
   * @param {number} [opts.maxConcurrentGit] default 2
   * @param {boolean} [opts.validate] run `claude plugin validate` on every wrapper (default true)
   * @param {number} [opts.gitTimeoutMs] default 180 000
   * @param {number} [opts.validateTimeoutMs] default 30 000
   * @param {number} [opts.maxCloneBytes] default 300 MB
   * @param {number} [opts.maxRepos] default 30
   */
  constructor(opts = {}) {
    super();
    this.home = path.resolve(opts.home || process.env.PIXELQG_HOME || path.join(os.homedir(), '.pixelqg'));
    this.claudeBin = opts.claudeBin && opts.claudeBin.command ? opts.claudeBin : null;
    this.gitBinOverride = opts.gitBin || null;
    this.baseUrl = String(opts.baseUrl || 'https://github.com').replace(/\/+$/, '');
    this.maxConcurrentGit = Math.max(1, Number(opts.maxConcurrentGit) || 2);
    this.validate = opts.validate !== false;
    this.gitTimeoutMs = Number(opts.gitTimeoutMs) || DEFAULT_GIT_TIMEOUT;
    this.validateTimeoutMs = Number(opts.validateTimeoutMs) || DEFAULT_VALIDATE_TIMEOUT;
    this.maxCloneBytes = Number(opts.maxCloneBytes) || DEFAULT_MAX_CLONE_BYTES;
    this.maxRepos = Number(opts.maxRepos) || DEFAULT_MAX_REPOS;

    this.libraryFile = path.join(this.home, 'library.json');
    this.reposDir = path.join(this.home, 'repos');
    this.pluginDir = path.join(this.home, 'library');
    this.buildDir = path.join(this.home, '.library-build');

    this.gitPath = null;
    this.gitFound = false;
    this.gitVersion = null;
    this.recovered = false;
    this.lastSaveError = null;

    const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(this.baseUrl) || [])[1];
    this._scheme = scheme ? scheme.toLowerCase() : 'https';
    this._repos = [];
    this._meta = new Map();
    this._wrappers = new Set();
    this._queues = new Map();
    this._aborts = new Map();
    this._removing = new Set();
    this._children = new Set();
    this._jobs = new Set();
    this._gitActive = 0;
    this._gitPeak = 0;
    this._gitWaiters = [];
    this._loaded = false;
    this._initialized = false;
    this._initPromise = null;
    this._closed = false;
  }

  // ----- public API --------------------------------------------------------------------------

  /** Loads library.json, detects git, rebuilds the wrapper plugins. Idempotent. */
  init() {
    if (!this._initPromise) this._initPromise = this._doInit();
    return this._initPromise;
  }

  /** Library object of §2 (deep copy). */
  get() {
    return {
      pluginDir: this.pluginDir,
      gitFound: this.gitFound,
      gitVersion: this.gitVersion,
      repos: structuredClone(this._repos),
      profiles: this._profiles(),
    };
  }

  /**
   * Links a repository. Resolves immediately with the repo (status "cloning"); the clone, scan and
   * wrapper build continue in the background ("change" events).
   * @param {string|{url: string}} input
   */
  async link(input) {
    this._assertUsable();
    this._assertGit();
    const raw = input && typeof input === 'object' ? input.url : input;
    const p = parseRepoInput(raw);
    if (this._repos.some((r) => r.id === p.id)) throw httpError(409, MSG.duplicate, 'ALREADY_LINKED');
    if (this._repos.length >= this.maxRepos) throw httpError(400, MSG.tooMany(this.maxRepos), 'TOO_MANY_REPOS');
    const repo = {
      id: p.id,
      url: p.url,
      owner: p.owner,
      repo: p.repo,
      branch: p.branch,
      subpath: p.subpath,
      plugin: this._uniquePlugin(p.plugin),
      status: 'cloning',
      error: null,
      enabled: true,
      commit: null,
      clonedAt: null,
      updatedAt: null,
      kind: null,
      counts: emptyCounts(),
      warnings: [],
      items: [],
    };
    this._repos.push(repo);
    this._meta.set(repo.id, emptyMeta());
    this._changed();
    this._track(this._enqueue(repo.id, () => this._syncJob(repo, { update: false, prevStatus: null })));
    return structuredClone(repo);
  }

  /** Fetches the latest commit (status "updating"; resolves immediately). */
  async update(id) {
    this._assertUsable();
    const repo = this._find(id);
    this._assertGit();
    if (repo.status === 'cloning' || repo.status === 'updating' || this._removing.has(repo.id)) throw httpError(409, MSG.busy, 'BUSY');
    const prevStatus = repo.status;
    repo.status = 'updating';
    repo.error = null;
    this._changed();
    this._track(this._enqueue(repo.id, () => this._syncJob(repo, { update: true, prevStatus })));
    return structuredClone(repo);
  }

  /**
   * Enables / disables a whole repo ({ enabled }) or one item ({ key, enabled }). Resolves once the
   * wrapper plugin has been rebuilt (or immediately while a clone / update is running).
   */
  async toggle(id, opts = {}) {
    this._assertUsable();
    const repo = this._find(id);
    const { enabled, key } = opts || {};
    if (typeof enabled !== 'boolean') throw httpError(400, MSG.badEnabled, 'BAD_ENABLED');
    if (key !== undefined && key !== null) {
      const item = typeof key === 'string' ? repo.items.find((i) => i.key === key) : null;
      if (!item) throw httpError(404, MSG.unknownItem, 'UNKNOWN_ITEM');
      item.enabled = enabled;
    } else {
      repo.enabled = enabled;
    }
    this._changed();
    const busy = repo.status === 'cloning' || repo.status === 'updating';
    const job = this._enqueue(repo.id, async () => {
      if (this._gone(repo.id)) return;
      try {
        await this._syncWrapper(repo);
      } catch (err) {
        await this._failRepo(repo, MSG.buildFailed(err.userMessage || err.message));
      }
      if (!this._gone(repo.id)) this._changed();
    });
    // While a clone / update runs, the rebuild is queued behind it instead of blocking the caller.
    if (busy) this._track(job);
    else await job;
    return structuredClone(repo);
  }

  /** Deletes the clone and the wrapper (aborts a running clone / update first). */
  async remove(id) {
    this._assertUsable();
    const repo = this._find(id);
    this._removing.add(repo.id);
    const ac = this._aborts.get(repo.id);
    if (ac) ac.abort();
    try {
      await this._enqueue(repo.id, async () => {
        await rmrf(path.join(this.pluginDir, repo.plugin));
        this._wrappers.delete(repo.plugin);
        await rmrf(this._clonePath(repo));
        const tmpRe = new RegExp(`^${repo.id.replace(/[.]/g, '\\.')}\\.tmp-${RAND_RE}$`);
        for (const name of safeReaddir(this.reposDir)) if (tmpRe.test(name)) await rmrf(path.join(this.reposDir, name));
        this._repos = this._repos.filter((r) => r.id !== repo.id);
        this._meta.delete(repo.id);
        if (!this._closed) this._changed();
      });
    } finally {
      this._removing.delete(repo.id);
    }
    return true;
  }

  /** Arguments to add to every claude spawn: [] or ["--plugin-dir", pluginDir]. */
  pluginDirArgs() {
    return this._wrappers.size > 0 ? ['--plugin-dir', this.pluginDir] : [];
  }

  /** True when value is one of library.profiles[].value. */
  hasProfile(value) {
    return typeof value === 'string' && value !== '' && this._profiles().some((p) => p.value === value);
  }

  /** Aborts running git / validation processes and waits (≤ 5 s) for background jobs. */
  async close() {
    if (this._closed) return;
    this._closed = true;
    for (const ac of this._aborts.values()) ac.abort();
    for (const child of this._children) killTree(child);
    const pending = [...this._jobs];
    let timer;
    await Promise.race([Promise.allSettled(pending), new Promise((resolve) => (timer = setTimeout(resolve, 5000)))]);
    clearTimeout(timer);
    for (const child of this._children) killTree(child);
  }

  // ----- init / persistence --------------------------------------------------------------------

  async _doInit() {
    await fsp.mkdir(this.reposDir, { recursive: true });
    await fsp.mkdir(this.pluginDir, { recursive: true });
    await fsp.mkdir(this.buildDir, { recursive: true });
    this._load();
    this._loaded = true;
    await this._detectGit();
    for (const r of this._repos) {
      if (r.status === 'cloning' || r.status === 'updating') {
        r.status = 'error';
        r.error = MSG.interrupted;
      } else if (r.status === 'ready' && !isRealDir(path.join(this._clonePath(r), '.git'))) {
        r.status = 'error';
        r.error = MSG.cloneMissing;
      }
    }
    await this._cleanupStrays();
    for (const r of this._repos) {
      if (this._closed) break;
      try {
        await this._syncWrapper(r);
      } catch (err) {
        await this._failRepo(r, MSG.buildFailed(err.userMessage || err.message));
      }
    }
    await this._removeUnknownWrappers();
    this._initialized = true;
    this._changed();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.libraryFile, 'utf8');
    } catch {
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.repos)) {
      this.recovered = true;
      try {
        fs.renameSync(this.libraryFile, `${this.libraryFile}.bad`);
      } catch {
        try {
          fs.copyFileSync(this.libraryFile, `${this.libraryFile}.bad`);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    const ids = new Set();
    const plugins = new Set();
    let dropped = 0;
    for (const entry of parsed.repos.slice(0, 200)) {
      const r = sanitizeRepo(entry);
      if (!r || ids.has(r.id) || (plugins.has(r.plugin) && r.plugin === entry.plugin)) {
        dropped += 1;
        continue;
      }
      if (plugins.has(r.plugin)) {
        // Re-derived name (see sanitizeRepo) already taken: suffix it.
        let name = r.plugin;
        for (let n = 2; plugins.has(name); n += 1) name = withSuffix(r.plugin, n, 40);
        r.plugin = name;
        for (const it of r.items) it.fullName = `${name}:${it.name}`;
      }
      ids.add(r.id);
      plugins.add(r.plugin);
      this._repos.push(r);
      this._meta.set(r.id, sanitizeMeta(hasOwn(parsed.meta, r.id) ? parsed.meta[r.id] : null));
    }
    if (dropped) {
      this.recovered = true;
      try {
        fs.copyFileSync(this.libraryFile, `${this.libraryFile}.bad`);
      } catch {
        /* ignore */
      }
    }
  }

  _save() {
    if (!this._loaded) return;
    const data = { version: 1, savedAt: Date.now(), repos: this._repos, meta: Object.fromEntries(this._meta) };
    const tmp = `${this.libraryFile}.tmp-${process.pid}-${randomSuffix()}`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      for (let i = 0; ; i += 1) {
        try {
          fs.renameSync(tmp, this.libraryFile);
          break;
        } catch (err) {
          if (i >= 8) throw err;
          sleepSync(25 * (i + 1));
        }
      }
      this.lastSaveError = null;
    } catch (err) {
      this.lastSaveError = err.message;
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }

  async _detectGit() {
    const candidate = this.gitBinOverride ? path.resolve(this.gitBinOverride) : findGit();
    if (!candidate || !isFile(candidate)) {
      this.gitFound = false;
      return;
    }
    const res = await this._exec(candidate, ['--version'], { timeoutMs: 15000, env: gitEnv(), cwd: this.home });
    const line = String(res.stdout || '').trim().split(/\r?\n/)[0] || '';
    if (res.code === 0 && /^git version /i.test(line)) {
      this.gitPath = candidate;
      this.gitFound = true;
      this.gitVersion = line.replace(/^git version\s*/i, '').trim() || null;
    } else {
      this.gitFound = false;
    }
  }

  async _cleanupStrays() {
    const known = new Set(this._repos.map((r) => r.id));
    const tmpRe = new RegExp(`^(.+)\\.tmp-${RAND_RE}$`);
    for (const name of safeReaddir(this.reposDir)) {
      const p = path.join(this.reposDir, name);
      const t = tmpRe.exec(name);
      if (t && ID_RE.test(t[1])) {
        await rmrf(p);
      } else if (!known.has(name) && ID_RE.test(name) && name.includes('__') && isRealDir(path.join(p, '.git'))) {
        await rmrf(p);
      }
    }
    const buildRe = new RegExp(`-${RAND_RE}$`);
    for (const name of safeReaddir(this.buildDir)) if (buildRe.test(name)) await rmrf(path.join(this.buildDir, name));
    const saveRe = new RegExp(`^library\\.json\\.tmp-\\d+-${RAND_RE}$`);
    for (const name of safeReaddir(this.home)) {
      if (saveRe.test(name)) {
        try {
          fs.unlinkSync(path.join(this.home, name));
        } catch {
          /* ignore */
        }
      }
    }
  }

  async _removeUnknownWrappers() {
    for (const name of safeReaddir(this.pluginDir)) {
      if (this._wrappers.has(name)) continue;
      const p = path.join(this.pluginDir, name);
      if (isRealDir(p) && isOurWrapper(p)) await rmrf(p);
    }
  }

  // ----- state helpers -------------------------------------------------------------------------

  _assertUsable() {
    if (this._closed) throw httpError(503, MSG.closed, 'CLOSED');
    if (!this._initialized) throw httpError(503, MSG.notReady, 'NOT_READY');
  }

  _assertGit() {
    if (!this.gitFound) throw httpError(503, MSG.noGit, 'GIT_MISSING');
  }

  _find(id) {
    const repo = typeof id === 'string' ? this._repos.find((r) => r.id === id) : null;
    if (!repo) throw httpError(404, MSG.unknownRepo, 'NOT_FOUND');
    return repo;
  }

  _gone(id) {
    return this._closed || this._removing.has(id) || !this._repos.some((r) => r.id === id);
  }

  _metaFor(id) {
    let m = this._meta.get(id);
    if (!m) {
      m = emptyMeta();
      this._meta.set(id, m);
    }
    return m;
  }

  _uniquePlugin(base) {
    const used = new Set(this._repos.map((r) => r.plugin));
    let name = base;
    for (let n = 2; used.has(name); n += 1) name = withSuffix(base, n, 40);
    return name;
  }

  _clonePath(repo) {
    return path.join(this.reposDir, repo.id);
  }

  _scanRootPath(repo) {
    const clone = this._clonePath(repo);
    if (!isRealDir(clone)) return null;
    if (!repo.subpath) return clone;
    const p = resolveInside(clone, repo.subpath);
    return p && isRealDir(p) ? p : null;
  }

  _refresh(repo) {
    const c = emptyCounts();
    for (const it of repo.items) {
      const k = `${it.type}s`;
      c[k] += 1;
      if (it.enabled) c[`enabled${k[0].toUpperCase()}${k.slice(1)}`] += 1;
    }
    repo.counts = c;
    const m = this._metaFor(repo.id);
    const w = [];
    if (m.updateWarning) w.push(m.updateWarning);
    w.push(...m.scanWarnings, ...m.buildWarnings);
    const enabledCount = c.enabledSkills + c.enabledAgents + c.enabledCommands;
    if (repo.enabled && enabledCount > MANY_ENABLED_ITEMS) w.push(MSG.manyItems(enabledCount));
    repo.warnings = [...new Set(w)].slice(0, MAX_REPO_WARNINGS);
  }

  _changed() {
    for (const r of this._repos) this._refresh(r);
    this._save();
    this.emit('change', this.get());
  }

  _profiles() {
    const out = [];
    for (const r of this._repos) {
      if (!r.enabled || (r.status !== 'ready' && r.status !== 'updating') || !this._wrappers.has(r.plugin)) continue;
      for (const it of r.items) {
        if (it.type === 'agent' && it.enabled && !it.error) {
          out.push({ value: it.fullName, label: it.name, repo: `${r.owner}/${r.repo}`, description: it.description });
        }
      }
    }
    return out;
  }

  _enqueue(id, fn) {
    const prev = this._queues.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this._queues.set(id, next);
    const clear = () => {
      if (this._queues.get(id) === next) this._queues.delete(id);
    };
    next.then(clear, clear);
    return next;
  }

  _track(promise) {
    const p = Promise.resolve(promise).catch(() => {});
    this._jobs.add(p);
    p.finally(() => this._jobs.delete(p));
    return p;
  }

  async _failRepo(repo, message) {
    repo.status = 'error';
    repo.error = message;
    // The wrapper of a failed repo must not stay loadable.
    await this._dropWrapper(repo);
  }

  // ----- processes -----------------------------------------------------------------------------

  _exec(command, args, { cwd, env, timeoutMs, signal } = {}) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) {
        resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true });
        return;
      }
      let child;
      try {
        child = spawn(command, args, {
          cwd: cwd || this.home,
          env: env || process.env,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: !IS_WIN,
        });
      } catch (error) {
        resolve({ code: null, stdout: '', stderr: String(error.message), timedOut: false, aborted: false, error });
        return;
      }
      this._children.add(child);
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let aborted = false;
      let done = false;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        if (stdout.length < MAX_OUTPUT) stdout += d;
      });
      child.stderr.on('data', (d) => {
        if (stderr.length < MAX_OUTPUT) stderr += d;
      });
      const timer = timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            killTree(child);
          }, timeoutMs)
        : null;
      const onAbort = () => {
        aborted = true;
        killTree(child);
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const finish = (code, error) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        this._children.delete(child);
        resolve({ code, stdout, stderr, timedOut, aborted, error });
      };
      child.on('error', (error) => finish(null, error));
      child.on('close', (code) => finish(code));
    });
  }

  async _acquireGit() {
    if (this._gitActive < this.maxConcurrentGit) {
      this._gitActive += 1;
    } else {
      await new Promise((resolve) => this._gitWaiters.push(resolve));
    }
    this._gitPeak = Math.max(this._gitPeak, this._gitActive);
  }

  _releaseGit() {
    const next = this._gitWaiters.shift();
    if (next) next();
    else this._gitActive -= 1;
  }

  _gitConfigArgs() {
    const a = [
      '-c', 'credential.helper=',
      '-c', 'core.askPass=',
      '-c', 'credential.interactive=false',
      '-c', 'core.fsmonitor=false',
      '-c', 'core.symlinks=false',
      '-c', 'core.autocrlf=false',
      '-c', 'gc.auto=0',
      '-c', 'maintenance.auto=false',
      '-c', 'fetch.recurseSubmodules=false',
      '-c', 'submodule.recurse=false',
      '-c', 'advice.detachedHead=false',
      '-c', 'protocol.allow=never',
      '-c', `protocol.${this._scheme}.allow=always`,
    ];
    if (IS_WIN) a.push('-c', 'core.longpaths=true');
    return a;
  }

  async _runGit(args, { cwd, signal, timeoutMs } = {}) {
    if (!this.gitPath) return { code: null, stdout: '', stderr: '', error: Object.assign(new Error('git missing'), { code: 'ENOENT' }) };
    await this._acquireGit();
    try {
      if (this._closed || (signal && signal.aborted)) return { code: null, stdout: '', stderr: '', timedOut: false, aborted: true };
      return await this._exec(this.gitPath, [...this._gitConfigArgs(), ...args], {
        cwd: cwd || this.reposDir,
        env: gitEnv(),
        timeoutMs: timeoutMs || this.gitTimeoutMs,
        signal,
      });
    } finally {
      this._releaseGit();
    }
  }

  _repoGitArgs(clone) {
    return ['-c', `safe.directory=${clone.replace(/\\/g, '/')}`, `--git-dir=${path.join(clone, '.git')}`, `--work-tree=${clone}`];
  }

  _cloneUrl(repo) {
    return `${this.baseUrl}/${repo.owner}/${repo.repo}.git`;
  }

  // ----- clone / update job ----------------------------------------------------------------------

  async _syncJob(repo, { update, prevStatus }) {
    const id = repo.id;
    if (this._gone(id)) return;
    const ac = new AbortController();
    this._aborts.set(id, ac);
    const meta = this._metaFor(id);
    let phase = 'fetch';
    try {
      const clone = this._clonePath(repo);
      let fresh = false;
      if (update && isRealDir(path.join(clone, '.git'))) {
        await this._fetchReset(repo, ac.signal, () => {
          phase = 'reset';
        });
      } else {
        phase = 'clone';
        await this._cloneFresh(repo, ac.signal);
        fresh = true;
      }
      phase = 'scan';
      if (this._gone(id)) return;
      const commit = await this._headCommit(repo, ac.signal);
      if (this._gone(id)) return;
      const root = this._scanRootPath(repo);
      if (!root) throw userError(repo.subpath ? MSG.subpath(repo.subpath) : MSG.cloneMissing);
      const scan = scanRepo(root, { pluginName: repo.plugin, rootName: repo.subpath ? lastSegment(repo.subpath) : repo.repo });
      const previous = new Map(repo.items.map((i) => [i.key, i.enabled]));
      repo.items = scan.items.map((i) => ({ ...i, enabled: previous.has(i.key) ? previous.get(i.key) : true }));
      repo.kind = scan.kind;
      repo.commit = commit;
      repo.error = null;
      const now = Date.now();
      if (fresh || !repo.clonedAt) repo.clonedAt = now;
      repo.updatedAt = now;
      meta.scanWarnings = scan.warnings;
      meta.updateWarning = null;
      phase = 'build';
      // The status stays "cloning" / "updating" until the wrapper is in place.
      await this._syncWrapper(repo, { ready: true });
      if (this._gone(id)) return;
      if (repo.status !== 'error') repo.status = 'ready';
    } catch (err) {
      if (this._gone(id) || (err && err.code === 'ABORTED')) return;
      const message = (err && err.userMessage) || `Erreur inattendue : ${err && err.message}`;
      if (update && prevStatus === 'ready' && phase === 'fetch') {
        // The fetch failed before touching the clone: keep the working wrapper, just warn.
        repo.status = 'ready';
        repo.error = null;
        meta.updateWarning = MSG.updateFailed(message);
      } else {
        repo.status = 'error';
        repo.error = message;
      }
      try {
        await this._syncWrapper(repo);
      } catch {
        /* ignore */
      }
    } finally {
      if (this._aborts.get(id) === ac) this._aborts.delete(id);
    }
    if (!this._gone(id)) this._changed();
  }

  _checkGit(res, repo) {
    if (res.aborted) throw abortedError();
    if (res.code !== 0) throw userError(gitErrorMessage(res, repo.branch));
  }

  async _cloneFresh(repo, signal) {
    const dest = this._clonePath(repo);
    const tmp = path.join(this.reposDir, `${repo.id}.tmp-${randomSuffix()}`);
    const args = ['clone', '--depth', '1', '--single-branch', '--no-tags'];
    if (repo.branch) args.push('--branch', repo.branch);
    args.push('--', this._cloneUrl(repo), tmp);
    const guard = new AbortController();
    let tooBig = false;
    const poll = setInterval(() => {
      if (packSize(tmp) > this.maxCloneBytes) {
        tooBig = true;
        guard.abort();
      }
    }, 1000);
    let res;
    try {
      res = await this._runGit(args, { cwd: this.reposDir, signal: AbortSignal.any([signal, guard.signal]) });
    } finally {
      clearInterval(poll);
    }
    if (signal.aborted) {
      await rmrf(tmp);
      throw abortedError();
    }
    if (tooBig || (res.code === 0 && dirSizeExceeds(tmp, this.maxCloneBytes))) {
      await rmrf(tmp);
      throw userError(MSG.tooBig);
    }
    if (res.code !== 0 || res.aborted) {
      await rmrf(tmp);
      this._checkGit(res, repo);
    }
    if (!(await rmrf(dest))) {
      await rmrf(tmp);
      throw userError("Impossible de remplacer l'ancien clone (fichier verrouillé ?).");
    }
    await renameRetry(tmp, dest);
  }

  async _fetchReset(repo, signal, onReset) {
    const clone = this._clonePath(repo);
    const base = this._repoGitArgs(clone);
    let res = await this._runGit([...base, 'fetch', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', this._cloneUrl(repo), repo.branch || 'HEAD'], {
      cwd: clone,
      signal,
    });
    this._checkGit(res, repo);
    onReset();
    res = await this._runGit([...base, 'reset', '--hard', '-q', 'FETCH_HEAD'], { cwd: clone, signal });
    this._checkGit(res, repo);
  }

  async _headCommit(repo, signal) {
    const clone = this._clonePath(repo);
    const res = await this._runGit([...this._repoGitArgs(clone), 'rev-parse', 'HEAD'], { cwd: clone, signal, timeoutMs: 30000 });
    if (res.aborted) throw abortedError();
    const sha = String(res.stdout || '').trim();
    return res.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha.slice(0, 7) : null;
  }

  // ----- wrapper plugins (§5) --------------------------------------------------------------------

  _fingerprint(repo, included) {
    return sha1(
      JSON.stringify({
        v: BUILD_VERSION,
        plugin: repo.plugin,
        owner: repo.owner,
        repo: repo.repo,
        subpath: repo.subpath,
        commit: repo.commit,
        items: included.map((i) => [i.key, i.relPath, i.description]),
      })
    );
  }

  async _dropWrapper(repo) {
    const m = this._metaFor(repo.id);
    m.fingerprint = null;
    m.buildWarnings = [];
    this._wrappers.delete(repo.plugin);
    await rmrf(path.join(this.pluginDir, repo.plugin));
  }

  /**
   * Makes library/<plugin> match the repo state: built, kept (same fingerprint) or removed.
   * `ready` lets the clone / update job build before it publishes status "ready".
   */
  async _syncWrapper(repo, { ready = repo.status === 'ready' } = {}) {
    const meta = this._metaFor(repo.id);
    const target = path.join(this.pluginDir, repo.plugin);
    const included = () => repo.items.filter((i) => i.enabled && !i.error);
    if (!repo.enabled || !ready || included().length === 0) {
      await this._dropWrapper(repo);
      return;
    }
    if (meta.fingerprint === this._fingerprint(repo, included()) && isRealFile(path.join(target, '.claude-plugin', 'plugin.json'))) {
      this._wrappers.add(repo.plugin);
      return;
    }
    for (let round = 0; round < 3; round += 1) {
      const list = included();
      if (!list.length) {
        await this._dropWrapper(repo);
        return;
      }
      let built;
      try {
        built = await this._buildTmp(repo, list);
      } catch (err) {
        await this._failRepo(repo, MSG.buildFailed(err.userMessage || err.message));
        return;
      }
      const report = await this._validatePlugin(built.tmp);
      if (report && !report.success) {
        const flagged = report.manifestErrors.length ? 0 : this._flagInvalidItems(report, built.tmp, list);
        await rmrf(built.tmp);
        if (flagged > 0 && round < 2) continue;
        await this._failRepo(repo, MSG.pluginRefused(report.firstError || 'erreur inconnue'));
        return;
      }
      if (this._gone(repo.id)) {
        await rmrf(built.tmp);
        return;
      }
      await this._swapIn(built.tmp, target);
      this._wrappers.add(repo.plugin);
      meta.fingerprint = this._fingerprint(repo, list);
      meta.buildWarnings = [...built.warnings, ...(report ? report.warnings : [])];
      return;
    }
  }

  async _buildTmp(repo, included) {
    const srcRoot = this._scanRootPath(repo);
    if (!srcRoot) throw userError(repo.subpath ? MSG.subpath(repo.subpath) : MSG.cloneMissing);
    await fsp.mkdir(this.buildDir, { recursive: true });
    const tmp = path.join(this.buildDir, `${repo.plugin}-${randomSuffix()}`);
    try {
      await fsp.mkdir(path.join(tmp, '.claude-plugin'), { recursive: true });
      const manifest = {
        name: repo.plugin,
        description: `Skills et agents du dépôt ${repo.owner}/${repo.repo} ${WRAPPER_SIGNATURE}`,
        version: '1.0.0',
        author: { name: repo.owner },
      };
      await fsp.writeFile(path.join(tmp, '.claude-plugin', 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      const warnings = [];
      for (const item of included) {
        try {
          if (item.type === 'skill') await this._copySkill(srcRoot, item, tmp);
          else await this._copyMarkdown(srcRoot, item, tmp);
        } catch (err) {
          await rmrf(item.type === 'skill' ? path.join(tmp, 'skills', item.name) : path.join(tmp, TYPE_DIR[item.type], `${item.name}.md`));
          warnings.push(`${TYPE_LABEL[item.type]} « ${item.name} » non chargé : ${err.userMessage || 'fichier illisible'}.`);
        }
      }
      return { tmp, warnings };
    } catch (err) {
      await rmrf(tmp);
      throw err;
    }
  }

  async _copySkill(srcRoot, item, tmp) {
    const src = resolveInside(srcRoot, item.relPath);
    if (!src || !isRealDir(src)) throw userError('dossier introuvable');
    const dest = path.join(tmp, 'skills', item.name);
    await copyTree(src, dest, { bytes: 0, files: 0 });
    const main = (await fsp.readdir(dest)).find((n) => n.toLowerCase() === 'skill.md');
    if (!main) throw userError('SKILL.md introuvable');
    const mainPath = path.join(dest, main);
    const st = await fsp.stat(mainPath);
    if (st.size > MAX_PARSE_BYTES) throw userError('SKILL.md de plus de 1 Mo');
    const text = await fsp.readFile(mainPath, 'utf8');
    const out = prepareMarkdown(text, { name: item.name, description: item.description });
    if (main !== 'SKILL.md') await fsp.unlink(mainPath);
    await fsp.writeFile(path.join(dest, 'SKILL.md'), out, 'utf8');
  }

  async _copyMarkdown(srcRoot, item, tmp) {
    const src = resolveInside(srcRoot, item.relPath);
    if (!src || !isRealFile(src)) throw userError('fichier introuvable');
    const st = await fsp.stat(src);
    if (st.size > MAX_PARSE_BYTES) throw userError('fichier de plus de 1 Mo');
    const text = await fsp.readFile(src, 'utf8');
    const out = prepareMarkdown(text, { name: item.type === 'agent' ? item.name : null });
    const dir = path.join(tmp, TYPE_DIR[item.type]);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${item.name}.md`), out, 'utf8');
  }

  async _swapIn(tmp, target) {
    let trash = null;
    if (lstatSafe(target)) {
      trash = path.join(this.buildDir, `trash-${randomSuffix()}`);
      try {
        await renameRetry(target, trash);
      } catch {
        trash = null;
        await rmrf(target);
      }
    }
    await renameRetry(tmp, target);
    if (trash) await rmrf(trash);
  }

  /** Runs `claude plugin validate <dir> --json`; null when skipped / unusable. */
  async _validatePlugin(dir) {
    if (!this.validate || !this.claudeBin || this._closed) return null;
    const res = await this._exec(this.claudeBin.command, [...(this.claudeBin.prefixArgs || []), 'plugin', 'validate', dir, '--json'], {
      cwd: this.home,
      timeoutMs: this.validateTimeoutMs,
    });
    if (res.timedOut || res.aborted) return null;
    const out = String(res.stdout || '');
    const start = out.indexOf('{');
    const end = out.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    let json;
    try {
      json = JSON.parse(out.slice(start, end + 1));
    } catch {
      return null;
    }
    if (!json || typeof json !== 'object' || typeof json.success !== 'boolean') return null;
    const msgOf = (e) => clip(typeof e === 'string' ? e : e && typeof e.message === 'string' ? e.message : JSON.stringify(e), 300);
    const manifest = json.manifest && typeof json.manifest === 'object' ? json.manifest : {};
    const manifestErrors = (Array.isArray(manifest.errors) ? manifest.errors : []).map(msgOf);
    const relOf = (file) => {
      if (typeof file !== 'string') return '?';
      const r = path.relative(dir, file);
      return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : path.basename(file);
    };
    const contentErrors = [];
    const warnings = (Array.isArray(manifest.warnings) ? manifest.warnings : []).map((w) => MSG.validationWarning('plugin.json', msgOf(w)));
    for (const c of Array.isArray(json.contents) ? json.contents : []) {
      if (!c || typeof c !== 'object') continue;
      for (const e of Array.isArray(c.errors) ? c.errors : []) contentErrors.push({ file: c.file, rel: relOf(c.file), message: msgOf(e) });
      for (const w of Array.isArray(c.warnings) ? c.warnings : []) warnings.push(MSG.validationWarning(relOf(c.file), msgOf(w)));
    }
    let shown = warnings;
    if (warnings.length > MAX_VALIDATION_WARNINGS) {
      shown = [...warnings.slice(0, MAX_VALIDATION_WARNINGS), MSG.moreValidationWarnings(warnings.length - MAX_VALIDATION_WARNINGS)];
    }
    const firstError = manifestErrors[0] || (contentErrors[0] ? `${contentErrors[0].rel} : ${contentErrors[0].message}` : null);
    return { success: json.success, manifestErrors, contentErrors, warnings: shown, firstError };
  }

  _flagInvalidItems(report, tmp, included) {
    let flagged = 0;
    for (const e of report.contentErrors) {
      const segs = String(e.rel || '').split('/');
      const type = ITEM_TYPES.find((t) => TYPE_DIR[t] === segs[0]);
      if (!type || segs.length < 2) continue;
      const name = type === 'skill' ? segs[1] : segs[1].replace(/\.md$/i, '');
      const item = included.find((i) => i.type === type && i.name === name);
      if (item && !item.error) {
        item.error = MSG.fileRefused(clip(e.message, 200));
        flagged += 1;
      }
    }
    return flagged;
  }
}

module.exports = { Library, parseRepoInput, scanRepo, parseFrontmatter, normalizeName };
