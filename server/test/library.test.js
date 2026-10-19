'use strict';

// Tests for server/library.js (docs/LIBRARY.md). Everything happens in temp folders: the real
// ~/.pixelqg is never touched. Git runs hidden against LOCAL fixture repos (file:// base URL) or
// a local TCP server that never answers (to exercise timeouts / kills). The real claude binary is
// only used for `claude plugin validate --json` (skipped when claude is not installed).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const { Library, parseRepoInput, scanRepo, parseFrontmatter, normalizeName } = require('../library');
const { resolveClaude } = require('../claude-bin');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelqg-app-library-'));
test.after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

let tmpCounter = 0;
function tmp(name = 'd') {
  tmpCounter += 1;
  const dir = path.join(TMP_ROOT, `${name}-${tmpCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
}

const MSG_INVALID = 'Lien GitHub invalide. Exemple : anthropics/skills ou https://github.com/anthropics/skills';
const MSG_NOGIT = "Git n'est pas installé. Installe-le depuis https://git-scm.com";
const MSG_NOTFOUND = 'Dépôt introuvable ou privé (seuls les dépôts publics sont pris en charge)';
const MSG_HOOKS = 'Ce dépôt contient des hooks (commandes automatiques) : ignorés pour ta sécurité.';
const MSG_MCP = 'Ce dépôt contient des serveurs MCP : ignorés pour ta sécurité.';

// ---------------------------------------------------------------------------------------------
// Git fixtures (hidden, never prompting)

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_ASKPASS: '',
  SSH_ASKPASS: '',
  GIT_AUTHOR_NAME: 'HQ Test',
  GIT_AUTHOR_EMAIL: 'hq-test@example.invalid',
  GIT_COMMITTER_NAME: 'HQ Test',
  GIT_COMMITTER_EMAIL: 'hq-test@example.invalid',
};
const GIT_AVAILABLE = (() => {
  try {
    return spawnSync('git', ['--version'], { windowsHide: true, encoding: 'utf8', timeout: 15000 }).status === 0;
  } catch {
    return false;
  }
})();
const CLAUDE = (() => {
  try {
    return resolveClaude();
  } catch {
    return null;
  }
})();

function git(cwd, ...args) {
  const r = spawnSync(
    'git',
    [
      '-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'init.defaultBranch=main', '-c', 'core.autocrlf=false',
      '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false',
      ...args,
    ],
    { cwd, env: GIT_ENV, windowsHide: true, encoding: 'utf8', timeout: 30000 }
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function makeSourceRepo(base, owner, repo, files) {
  const dir = path.join(base, owner, `${repo}.git`);
  fs.mkdirSync(dir, { recursive: true });
  writeTree(dir, files);
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

function commitAll(dir, message) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

function waitFor(lib, pred, ms = 60000) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      lib.off('change', check);
    };
    function check() {
      const state = lib.get();
      let ok = false;
      try {
        ok = pred(state);
      } catch {
        ok = false;
      }
      if (ok) {
        cleanup();
        resolve(state);
      }
      return ok;
    }
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout: ${JSON.stringify(lib.get().repos.map((r) => [r.id, r.status, r.error]))}`));
    }, ms);
    lib.on('change', check);
    check();
  });
}

const repoOf = (state, id) => state.repos.find((r) => r.id === id);

/**
 * Records violations of "a repo only becomes ready once its wrapper plugin is in place"
 * (checked synchronously on every change event).
 */
function watchReadyInvariant(lib) {
  const previous = new Map();
  const violations = [];
  lib.on('change', (s) => {
    for (const r of s.repos) {
      const before = previous.get(r.id);
      previous.set(r.id, r.status);
      if (r.status !== 'ready' || (before !== 'cloning' && before !== 'updating')) continue;
      if (!r.enabled || !r.items.some((i) => i.enabled && !i.error)) continue;
      if (!fs.existsSync(path.join(s.pluginDir, r.plugin, '.claude-plugin', 'plugin.json'))) violations.push(`${r.id} ready without wrapper`);
    }
  });
  return violations;
}
const settled = (id) => (s) => {
  const r = repoOf(s, id);
  return !!r && (r.status === 'ready' || r.status === 'error');
};

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** A TCP server that accepts connections and never answers (git hangs on it). */
async function hangingServer() {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// parseRepoInput

test('parseRepoInput: every accepted form', () => {
  const base = {
    owner: 'anthropics',
    repo: 'skills',
    branch: null,
    subpath: null,
    url: 'https://github.com/anthropics/skills',
    id: 'anthropics__skills',
    plugin: 'skills', // "anthropics-…" is a name Claude Code reserves: brand segments are dropped
  };
  const same = [
    'anthropics/skills',
    '  anthropics/skills  ',
    '\tanthropics/skills\n',
    'anthropics/skills.git',
    'anthropics/skills/',
    'https://github.com/anthropics/skills',
    'https://github.com/anthropics/skills.git',
    'https://github.com/anthropics/skills/',
    'http://github.com/anthropics/skills',
    'https://www.github.com/anthropics/skills',
    'github.com/anthropics/skills',
    'HTTPS://GitHub.com/anthropics/skills',
    'https://github.com/anthropics/skills#readme',
    'https://github.com/anthropics/skills?tab=readme-ov-file',
    'git@github.com:anthropics/skills.git',
    'git@github.com:anthropics/skills',
  ];
  for (const input of same) assert.deepEqual(parseRepoInput(input), base, input);

  assert.deepEqual(parseRepoInput('https://github.com/anthropics/skills/tree/main'), {
    ...base,
    branch: 'main',
    url: 'https://github.com/anthropics/skills/tree/main',
    id: 'anthropics__skills__main',
  });
  assert.deepEqual(parseRepoInput('https://github.com/anthropics/skills/tree/main/skills/pdf/'), {
    ...base,
    branch: 'main',
    subpath: 'skills/pdf',
    url: 'https://github.com/anthropics/skills/tree/main/skills/pdf',
    id: 'anthropics__skills__main__skills-pdf',
  });
  const spaced = parseRepoInput('https://github.com/acme/kit/tree/v1.2.0/My%20Folder/sub');
  assert.equal(spaced.branch, 'v1.2.0');
  assert.equal(spaced.subpath, 'My Folder/sub');
  assert.equal(spaced.url, 'https://github.com/acme/kit/tree/v1.2.0/My%20Folder/sub');
  assert.equal(spaced.id, 'acme__kit__v1.2.0__my-folder-sub');
  assert.equal(parseRepoInput('https://github.com/acme/kit/tree/feature_x-2/My Folder').subpath, 'My Folder');

  const volt = parseRepoInput('VoltAgent/awesome-claude-code-subagents');
  assert.equal(volt.id, 'voltagent__awesome-claude-code-subagents');
  assert.equal(volt.plugin, 'voltagent-awesome-code-subagents');
  assert.equal(volt.owner, 'VoltAgent');
  assert.equal(parseRepoInput('wshobson/agents').plugin, 'wshobson-agents');
  assert.deepEqual(
    (({ id, plugin }) => ({ id, plugin }))(parseRepoInput('Some-Org/Repo_Name.js')),
    { id: 'some-org__repo_name.js', plugin: 'some-org-repo-name-js' }
  );
  assert.equal(parseRepoInput('acme/.github').plugin, 'acme-github');

  // Wrapper plugin names never trip Claude Code's reserved-name rules (claude-*, anthropic(s)-*,
  // cc-plugin-*, "official" beside claude/anthropic) nor its "reads as Anthropic's own" warning.
  const plugins = {
    'anthropics/claude-cookbooks': 'cookbooks',
    'claude/claude-code': 'code',
    'anthropic/claude': 'depot',
    'cc-plugin/x': 'hq-cc-plugin-x',
    'official/claude-kit': 'official-kit',
    'Claude-Official/kit': 'official-kit',
    'acme/claudette': 'acme-claudette',
    'anthropics/skills': 'skills',
  };
  for (const [input, plugin] of Object.entries(plugins)) assert.equal(parseRepoInput(input).plugin, plugin, input);
  for (const input of ['anthropics/skills', 'claude/x', 'x/anthropic-tools', 'a/claude-official', `claude/${'claude-'.repeat(13)}x`]) {
    const { plugin } = parseRepoInput(input);
    assert.ok(/^[a-z0-9][a-z0-9-]{0,39}$/.test(plugin) && !plugin.endsWith('-'), plugin);
    assert.ok(!/^(claude|anthropics?|cc-plugin)-/.test(plugin) && !plugin.split('-').some((s) => /^(claude|anthropics?)$/.test(s)), plugin);
  }

  const long = parseRepoInput(`${'a'.repeat(39)}/${'b'.repeat(100)}`);
  assert.ok(long.plugin.length <= 40 && /^[a-z0-9][a-z0-9-]*$/.test(long.plugin) && !long.plugin.endsWith('-'));
  assert.ok(long.id.length <= 100 && /^[a-z0-9][a-z0-9._-]*$/.test(long.id));
  const deep = parseRepoInput(`https://github.com/acme/kit/tree/${'b'.repeat(100)}/${Array(10).fill('d'.repeat(30)).join('/')}`);
  assert.ok(deep.id.length <= 100, deep.id);
});

test('parseRepoInput: rejects other hosts, git option injection, traversal and unicode tricks', () => {
  const bad = [
    '', '   ', null, undefined, 42, {}, ['anthropics/skills'],
    'anthropics', 'anthropics/', '/skills', 'anthropics/skills/extra', 'anthropics//skills',
    'https://gitlab.com/anthropics/skills', 'https://github.com.evil.com/anthropics/skills',
    'https://evil.com/github.com/anthropics/skills', 'https://user@github.com/anthropics/skills',
    'https://github.com:443/anthropics/skills', 'https://raw.githubusercontent.com/anthropics/skills/main/x',
    'ftp://github.com/anthropics/skills', 'file:///etc/passwd', 'file://github.com/anthropics/skills',
    'file:///C:/Users/x/repo', 'ext::sh -c touch% /tmp/pwned', 'ext::sh', 'ssh://git@github.com/anthropics/skills.git',
    'git://github.com/anthropics/skills.git', 'git@evil.com:anthropics/skills.git', 'git@github.com:../x.git',
    '--upload-pack=touch /tmp/x', '--upload-pack=evil/x', 'anthropics/skills --upload-pack=evil',
    '-oProxyCommand=evil/x', '-rf/skills', '-anthropics/skills', 'anthropics/-skills', 'anthropics/--upload-pack=x',
    'https://github.com/-anthropics/skills', 'https://github.com/anthropics/-skills',
    'https://github.com/anthropics/skills/tree/-x', 'https://github.com/anthropics/skills/tree/--orphan',
    'https://github.com/anthropics/skills/tree/..', 'https://github.com/anthropics/skills/tree/a..b',
    'https://github.com/anthropics/skills/tree/main.lock', 'https://github.com/anthropics/skills/tree/.hidden',
    'https://github.com/anthropics/skills/tree/main.', 'https://github.com/anthropics/skills/tree/HEAD',
    'https://github.com/anthropics/skills/tree/feature%2Fx', 'https://github.com/anthropics/skills/tree/%2D%2Dx',
    'https://github.com/anthropics/skills/tree/main/../../etc', 'https://github.com/anthropics/skills/tree/main/skills/..',
    'https://github.com/anthropics/skills/tree/main/%2e%2e/x', 'https://github.com/anthropics/skills/tree/main/a%2Fb',
    'https://github.com/anthropics/skills/tree/main/a%5Cb', 'https://github.com/anthropics/skills/tree/main/a..',
    'https://github.com/anthropics/skills/tree/main/./x', 'https://github.com/anthropics/skills/tree/main/x /y',
    'https://github.com/anthropics/skills/tree/main/ x', 'https://github.com/anthropics/skills/tree/main/x.',
    'https://github.com/anthropics/skills/tree/main//x', 'https://github.com/anthropics/skills/tree/main/a:b',
    'https://github.com/anthropics/skills/tree/main/%E2%80%AEx', 'https://github.com/anthropics/skills/tree/main/%zz',
    `https://github.com/anthropics/skills/tree/main/${Array(11).fill('d').join('/')}`,
    'https://github.com/anthropics/skills/blob/main/README.md', 'https://github.com/anthropics/skills/tree',
    'https://github.com/anthropics/skills/issues', 'https://github.com/anthropics',
    'anthropics\\skills', 'https://github.com\\anthropics\\skills', 'C:\\Users\\x\\repo', '..\\..\\repo',
    'anthropics /skills', 'anthropics/ski lls', 'anthro\npics/skills', 'anthropics/sk\u0000ills', 'anthropics/skills\u007f',
    'anthr\u200bopics/skills', '\u0430nthropics/skills', 'anthropics\uff0fskills', '\uff41nthropics/skills',
    'https://g\u0456thub.com/anthropics/skills', 'anthropics/skills\u202e', 'anthropics/sk\u00efll\u00e9s',
    `${'a'.repeat(40)}/x`, `x/${'r'.repeat(101)}`, `https://github.com/a/b/tree/${'c'.repeat(101)}`,
    `https://github.com/a/b/tree/main/${'x/'.repeat(300)}`, 'x'.repeat(10000), `${'a/'.repeat(5000)}b`,
    'owner/.', 'owner/..', 'owner/...', 'owner/repo.', 'owner/.git', '../repo', './repo', '~/repo',
    'javascript:alert(1)', '<script>/x', 'owner/repo;rm -rf', 'owner/$(id)', 'owner/`id`', 'owner/repo|x',
    'owner/repo&x', 'owner/repo%00', 'own%2Fer/repo', 'https://github.com/own%2Fer/repo',
  ];
  for (const input of bad) {
    assert.throws(
      () => parseRepoInput(input),
      (err) => err instanceof Error && err.status === 400 && err.message === MSG_INVALID,
      `should reject ${JSON.stringify(typeof input === 'string' ? input.slice(0, 80) : input)}`
    );
  }
});

// ---------------------------------------------------------------------------------------------
// parseFrontmatter / normalizeName

test('parseFrontmatter: scalars, quotes, comments and colons', () => {
  const text = [
    '---',
    'name: pdf',
    'description: "Handles \\"PDF\\" files: extract, merge"',
    "single: 'It''s fine'",
    'tools: [Read, Grep, "Bash(git:*)"]',
    'empty:',
    'model: haiku # a comment',
    'url: https://example.com/#anchor',
    'colon: Use when: something happens',
    'escapes: "tab\\there \\u00e9 \\x41"',
    'long: This is a long',
    '  description continuing here',
    'next:',
    '  Text on the next line',
    '  and more',
    'multi: "first',
    '  second"',
    '"quoted key": yes',
    '# a comment line',
    '---',
    '# Body',
    '',
  ].join('\n');
  const { data, body } = parseFrontmatter(text);
  assert.deepEqual(data, {
    name: 'pdf',
    description: 'Handles "PDF" files: extract, merge',
    single: "It's fine",
    tools: ['Read', 'Grep', 'Bash(git:*)'],
    empty: '',
    model: 'haiku',
    url: 'https://example.com/#anchor',
    colon: 'Use when: something happens',
    escapes: 'tab\there é A',
    long: 'This is a long description continuing here',
    next: 'Text on the next line and more',
    multi: 'first second',
    'quoted key': 'yes',
  });
  assert.equal(body, '# Body\n');
});

test('parseFrontmatter: block scalars, lists and nested maps', () => {
  const text = [
    '---',
    'literal: |',
    '  line one',
    '  line two',
    'folded: >',
    '  folded one',
    '  folded two',
    '',
    '  new para',
    'strip: |-',
    '  keep',
    'keepall: |+',
    '  kept',
    '',
    'indented: |2',
    '    four spaces',
    'tools:',
    '  - Read',
    '  - "Grep"',
    "  - 'Bash'",
    'skills:',
    '- one',
    '- two',
    'meta:',
    '  version: 2',
    '  nested:',
    '    deep: x',
    'after: yes',
    '---',
    'body',
  ].join('\n');
  const { data, body } = parseFrontmatter(text);
  assert.deepEqual(data, {
    literal: 'line one\nline two\n',
    folded: 'folded one folded two\nnew para\n',
    strip: 'keep',
    keepall: 'kept\n\n',
    indented: '  four spaces\n',
    tools: ['Read', 'Grep', 'Bash'],
    skills: ['one', 'two'],
    meta: { version: '2', nested: { deep: 'x' } },
    after: 'yes',
  });
  assert.equal(body, 'body');
});

test('parseFrontmatter: CRLF, BOM, missing / unterminated frontmatter, never throws', () => {
  assert.deepEqual(parseFrontmatter('\uFEFF---\r\nname: crlf\r\ndescription: Windows line endings\r\n---\r\nBody line\r\n'), {
    data: { name: 'crlf', description: 'Windows line endings' },
    body: 'Body line\n',
  });
  assert.deepEqual(parseFrontmatter('Just text\n'), { data: {}, body: 'Just text\n' });
  assert.deepEqual(parseFrontmatter('---\nname: x\nno end\n'), { data: {}, body: '---\nname: x\nno end\n' });
  assert.deepEqual(parseFrontmatter('\n---\nname: x\n---\n'), { data: {}, body: '\n---\nname: x\n---\n' });
  assert.deepEqual(parseFrontmatter('---\n---\nbody'), { data: {}, body: 'body' });
  assert.deepEqual(parseFrontmatter('---\nname: dots\n...\nbody'), { data: { name: 'dots' }, body: 'body' });

  // Broken YAML: still no exception, keeps what it can.
  assert.deepEqual(parseFrontmatter('---\nname: x\ndescription: "unterminated\ntools: Read\n---\n').data, {
    name: 'x',
    description: 'unterminated',
    tools: 'Read',
  });
  assert.deepEqual(parseFrontmatter('---\nhint: [a, [b, c\nother: 1\n---\n').data, { hint: '[a, [b, c', other: '1' });
  assert.deepEqual(parseFrontmatter('---\n__proto__: polluted\nconstructor: x\nprototype: y\nok: 1\n---\n').data, { ok: '1' });
  assert.equal({}.polluted, undefined);
  for (const weird of [null, undefined, 42, {}, [], '---', '---\n: : :\n[[[\n---\n', '---\n\t- a\n  -\n---', '---\nk: |9\n---', '---\nk: "\\uZZZZ \\U0011FFFF"\n---']) {
    const res = parseFrontmatter(weird);
    assert.equal(typeof res, 'object');
    assert.equal(typeof res.data, 'object');
    assert.equal(typeof res.body, 'string');
  }
  const huge = `---\n${'k: v\n'.repeat(5000)}---\nbody`;
  assert.doesNotThrow(() => parseFrontmatter(huge));
});

test('normalizeName', () => {
  assert.equal(normalizeName('pdf'), 'pdf');
  assert.equal(normalizeName('PDF Tools'), 'pdf-tools');
  assert.equal(normalizeName('Résumé Fichier'), 'resume-fichier');
  assert.equal(normalizeName('  --Hello__World--  '), 'hello-world');
  assert.equal(normalizeName('code-reviewer'), 'code-reviewer');
  assert.equal(normalizeName('Ünïcödé'), 'unicode');
  assert.equal(normalizeName('a'.repeat(100)), 'a'.repeat(64));
  assert.equal(normalizeName(`${'x'.repeat(63)}-y`), 'x'.repeat(63));
  assert.equal(normalizeName('日本語'), null);
  assert.equal(normalizeName('---'), null);
  assert.equal(normalizeName(''), null);
  assert.equal(normalizeName(null), null);
  assert.equal(normalizeName(123), null);
  assert.equal(normalizeName({}), null);
});

// ---------------------------------------------------------------------------------------------
// scanRepo

const AGENT = (name, description, extra = '') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\nTu es ${name}.\n`;

test('scanRepo: loose repo with skills, agents, commands; docs ignored', () => {
  const dir = tmp('loose');
  writeTree(dir, {
    'README.md': AGENT('readme-agent', 'Should be ignored', 'tools: Read\n'),
    'CHANGELOG.md': AGENT('changelog', 'Ignored', 'model: haiku\n'),
    'CLAUDE.md': AGENT('claude', 'Ignored', 'model: haiku\n'),
    'LICENSE.md': 'MIT',
    'docs/guide.md': '# Guide\n',
    'docs/notes.md': AGENT('notes', 'No tools/model/color and not under agents'),
    'skills/pdf/SKILL.md': '---\nname: pdf\ndescription: Manipule des fichiers PDF.\nallowed-tools: [Read, Bash]\n---\n# PDF\n',
    'skills/pdf/reference.md': AGENT('inside-skill', 'Supporting file, not an agent', 'tools: Read\n'),
    'skills/pdf/scripts/extract.py': 'print("hi")\n',
    'skills/Résumé Fichier/SKILL.md': '# Titre\n\nRésume un fichier en trois phrases.\n\nDétails.\n',
    'skills/nested/SKILL.md': '---\ndescription: Outer skill\n---\n',
    'skills/nested/inner/SKILL.md': '---\nname: inner\ndescription: Inner skill is a supporting file\n---\n',
    'agents/relecteur-fr.md': AGENT('Relecteur FR', 'Relit les textes en français', 'tools: Read, Grep\nmodel: haiku\n'),
    'agents/no-desc.md': '---\nname: no-desc\n---\n',
    'agents/README.md': AGENT('agents-readme', 'Ignored'),
    'agents/plain.md': 'No frontmatter at all\n',
    'misc/standalone-agent.md': AGENT('standalone-agent', 'Detected through its color key', 'color: blue\n'),
    '.claude/agents/hidden-agent.md': AGENT('hidden-agent', 'Lives under .claude/agents'),
    'commands/hello.md': '---\ndescription: Dit bonjour\n---\nDis bonjour à $ARGUMENTS\n',
    'commands/git/commit.md': '---\nallowed-tools: Bash(git:*)\n---\nCrée un commit.\n',
    'commands/plain.md': 'No frontmatter: not a command\n',
    'node_modules/pkg/agents/x.md': AGENT('node-module-agent', 'Never scanned'),
    'agents/tools-list.md': '---\nname: tools-list\ndescription: Tools as a YAML list\ntools:\n  - Read\n  - Write\n---\n',
  });
  const res = scanRepo(dir, { pluginName: 'demo' });
  assert.equal(res.kind, 'loose');
  assert.deepEqual(res.warnings, []);
  assert.deepEqual(
    res.items.map((i) => i.key),
    [
      'agent:hidden-agent',
      'agent:relecteur-fr',
      'agent:tools-list',
      'command:hello',
      'command:commit',
      'agent:standalone-agent',
      'skill:resume-fichier',
      'skill:nested',
      'skill:pdf',
    ]
  );
  const byKey = Object.fromEntries(res.items.map((i) => [i.key, i]));
  assert.deepEqual(byKey['skill:pdf'], {
    key: 'skill:pdf',
    type: 'skill',
    name: 'pdf',
    fullName: 'demo:pdf',
    description: 'Manipule des fichiers PDF.',
    relPath: 'skills/pdf',
    enabled: true,
    group: null,
    tools: 'Read, Bash',
    model: null,
    error: null,
  });
  assert.equal(byKey['skill:resume-fichier'].description, 'Résume un fichier en trois phrases.');
  assert.equal(byKey['skill:resume-fichier'].relPath, 'skills/Résumé Fichier');
  assert.equal(byKey['skill:nested'].relPath, 'skills/nested');
  assert.equal(byKey['skill:nested'].description, 'Outer skill');
  assert.equal(byKey['agent:relecteur-fr'].tools, 'Read, Grep');
  assert.equal(byKey['agent:relecteur-fr'].model, 'haiku');
  assert.equal(byKey['agent:relecteur-fr'].fullName, 'demo:relecteur-fr');
  assert.equal(byKey['agent:relecteur-fr'].relPath, 'agents/relecteur-fr.md');
  assert.equal(byKey['agent:tools-list'].tools, 'Read, Write');
  assert.equal(byKey['command:commit'].relPath, 'commands/git/commit.md');
  assert.equal(byKey['command:commit'].description, 'Crée un commit.');
  assert.equal(byKey['command:commit'].tools, 'Bash(git:*)');
  assert.equal(byKey['agent:hidden-agent'].relPath, '.claude/agents/hidden-agent.md');

  // Without pluginName, fullName is the bare name; a missing folder is reported, never thrown.
  assert.equal(scanRepo(dir).items[0].fullName, 'hidden-agent');
  assert.deepEqual(scanRepo(path.join(dir, 'nope')), { kind: 'loose', items: [], warnings: ['Dossier introuvable dans ce dépôt.'] });
  const empty = tmp('empty');
  assert.deepEqual(scanRepo(empty).warnings, ['Aucun skill, agent ni commande trouvé dans ce dépôt.']);
});

test('scanRepo: a skill at the scan root (linked sub-folder)', () => {
  const dir = tmp('rootskill');
  writeTree(dir, {
    'SKILL.md': 'Sans frontmatter.\n',
    'agents/helper.md': AGENT('helper', 'Inside the skill folder, so a supporting file', 'tools: Read\n'),
    'docs/x.md': 'x',
  });
  const res = scanRepo(dir, { pluginName: 'p', rootName: 'Mon Skill' });
  assert.deepEqual(res.items.map((i) => [i.key, i.relPath, i.description]), [['skill:mon-skill', '.', 'Sans frontmatter.']]);
  const named = tmp('rootskill2');
  writeTree(named, { 'SKILL.md': '---\nname: Named\ndescription: d\n---\n' });
  assert.equal(scanRepo(named).items[0].name, 'named');
});

test('scanRepo: plugin repo with hooks, MCP and LSP servers (warnings, nothing copied)', () => {
  const dir = tmp('plugin');
  writeTree(dir, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo-plugin', hooks: './hooks/hooks.json', mcpServers: { x: { command: 'evil' } } }),
    'hooks/hooks.json': JSON.stringify({ hooks: { PreToolUse: [] } }),
    '.mcp.json': JSON.stringify({ mcpServers: { evil: { command: 'rm' } } }),
    '.lsp.json': '{}',
    'output-styles/style.md': '---\nname: style\ndescription: x\n---\n',
    'agents/a.md': AGENT('a', 'Agent A'),
    'skills/s/SKILL.md': '---\nname: s\ndescription: Skill S\n---\n',
    'commands/c.md': '---\ndescription: Command C\n---\n',
  });
  const res = scanRepo(dir, { pluginName: 'p' });
  assert.equal(res.kind, 'plugin');
  assert.deepEqual(res.items.map((i) => [i.key, i.group]), [['agent:a', null], ['command:c', null], ['skill:s', null]]);
  assert.deepEqual(res.warnings, [MSG_HOOKS, MSG_MCP, 'Ce dépôt contient des serveurs LSP ou des styles de sortie : non chargés.']);

  const settingsHooks = tmp('settingshooks');
  writeTree(settingsHooks, {
    '.claude/settings.json': JSON.stringify({ hooks: { Stop: [] } }),
    '.claude/agents/x.md': AGENT('x', 'X'),
  });
  assert.deepEqual(scanRepo(settingsHooks).warnings, [MSG_HOOKS]);
});

test('scanRepo: marketplace with several plugins gets groups', () => {
  const dir = tmp('market');
  writeTree(dir, {
    '.claude-plugin/marketplace.json': JSON.stringify({
      name: 'market',
      plugins: [
        { name: 'document-skills', source: './', strict: false, skills: ['./skills/xlsx', './skills/docx'] },
        { name: 'example-skills', source: './', strict: false, skills: ['./skills/art'] },
        { name: 'devops', source: './plugins/devops' },
        { name: 'remote', source: { source: 'github', repo: 'someone/else' } },
        { name: 'with-hooks', source: './plugins/with-hooks', hooks: { Stop: [] } },
        { name: 'evil', source: '../../outside', skills: ['../../x'] },
      ],
    }),
    'skills/xlsx/SKILL.md': '---\nname: xlsx\ndescription: Excel\n---\n',
    'skills/docx/SKILL.md': '---\nname: docx\ndescription: Word\n---\n',
    'skills/art/SKILL.md': '---\nname: art\ndescription: Art\n---\n',
    'skills/unlisted/SKILL.md': '---\nname: unlisted\ndescription: Not in any plugin\n---\n',
    'plugins/devops/agents/deployer.md': AGENT('deployer', 'Deploys'),
    'plugins/devops/commands/deploy.md': '---\ndescription: Deploy\n---\n',
    'plugins/with-hooks/agents/hooked.md': AGENT('hooked', 'Has hooks next to it'),
    'plugins/standalone/.claude-plugin/plugin.json': JSON.stringify({ name: 'Standalone Kit' }),
    'plugins/standalone/agents/solo.md': AGENT('solo', 'Solo'),
  });
  const res = scanRepo(dir, { pluginName: 'mk' });
  assert.equal(res.kind, 'marketplace');
  const groups = Object.fromEntries(res.items.map((i) => [i.key, i.group]));
  assert.deepEqual(groups, {
    'agent:deployer': 'devops',
    'command:deploy': 'devops',
    'agent:solo': 'standalone-kit',
    'agent:hooked': 'with-hooks',
    'skill:art': 'example-skills',
    'skill:docx': 'document-skills',
    'skill:unlisted': null,
    'skill:xlsx': 'document-skills',
  });
  assert.deepEqual(res.warnings, [MSG_HOOKS, 'Ce catalogue référence 1 plugin(s) hébergé(s) ailleurs : non chargé(s).']);
});

test('scanRepo: name collisions get -2, -3 per type', () => {
  const dir = tmp('collide');
  writeTree(dir, {
    'agents/review.md': AGENT('Code Reviewer', 'First'),
    'team/agents/review.md': AGENT('code-reviewer', 'Third in walk order'),
    'more/agents/x.md': AGENT('CODE REVIEWER!!', 'Second in walk order'),
    'skills/review/SKILL.md': '---\nname: code-reviewer\ndescription: Skill namespace is separate\n---\n',
    'commands/code-reviewer.md': '---\ndescription: Command namespace is separate\n---\n',
    'long/agents/one.md': AGENT('a'.repeat(70), 'Long 1'),
    'long/agents/two.md': AGENT('a'.repeat(70), 'Long 2'),
  });
  const res = scanRepo(dir);
  const keyed = res.items.map((i) => [i.key, i.description]);
  assert.deepEqual(keyed, [
    ['agent:code-reviewer', 'First'],
    ['command:code-reviewer', 'Command namespace is separate'],
    [`agent:${'a'.repeat(64)}`, 'Long 1'],
    [`agent:${'a'.repeat(62)}-2`, 'Long 2'],
    ['agent:code-reviewer-2', 'Second in walk order'],
    ['skill:code-reviewer', 'Skill namespace is separate'],
    ['agent:code-reviewer-3', 'Third in walk order'],
  ]);
  for (const it of res.items) assert.match(it.name, /^[a-z0-9][a-z0-9-]{0,63}$/);
});

test('scanRepo: symlinks and junctions are never followed', (t) => {
  const outside = tmp('outside');
  writeTree(outside, {
    'agents/evil.md': AGENT('evil', 'Outside the repo'),
    'skills/evil/SKILL.md': '---\nname: evil\ndescription: Outside\n---\n',
    'secret.md': AGENT('secret', 'Outside', 'tools: Read\n'),
  });
  const dir = tmp('links');
  writeTree(dir, { 'agents/good.md': AGENT('good', 'Inside') });
  fs.symlinkSync(outside, path.join(dir, 'linked'), 'junction');
  let fileLink = true;
  try {
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(dir, 'agents', 'link.md'), 'file');
  } catch {
    fileLink = false; // creating file symlinks needs privileges on Windows
  }
  const res = scanRepo(dir);
  assert.deepEqual(res.items.map((i) => i.key), ['agent:good']);
  assert.deepEqual(res.warnings, [`${fileLink ? 2 : 1} lien(s) symbolique(s) ignoré(s) pour ta sécurité.`]);
  if (!fileLink) t.diagnostic('file symlink not created (no privilege): junction only');
  // A junction as the scan root itself is refused.
  assert.deepEqual(scanRepo(path.join(dir, 'linked')).items, []);
});

test('scanRepo: caps (500 items, depth, big files)', () => {
  const dir = tmp('cap');
  const files = {};
  for (let i = 0; i < 520; i += 1) files[`agents/a${String(i).padStart(3, '0')}.md`] = AGENT(`a${i}`, `Agent ${i}`);
  writeTree(dir, files);
  const res = scanRepo(dir);
  assert.equal(res.items.length, 500);
  assert.equal(res.items[0].name, 'a0');
  assert.equal(res.items[499].name, 'a499');
  assert.deepEqual(res.warnings, ['Plus de 500 éléments trouvés : seuls les 500 premiers sont gardés.']);

  const deep = tmp('deep');
  const segs = Array.from({ length: 12 }, (_, i) => `d${i}`);
  writeTree(deep, {
    [`${segs.slice(0, 9).join('/')}/agents/ok.md`]: AGENT('ok', 'Depth 10'),
    [`${segs.join('/')}/agents/deep.md`]: AGENT('deep', 'Too deep'),
    'agents/huge.md': `---\nname: huge\ndescription: big\n---\n${'x'.repeat(1024 * 1024 + 10)}`,
  });
  const r2 = scanRepo(deep);
  assert.deepEqual(r2.items.map((i) => i.key), ['agent:ok']);
  assert.deepEqual(r2.warnings, [
    "Certains dossiers trop profonds (plus de 10 niveaux) n'ont pas été analysés.",
    '1 fichier(s) Markdown de plus de 1 Mo ignoré(s).',
  ]);
});

// ---------------------------------------------------------------------------------------------
// Library end to end (local git repos through a file:// base URL)

const SOURCE_FILES = {
  'README.md': '# Outils ACME\n',
  'skills/pdf/SKILL.md': '---\nname: pdf\ndescription: Manipule des fichiers PDF.\n---\n# PDF\n',
  'skills/pdf/reference.md': '# Référence\n',
  'skills/pdf/scripts/run.sh': '#!/bin/sh\necho ok\n',
  'skills/notes/SKILL.md': 'Prend des notes.\n',
  'agents/relecteur-fr.md': '---\nname: Relecteur FR\ndescription: Relit les textes en français: orthographe, grammaire\ntools: Read, Grep\nmodel: haiku\n---\nTu es un relecteur.\n',
  'agents/second.md': AGENT('second', 'Second agent'),
  'commands/hello.md': '---\ndescription: Dit bonjour\nargument-hint: [nom] [formule]\n---\nDis bonjour à $ARGUMENTS\n',
  'hooks/hooks.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo pwned' }] }] } }),
  '.mcp.json': JSON.stringify({ mcpServers: { evil: { command: 'evil' } } }),
};

test('Library: link → cloning → ready, wrapper plugin, toggles, update, reload, remove', { skip: !GIT_AVAILABLE && 'git not installed' }, async () => {
  const root = tmp('e2e');
  const base = path.join(root, 'base');
  const home = path.join(root, 'home');
  const src = makeSourceRepo(base, 'acme', 'tools', SOURCE_FILES);
  const baseUrl = pathToFileURL(base).href;
  const lib = new Library({ home, claudeBin: null, baseUrl, validate: false });
  const events = [];
  lib.on('change', (s) => events.push(s));
  const violations = watchReadyInvariant(lib);
  try {
    await lib.init();
    let state = lib.get();
    assert.equal(state.gitFound, true);
    assert.match(state.gitVersion, /^\d+\.\d+/);
    assert.equal(state.pluginDir, path.join(home, 'library'));
    assert.deepEqual(state.repos, []);
    assert.deepEqual(state.profiles, []);
    assert.deepEqual(lib.pluginDirArgs(), []);

    const linked = await lib.link('acme/tools');
    assert.equal(linked.status, 'cloning');
    assert.equal(linked.id, 'acme__tools');
    assert.equal(linked.plugin, 'acme-tools');
    assert.equal(linked.url, 'https://github.com/acme/tools');
    assert.deepEqual(linked.items, []);
    await assert.rejects(lib.link('https://github.com/acme/tools.git'), (e) => e.status === 409 && e.message === 'Ce dépôt est déjà lié.');
    await assert.rejects(lib.link('pas un lien'), (e) => e.status === 400 && e.message === MSG_INVALID);

    state = await waitFor(lib, settled('acme__tools'));
    let repo = repoOf(state, 'acme__tools');
    assert.equal(repo.status, 'ready', repo.error);
    assert.equal(repo.error, null);
    assert.match(repo.commit, /^[0-9a-f]{7}$/);
    assert.equal(repo.kind, 'loose');
    assert.ok(repo.clonedAt > 0 && repo.updatedAt > 0);
    assert.deepEqual(repo.counts, { skills: 2, agents: 2, commands: 1, enabledSkills: 2, enabledAgents: 2, enabledCommands: 1 });
    assert.deepEqual(repo.warnings, [MSG_HOOKS, MSG_MCP]);
    assert.deepEqual(repo.items.map((i) => i.key).sort(), ['agent:relecteur-fr', 'agent:second', 'command:hello', 'skill:notes', 'skill:pdf']);

    // Events: cloning first, then ready, always the full library object.
    const statuses = events.map((e) => (repoOf(e, 'acme__tools') || {}).status).filter(Boolean);
    assert.equal(statuses[0], 'cloning');
    assert.equal(statuses[statuses.length - 1], 'ready');
    for (const e of events) assert.ok(Array.isArray(e.repos) && Array.isArray(e.profiles) && typeof e.pluginDir === 'string');

    // The wrapper plugin: enabled items only, copies, no hooks / MCP.
    const wrapper = path.join(home, 'library', 'acme-tools');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(wrapper, '.claude-plugin', 'plugin.json'), 'utf8')), {
      name: 'acme-tools',
      description: 'Skills et agents du dépôt acme/tools (lié par PixelQG)',
      version: '1.0.0',
      author: { name: 'acme' },
    });
    assert.deepEqual(fs.readdirSync(wrapper).sort(), ['.claude-plugin', 'agents', 'commands', 'skills']);
    assert.deepEqual(fs.readdirSync(path.join(wrapper, 'skills')).sort(), ['notes', 'pdf']);
    assert.ok(fs.existsSync(path.join(wrapper, 'skills', 'pdf', 'reference.md')));
    assert.ok(fs.existsSync(path.join(wrapper, 'skills', 'pdf', 'scripts', 'run.sh')));
    assert.ok(!fs.lstatSync(path.join(wrapper, 'skills', 'pdf', 'reference.md')).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(wrapper, 'skills', 'notes', 'SKILL.md'), 'utf8'), '---\nname: notes\ndescription: "Prend des notes."\n---\nPrend des notes.\n');
    const agentText = fs.readFileSync(path.join(wrapper, 'agents', 'relecteur-fr.md'), 'utf8');
    assert.match(agentText, /^---\nname: relecteur-fr\ndescription: "Relit les textes en français: orthographe, grammaire"\ntools: Read, Grep\nmodel: haiku\n---\n/);
    assert.deepEqual(parseFrontmatter(agentText).data, {
      name: 'relecteur-fr',
      description: 'Relit les textes en français: orthographe, grammaire',
      tools: 'Read, Grep',
      model: 'haiku',
    });
    assert.match(fs.readFileSync(path.join(wrapper, 'commands', 'hello.md'), 'utf8'), /argument-hint: "\[nom\] \[formule\]"/);
    assert.ok(!fs.existsSync(path.join(wrapper, 'hooks')));
    assert.ok(!fs.existsSync(path.join(wrapper, '.mcp.json')));

    assert.deepEqual(lib.pluginDirArgs(), ['--plugin-dir', path.join(home, 'library')]);
    assert.deepEqual(lib.get().profiles, [
      { value: 'acme-tools:relecteur-fr', label: 'relecteur-fr', repo: 'acme/tools', description: 'Relit les textes en français: orthographe, grammaire' },
      { value: 'acme-tools:second', label: 'second', repo: 'acme/tools', description: 'Second agent' },
    ]);
    assert.equal(lib.hasProfile('acme-tools:relecteur-fr'), true);
    assert.equal(lib.hasProfile('acme-tools:nope'), false);
    assert.equal(lib.hasProfile(null), false);
    assert.equal(lib.hasProfile(''), false);

    // Persisted atomically.
    const saved = JSON.parse(fs.readFileSync(path.join(home, 'library.json'), 'utf8'));
    assert.equal(saved.repos[0].id, 'acme__tools');
    assert.equal(saved.repos[0].status, 'ready');
    assert.deepEqual(fs.readdirSync(home).filter((n) => n.includes('.tmp-')), []);

    // get() returns deep copies.
    lib.get().repos[0].items[0].enabled = false;
    assert.equal(lib.get().repos[0].items[0].enabled, true);

    // Toggle one item.
    repo = await lib.toggle('acme__tools', { key: 'agent:second', enabled: false });
    assert.equal(repo.items.find((i) => i.key === 'agent:second').enabled, false);
    assert.equal(repo.counts.enabledAgents, 1);
    assert.ok(!fs.existsSync(path.join(wrapper, 'agents', 'second.md')));
    assert.ok(fs.existsSync(path.join(wrapper, 'agents', 'relecteur-fr.md')));
    assert.deepEqual(lib.get().profiles.map((p) => p.value), ['acme-tools:relecteur-fr']);
    await assert.rejects(lib.toggle('acme__tools', { key: 'agent:nope', enabled: false }), (e) => e.status === 404);
    await assert.rejects(lib.toggle('acme__tools', { enabled: 'yes' }), (e) => e.status === 400);
    await assert.rejects(lib.toggle('nope__nope', { enabled: true }), (e) => e.status === 404);

    // Toggle the whole repo: wrapper removed, then rebuilt (item flag kept).
    repo = await lib.toggle('acme__tools', { enabled: false });
    assert.equal(repo.enabled, false);
    assert.ok(!fs.existsSync(wrapper));
    assert.deepEqual(lib.pluginDirArgs(), []);
    assert.deepEqual(lib.get().profiles, []);
    repo = await lib.toggle('acme__tools', { enabled: true });
    assert.ok(fs.existsSync(path.join(wrapper, 'agents', 'relecteur-fr.md')));
    assert.ok(!fs.existsSync(path.join(wrapper, 'agents', 'second.md')));
    assert.deepEqual(lib.pluginDirArgs(), ['--plugin-dir', path.join(home, 'library')]);

    // Update after a new commit: enabled flags are kept by key, new items enabled, removed ones gone.
    const oldCommit = repo.commit;
    fs.rmSync(path.join(src, 'skills', 'notes'), { recursive: true });
    writeTree(src, { 'agents/third.md': AGENT('third', 'Third agent') });
    commitAll(src, 'second');
    const updating = await lib.update('acme__tools');
    assert.equal(updating.status, 'updating');
    await assert.rejects(lib.update('acme__tools'), (e) => e.status === 409);
    state = await waitFor(lib, (s) => repoOf(s, 'acme__tools').status === 'ready');
    repo = repoOf(state, 'acme__tools');
    assert.notEqual(repo.commit, oldCommit);
    assert.deepEqual(repo.items.map((i) => `${i.key}=${i.enabled}`).sort(), [
      'agent:relecteur-fr=true',
      'agent:second=false',
      'agent:third=true',
      'command:hello=true',
      'skill:pdf=true',
    ]);
    assert.ok(fs.existsSync(path.join(wrapper, 'agents', 'third.md')));
    assert.ok(!fs.existsSync(path.join(wrapper, 'skills', 'notes')));
    assert.ok(!fs.existsSync(path.join(wrapper, 'agents', 'second.md')));

    // Toggling during an update applies once the update is done (queued rebuild, caller not blocked).
    writeTree(src, { 'agents/fourth.md': AGENT('fourth', 'Fourth agent') });
    commitAll(src, 'third');
    await lib.update('acme__tools');
    const during = await lib.toggle('acme__tools', { key: 'agent:third', enabled: false });
    assert.equal(during.status, 'updating');
    await waitFor(lib, (s) => repoOf(s, 'acme__tools').status === 'ready');
    await lib._queues.get('acme__tools');
    assert.ok(!fs.existsSync(path.join(wrapper, 'agents', 'third.md')));
    assert.ok(fs.existsSync(path.join(wrapper, 'agents', 'fourth.md')));
    assert.equal(lib.get().repos[0].items.find((i) => i.key === 'agent:third').enabled, false);
    await lib.toggle('acme__tools', { key: 'agent:third', enabled: true });
    assert.ok(fs.existsSync(path.join(wrapper, 'agents', 'third.md')));

    // A failing update (source gone) keeps the working wrapper and only warns.
    fs.renameSync(src, `${src}-moved`);
    await lib.update('acme__tools');
    state = await waitFor(lib, (s) => repoOf(s, 'acme__tools').status !== 'updating');
    repo = repoOf(state, 'acme__tools');
    assert.equal(repo.status, 'ready');
    assert.equal(repo.warnings[0], `La dernière mise à jour a échoué : ${MSG_NOTFOUND}`);
    assert.ok(fs.existsSync(path.join(wrapper, 'agents', 'third.md')));
    fs.renameSync(`${src}-moved`, src);
    await lib.update('acme__tools');
    state = await waitFor(lib, (s) => repoOf(s, 'acme__tools').status === 'ready');
    assert.deepEqual(repoOf(state, 'acme__tools').warnings, [MSG_HOOKS, MSG_MCP]);

    // Reload from library.json: same state, wrapper kept as is (fingerprint), not rebuilt.
    fs.writeFileSync(path.join(wrapper, 'marker.txt'), 'kept');
    const lib2 = new Library({ home, claudeBin: null, baseUrl, validate: false });
    try {
      await lib2.init();
      const s2 = lib2.get();
      assert.deepEqual(s2.repos, lib.get().repos);
      assert.ok(fs.existsSync(path.join(wrapper, 'marker.txt')));
      assert.deepEqual(lib2.pluginDirArgs(), ['--plugin-dir', path.join(home, 'library')]);
      assert.equal(lib2.hasProfile('acme-tools:third'), true);
    } finally {
      await lib2.close();
    }

    // Remove: clone + wrapper deleted, library.json updated.
    await lib.remove('acme__tools');
    assert.ok(!fs.existsSync(wrapper));
    assert.ok(!fs.existsSync(path.join(home, 'repos', 'acme__tools')));
    assert.deepEqual(lib.get().repos, []);
    assert.deepEqual(lib.pluginDirArgs(), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'library.json'), 'utf8')).repos, []);
    await assert.rejects(lib.remove('acme__tools'), (e) => e.status === 404 && e.message === 'Dépôt inconnu : il a peut-être déjà été retiré.');
    await assert.rejects(lib.update('acme__tools'), (e) => e.status === 404);

    // Disabling a repo while it is still cloning: it ends ready, disabled, without a wrapper.
    await lib.link('acme/tools');
    const off = await lib.toggle('acme__tools', { enabled: false });
    assert.equal(off.status, 'cloning');
    await waitFor(lib, (s) => repoOf(s, 'acme__tools').status === 'ready');
    await lib._queues.get('acme__tools');
    assert.equal(lib.get().repos[0].enabled, false);
    assert.ok(!fs.existsSync(wrapper));
    assert.deepEqual(lib.pluginDirArgs(), []);
    assert.deepEqual(violations, []);
  } finally {
    await lib.close();
  }
  assert.equal(lib._children.size, 0);
});

test('Library: branch + sub-folder links, plugin name uniqueness and clone errors', { skip: !GIT_AVAILABLE && 'git not installed' }, async () => {
  const root = tmp('errors');
  const base = path.join(root, 'base');
  const home = path.join(root, 'home');
  const src = makeSourceRepo(base, 'acme', 'tools', SOURCE_FILES);
  git(src, 'checkout', '-q', '-b', 'dev');
  writeTree(src, { 'skills/extra/SKILL.md': '---\nname: extra\ndescription: Only on dev\n---\n' });
  commitAll(src, 'dev');
  git(src, 'checkout', '-q', 'main');
  const lib = new Library({ home, claudeBin: null, baseUrl: pathToFileURL(base).href, validate: false, maxRepos: 5 });
  const violations = watchReadyInvariant(lib);
  try {
    await lib.init();
    await lib.link('acme/tools');
    const sub = await lib.link('https://github.com/acme/tools/tree/dev/skills');
    assert.equal(sub.id, 'acme__tools__dev__skills');
    assert.equal(sub.plugin, 'acme-tools-2');
    const missing = await lib.link('acme/missing');
    const badBranch = await lib.link('https://github.com/acme/tools/tree/nope');
    const badSub = await lib.link('https://github.com/acme/tools/tree/main/does-not-exist');
    await assert.rejects(lib.link('acme/other'), (e) => e.status === 400 && e.message === "Tu as déjà lié 5 dépôts : retires-en un avant d'en ajouter un autre.");
    const state = await waitFor(lib, (s) => s.repos.every((r) => r.status === 'ready' || r.status === 'error'));

    const subRepo = repoOf(state, sub.id);
    assert.equal(subRepo.status, 'ready', subRepo.error);
    assert.equal(subRepo.branch, 'dev');
    assert.equal(subRepo.subpath, 'skills');
    assert.deepEqual(subRepo.items.map((i) => [i.key, i.relPath, i.fullName]), [
      ['skill:extra', 'extra', 'acme-tools-2:extra'],
      ['skill:notes', 'notes', 'acme-tools-2:notes'],
      ['skill:pdf', 'pdf', 'acme-tools-2:pdf'],
    ]);
    assert.deepEqual(subRepo.warnings, []);
    assert.ok(fs.existsSync(path.join(home, 'library', 'acme-tools-2', 'skills', 'extra', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(home, 'library', 'acme-tools', 'skills', 'pdf', 'SKILL.md')));
    assert.ok(!fs.existsSync(path.join(home, 'library', 'acme-tools', 'skills', 'extra')));

    assert.equal(repoOf(state, missing.id).status, 'error');
    assert.equal(repoOf(state, missing.id).error, MSG_NOTFOUND);
    assert.equal(repoOf(state, badBranch.id).error, 'Branche « nope » introuvable dans ce dépôt.');
    assert.equal(repoOf(state, badSub.id).error, 'Le dossier « does-not-exist » est introuvable dans ce dépôt.');
    for (const r of [missing, badBranch, badSub]) {
      assert.ok(!fs.existsSync(path.join(home, 'library', repoOf(state, r.id).plugin)));
    }
    assert.deepEqual(fs.readdirSync(path.join(home, 'repos')).filter((n) => n.includes('.tmp-')), []);
    assert.ok(!fs.existsSync(path.join(home, 'repos', missing.id)));

    // Retrying a failed link through update re-clones (still missing → still an error).
    await lib.update(missing.id);
    const s2 = await waitFor(lib, (s) => repoOf(s, missing.id).status === 'error');
    assert.equal(repoOf(s2, missing.id).error, MSG_NOTFOUND);
    await lib.remove(missing.id);
    await lib.remove(badBranch.id);
    assert.equal(lib.get().repos.length, 3);
    assert.deepEqual(violations, []);
  } finally {
    await lib.close();
  }
});

test('Library: wrapper validated by the real `claude plugin validate`', { skip: (!GIT_AVAILABLE && 'git not installed') || (!CLAUDE && 'claude not installed') }, async () => {
  const root = tmp('validate');
  const base = path.join(root, 'base');
  const home = path.join(root, 'home');
  makeSourceRepo(base, 'acme', 'valid', {
    'skills/ok/SKILL.md': '---\nname: ok\ndescription: A valid skill\n---\nBody\n',
    'skills/bare/SKILL.md': 'A skill without frontmatter.\n',
    'agents/colon.md': '---\nname: Colon Agent\ndescription: Use when: reviewing code, e.g. #1\ntools: Read\n---\nBody\n',
    'agents/broken.md': '---\nname: broken\ndescription: "unterminated\ntools: Read\n---\nBody\n',
    'commands/hint.md': '---\ndescription: Hint\nargument-hint: [a] [b]\n---\nBody\n',
  });
  // Owner "anthropics": the default name would be refused by Claude Code ("anthropics-…" is reserved).
  makeSourceRepo(base, 'anthropics', 'claude-kit', { 'agents/helper.md': AGENT('helper', 'Helps') });
  const lib = new Library({ home, claudeBin: CLAUDE, baseUrl: pathToFileURL(base).href, validate: true });
  const violations = watchReadyInvariant(lib);
  try {
    await lib.init();
    await lib.link('acme/valid');
    await lib.link('anthropics/claude-kit');
    const state = await waitFor(lib, (s) => s.repos.every((r) => r.status === 'ready' || r.status === 'error'), 120000);
    const kit = repoOf(state, 'anthropics__claude-kit');
    assert.equal(kit.status, 'ready', kit.error);
    assert.equal(kit.plugin, 'kit');
    assert.deepEqual(kit.warnings, []);
    assert.ok(lib.hasProfile('kit:helper'));
    assert.deepEqual(violations, []);
    const repo = repoOf(state, 'acme__valid');
    assert.equal(repo.status, 'ready', repo.error);
    const broken = repo.items.find((i) => i.key === 'agent:broken');
    assert.match(broken.error, /^Claude Code refuse ce fichier : /);
    for (const it of repo.items.filter((i) => i.key !== 'agent:broken')) assert.equal(it.error, null, it.key);
    const wrapper = path.join(home, 'library', 'acme-valid');
    assert.ok(!fs.existsSync(path.join(wrapper, 'agents', 'broken.md')));
    assert.ok(fs.existsSync(path.join(wrapper, 'agents', 'colon-agent.md')));
    assert.deepEqual(lib.get().profiles.map((p) => p.value), ['acme-valid:colon-agent', 'kit:helper']);
    assert.equal(lib.hasProfile('acme-valid:broken'), false);

    const out = spawnSync(CLAUDE.command, [...CLAUDE.prefixArgs, 'plugin', 'validate', wrapper, '--json'], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 60000,
    });
    const json = JSON.parse(out.stdout.slice(out.stdout.indexOf('{'), out.stdout.lastIndexOf('}') + 1));
    assert.equal(json.success, true, out.stdout);
    assert.deepEqual(json.manifest.errors, []);
    for (const c of json.contents || []) assert.deepEqual(c.errors, [], c.file);
  } finally {
    await lib.close();
  }
});

test('Library: corrupt or tampered library.json is recovered', { skip: !GIT_AVAILABLE && 'git not installed' }, async () => {
  const home = tmp('corrupt');
  fs.writeFileSync(path.join(home, 'library.json'), '{ not json');
  const lib = new Library({ home, claudeBin: null, validate: false });
  try {
    await lib.init();
    assert.equal(lib.recovered, true);
    assert.deepEqual(lib.get().repos, []);
    assert.equal(fs.readFileSync(path.join(home, 'library.json.bad'), 'utf8'), '{ not json');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'library.json'), 'utf8')).repos, []);
  } finally {
    await lib.close();
  }

  const home2 = tmp('tampered');
  const good = {
    id: 'acme__tools', url: 'https://github.com/acme/tools', owner: 'acme', repo: 'tools', branch: null, subpath: null,
    plugin: 'acme-tools', status: 'ready', error: null, enabled: true, commit: 'abc1234', clonedAt: 1, updatedAt: 1, kind: 'loose',
    counts: {}, warnings: [],
    items: [
      { key: 'agent:ok', type: 'agent', name: 'ok', fullName: 'x', description: 'd', relPath: 'agents/ok.md', enabled: false, group: null, tools: null, model: null },
      { key: 'agent:evil', type: 'agent', name: 'evil', relPath: '../../etc/passwd', enabled: true },
      { key: 'agent:abs', type: 'agent', name: 'abs', relPath: 'C:/Windows/win.ini', enabled: true },
      { key: 'skill:BAD', type: 'skill', name: 'BAD NAME', relPath: 'skills/x', enabled: true },
    ],
  };
  const repos = [
    { ...good, id: '../../evil' },
    { ...good, owner: 'acme', repo: '..', id: 'acme__..' },
    { ...good, id: 'other__x', owner: 'other', repo: 'x', plugin: '../escape' },
    { ...good, id: 'other__y', owner: 'other', repo: 'y', subpath: '../..', branch: 'main' },
    'garbage',
    good,
    { ...good },
  ];
  fs.writeFileSync(path.join(home2, 'library.json'), JSON.stringify({ version: 1, repos, meta: { acme__tools: { scanWarnings: ['w'], fingerprint: 'nope' } } }));
  const lib2 = new Library({ home: home2, claudeBin: null, validate: false });
  try {
    await lib2.init();
    assert.equal(lib2.recovered, true);
    assert.ok(fs.existsSync(path.join(home2, 'library.json.bad')));
    const s = lib2.get();
    assert.deepEqual(s.repos.map((r) => r.id), ['acme__tools']);
    const r = s.repos[0];
    // No clone on disk: the repo cannot be "ready".
    assert.equal(r.status, 'error');
    assert.equal(r.error, 'Le clone local a disparu : clique sur « Mettre à jour » pour le récupérer.');
    assert.deepEqual(r.items.map((i) => [i.key, i.fullName, i.enabled]), [['agent:ok', 'acme-tools:ok', false]]);
    assert.deepEqual(r.warnings, ['w']);
    assert.deepEqual(lib2.pluginDirArgs(), []);
  } finally {
    await lib2.close();
  }

  // Interrupted operations become errors on restart.
  const home3 = tmp('interrupted');
  fs.writeFileSync(path.join(home3, 'library.json'), JSON.stringify({ version: 1, repos: [{ ...good, status: 'cloning' }] }));
  const lib3 = new Library({ home: home3, claudeBin: null, validate: false });
  try {
    await lib3.init();
    assert.equal(lib3.recovered, false);
    assert.equal(lib3.get().repos[0].status, 'error');
    assert.match(lib3.get().repos[0].error, /^L'opération a été interrompue/);
  } finally {
    await lib3.close();
  }
});

test('Library: missing git → gitFound false, link refused with a 503 French message', async () => {
  const home = tmp('nogit');
  const lib = new Library({ home, claudeBin: null, gitBin: path.join(home, 'nope', IS_WIN() ? 'git.exe' : 'git'), validate: false });
  try {
    await assert.rejects(lib.link('acme/tools'), (e) => e.status === 503);
    await lib.init();
    const s = lib.get();
    assert.equal(s.gitFound, false);
    assert.equal(s.gitVersion, null);
    assert.deepEqual(s.repos, []);
    await assert.rejects(lib.link('acme/tools'), (e) => e.status === 503 && e.message === MSG_NOGIT);
    await assert.rejects(lib.update('acme__tools'), (e) => e.status === 404);
    assert.deepEqual(lib.pluginDirArgs(), []);
  } finally {
    await lib.close();
  }
  await assert.rejects(lib.link('acme/tools'), (e) => e.status === 503);
});

function IS_WIN() {
  return process.platform === 'win32';
}

test('Library: git timeouts, concurrency limit, remove during clone and close kill git', { skip: !GIT_AVAILABLE && 'git not installed' }, async () => {
  const server = await hangingServer();
  const home = tmp('hang');
  const lib = new Library({ home, claudeBin: null, baseUrl: server.baseUrl, validate: false, maxConcurrentGit: 2, gitTimeoutMs: 2500 });
  try {
    await lib.init();
    // Timeout → French error, partial clone removed.
    await lib.link('acme/slow');
    const s = await waitFor(lib, settled('acme__slow'), 30000);
    assert.equal(repoOf(s, 'acme__slow').error, 'Git a mis trop de temps à répondre (plus de 3 minutes) : opération annulée.');
    assert.deepEqual(fs.readdirSync(path.join(home, 'repos')), []);
    await lib.remove('acme__slow');
  } finally {
    await lib.close();
  }

  const home2 = tmp('hang2');
  const lib2 = new Library({ home: home2, claudeBin: null, baseUrl: server.baseUrl, validate: false, maxConcurrentGit: 2 });
  const pids = [];
  try {
    await lib2.init();
    await lib2.link('acme/one');
    await lib2.link('acme/two');
    await lib2.link('acme/three');
    const deadline = Date.now() + 10000;
    while (lib2._children.size < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(lib2._children.size, 2, 'at most 2 git processes at once');
    assert.equal(lib2._gitPeak, 2);
    pids.push(...[...lib2._children].map((c) => c.pid));

    // Removing a repo that is cloning kills its git and frees a slot for the third one.
    const t0 = Date.now();
    await lib2.remove('acme__one');
    assert.ok(Date.now() - t0 < 10000);
    assert.equal(lib2.get().repos.some((r) => r.id === 'acme__one'), false);
    assert.ok(!fs.existsSync(path.join(home2, 'repos', 'acme__one')));
    while (lib2._children.size < 2 && Date.now() < deadline + 5000) await new Promise((r) => setTimeout(r, 50));
    pids.push(...[...lib2._children].map((c) => c.pid));
    assert.equal(lib2._gitPeak, 2);
  } finally {
    const t1 = Date.now();
    await lib2.close();
    assert.ok(Date.now() - t1 < 8000, 'close() is quick');
  }
  assert.equal(lib2._children.size, 0);
  // Every git we started is gone.
  assert.ok(pids.length >= 3);
  for (const pid of new Set(pids)) assert.equal(processAlive(pid), false, `git pid ${pid} still alive`);
  await assert.rejects(lib2.link('acme/four'), (e) => e.status === 503);
  // Interrupted clones are reported on the next start.
  const lib3 = new Library({ home: home2, claudeBin: null, baseUrl: server.baseUrl, validate: false });
  try {
    await lib3.init();
    const repos = lib3.get().repos;
    assert.deepEqual(repos.map((r) => r.status), ['error', 'error']);
    assert.deepEqual(fs.readdirSync(path.join(home2, 'repos')), []);
  } finally {
    await lib3.close();
    await server.close();
  }
});
