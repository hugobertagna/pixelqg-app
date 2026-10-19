#!/usr/bin/env node
'use strict';

// Builds the Windows release of PixelQG (zero dependency, Windows only):
//
//   release/PixelQG-<version>-windows/        portable folder
//     PixelQG.exe                             launcher (launcher/dist, built by launcher/build.bat)
//     server/                                 Node server (without test/; bin/ keeps hq-pty.cs and a
//                                             prebuilt hq-pty.exe, see below)
//     public/                                 interface
//     runtime/node.exe, runtime/LICENSE.txt   the Node.js running this script, and its licence
//     licences/                               xterm.js licences
//     LISEZMOI.txt, package.json
//   release/PixelQG-<version>-windows.zip     that folder, zipped (PowerShell Compress-Archive)
//   release/PixelQG-Setup-<version>.exe       one-file installer (launcher/PixelQG-Setup.cs) carrying
//                                             the zip; checked with a dry extraction (/extract-to)
//
// Usage: node tools/make-release.js
// Every process runs hidden (no window). The installer itself is never run, only its /extract-to
// check mode, which writes into a temporary folder and nothing else.
//
// hq-pty.exe: the server compiles it at first start with the C# compiler of .NET Framework 4,
// which every Windows 10 / 11 has (csc.exe in %WINDIR%\Microsoft.NET\Framework64\v4.0.30319).
// It is shipped prebuilt anyway: compiling needs a writable app folder, takes a few seconds, and
// csc.exe can be blocked by company policies (AppLocker / WDAC) or antivirus software.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const MAX_ZIP_MB = 60;
const MAX_SETUP_MB = 100;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = String(pkg.version || '0.0.0');
if (!/^\d+\.\d+\.\d+$/.test(VERSION)) fail(`Version invalide dans package.json : ${VERSION}`);
const NAME = `PixelQG-${VERSION}-windows`;
const OUT = path.join(RELEASE, NAME);
const ZIP = path.join(RELEASE, `${NAME}.zip`);
const SETUP = path.join(RELEASE, `PixelQG-Setup-${VERSION}.exe`);
const BUILD = path.join(RELEASE, '.build');

function fail(message) {
  console.error(`\n  ✗  ${message}\n`);
  process.exit(1);
}

function info(message) {
  console.log(`  •  ${message}`);
}

function warn(message) {
  console.log(`  ⚠  ${message}`);
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
}

/** Copies a file and keeps its modification date. */
function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  const st = fs.statSync(src);
  fs.utimesSync(dest, st.atime, st.mtime);
}

/** Copies a folder; `skip(relativePath, isDir)` leaves entries out. Returns the number of files. */
function copyDir(src, dest, skip = () => false, rel = '') {
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || skip(r, entry.isDirectory())) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) n += copyDir(from, to, skip, r);
    else if (entry.isFile()) {
      copyFile(from, to);
      n++;
    }
  }
  return n;
}

function listFiles(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(path.join(dir, entry.name), r));
    else if (entry.isFile()) out.push(r);
  }
  return out;
}

function run(file, args, { timeoutMs = 300000, cwd } = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(file, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, cwd }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function findCsc() {
  const windir = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
  for (const fw of ['Framework64', 'Framework']) {
    const exe = path.join(windir, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function powershell() {
  const root = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(exe) ? exe : 'powershell.exe';
}

/** PowerShell single-quoted literal. */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function lisezmoi() {
  return [
    `PixelQG ${VERSION} pour Windows`,
    '==============================',
    '',
    'PixelQG est un petit QG en pixel art : tu y lances des agents Claude Code et tu les',
    'regardes travailler dans un bureau, comme dans un jeu.',
    '',
    'Démarrer',
    '--------',
    '1. Installe Claude Code puis connecte-toi une fois, dans une invite de commandes :',
    '     npm install -g @anthropic-ai/claude-code',
    '     claude',
    '2. Double-clique sur PixelQG.exe : PixelQG s\'ouvre dans sa propre fenêtre.',
    '',
    'Pour arrêter PixelQG, ferme sa fenêtre : les agents encore au travail s\'arrêtent avec lui.',
    '',
    'Bon à savoir',
    '------------',
    '- Node.js est inclus (dossier runtime) : inutile de l\'installer.',
    '- Garde tous ces fichiers ensemble : PixelQG.exe a besoin des dossiers server, public et',
    '  runtime. Tu peux déplacer le dossier entier où tu veux (clé USB comprise).',
    '- Au premier lancement, Windows peut afficher « Windows a protégé votre ordinateur » :',
    '  clique sur « Informations complémentaires », puis sur « Exécuter quand même ».',
    '- Le terminal intégré demande Windows 10 version 1809 ou plus récent.',
    '- Tes réglages et ta bibliothèque de skills sont rangés dans le dossier',
    '  %USERPROFILE%\\.pixelqg : supprimer ce dossier-ci ne les efface pas.',
    '- En cas de souci, le journal du lanceur est ici : %LOCALAPPDATA%\\PixelQG\\pixelqg.log',
    '',
    'Licences',
    '--------',
    ...(projectLicence() ? ['- PixelQG : logiciel libre, licence MIT (LICENSE.txt).'] : []),
    '- Node.js : licence MIT (runtime\\LICENSE.txt).',
    '- xterm.js et ses modules : licence MIT (dossier licences).',
    '',
  ].join('\r\n');
}

/** PixelQG's own licence file at the repository root, if any. */
function projectLicence() {
  return ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].map((f) => path.join(ROOT, f)).find((f) => fs.existsSync(f)) || null;
}

function nodeLicenceNotice() {
  const v = process.versions.node;
  return [
    `Node.js ${v} (runtime\\node.exe)`,
    '',
    'Node.js est distribué sous licence MIT. Copyright Node.js contributors. All rights reserved.',
    'Le texte complet de sa licence, avec celles des bibliothèques qu\'il contient, est ici :',
    `https://github.com/nodejs/node/blob/v${v}/LICENSE`,
    '',
  ].join('\r\n');
}

async function buildRelease() {
  fs.mkdirSync(RELEASE, { recursive: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // PixelQG.exe (built by the lead with launcher\build.bat).
  const launcher = path.join(ROOT, 'launcher', 'dist', 'PixelQG.exe');
  const launcherSrc = path.join(ROOT, 'launcher', 'PixelQG.cs');
  let hasLauncher = false;
  if (fs.existsSync(launcher)) {
    copyFile(launcher, path.join(OUT, 'PixelQG.exe'));
    hasLauncher = true;
    info('PixelQG.exe copié depuis launcher\\dist.');
    if (fs.existsSync(launcherSrc) && fs.statSync(launcherSrc).mtimeMs > fs.statSync(launcher).mtimeMs) {
      warn('PixelQG.exe est plus ancien que launcher\\PixelQG.cs : relance launcher\\build.bat, puis ce script.');
    }
  } else {
    warn('PixelQG.exe manque (launcher\\dist\\PixelQG.exe) : compile-le avec launcher\\build.bat, puis relance ce script.');
  }

  // server/ without its tests and without compiled or temporary executables.
  const serverFiles = copyDir(path.join(ROOT, 'server'), path.join(OUT, 'server'), (rel) =>
    rel === 'test' || /^bin\/.*\.exe$/i.test(rel) || /^bin\/hq-pty-build-/i.test(rel) || /\.log$/i.test(rel));
  info(`server : ${serverFiles} fichiers.`);

  // The terminal bridge, prebuilt (see the header), dated after its source.
  const ptySrc = path.join(ROOT, 'server', 'bin', 'hq-pty.cs');
  const ptyExe = path.join(ROOT, 'server', 'bin', 'hq-pty.exe');
  const ptyOut = path.join(OUT, 'server', 'bin', 'hq-pty.exe');
  if (fs.existsSync(ptyExe) && fs.statSync(ptyExe).mtimeMs >= fs.statSync(ptySrc).mtimeMs) {
    fs.copyFileSync(ptyExe, ptyOut);
  } else {
    const { compileBridge } = require('../server/terminals');
    try {
      await compileBridge(ptySrc, ptyOut);
    } catch (err) {
      fail(`hq-pty.exe : ${err.message}`);
    }
  }
  const now = new Date();
  fs.utimesSync(ptyOut, now, now);
  info('server\\bin\\hq-pty.exe inclus (précompilé).');

  const publicFiles = copyDir(path.join(ROOT, 'public'), path.join(OUT, 'public'));
  info(`public : ${publicFiles} fichiers.`);

  // Node.js runtime: the very node.exe running this script.
  const nodeExe = process.execPath;
  if (!/\.exe$/i.test(nodeExe)) fail('Ce script doit être lancé avec le node.exe de Windows.');
  copyFile(nodeExe, path.join(OUT, 'runtime', 'node.exe'));
  const nodeDir = path.dirname(nodeExe);
  const licence = ['LICENSE', 'LICENSE.txt', 'LICENSE.md'].map((f) => path.join(nodeDir, f)).find((f) => fs.existsSync(f));
  if (licence) {
    copyFile(licence, path.join(OUT, 'runtime', 'LICENSE.txt'));
    info(`runtime\\node.exe : Node.js ${process.versions.node}, avec sa licence.`);
  } else {
    fs.writeFileSync(path.join(OUT, 'runtime', 'LICENSE.txt'), nodeLicenceNotice(), 'utf8');
    info(`runtime\\node.exe : Node.js ${process.versions.node} (pas de LICENSE dans ${nodeDir} : notice vers la licence MIT).`);
  }

  // xterm.js licences, also next to the files they cover (public/vendor/xterm).
  const xtermDir = path.join(ROOT, 'public', 'vendor', 'xterm');
  const xtermLicences = fs.readdirSync(xtermDir).filter((f) => /^LICENSE/i.test(f));
  if (!xtermLicences.length) fail('Licences de xterm.js introuvables dans public/vendor/xterm.');
  for (const f of xtermLicences) copyFile(path.join(xtermDir, f), path.join(OUT, 'licences', f.replace(/^LICENSE-/i, '')));

  fs.writeFileSync(path.join(OUT, 'LISEZMOI.txt'), '\ufeff' + lisezmoi(), 'utf8');
  copyFile(path.join(ROOT, 'package.json'), path.join(OUT, 'package.json'));
  const ownLicence = projectLicence();
  if (ownLicence) copyFile(ownLicence, path.join(OUT, 'LICENSE.txt'));
  else warn('Pas de fichier LICENSE \u00e0 la racine du projet : la licence de PixelQG ne sera pas incluse.');

  // Nothing that must stay out of a release.
  const files = listFiles(OUT);
  const leaked = files.filter((f) => /^(docs|backups)\//.test(f) || f === 'TODO.md' || /^server\/test\//.test(f)
    || (/^server\/bin\/.*\.exe$/i.test(f) && f !== 'server/bin/hq-pty.exe'));
  if (leaked.length) fail(`Fichiers à exclure trouvés : ${leaked.join(', ')}`);
  return { files, hasLauncher };
}

async function makeZip() {
  fs.rmSync(ZIP, { force: true });
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    `Compress-Archive -LiteralPath ${psQuote(OUT)} -DestinationPath ${psQuote(ZIP)} -CompressionLevel Optimal -Force`,
  ].join('; ');
  const res = await run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script]);
  if (res.code !== 0 || !fs.existsSync(ZIP)) fail(`Compress-Archive a échoué : ${(res.stderr || res.stdout || String(res.err)).trim().split(/\r?\n/)[0]}`);
  return fs.statSync(ZIP).size;
}

async function compile(csc, args) {
  const res = await run(csc, ['/nologo', '/codepage:65001', ...args], { timeoutMs: 180000 });
  if (res.code !== 0) {
    const firstError = res.stdout.split(/\r?\n/).find((l) => /error/i.test(l));
    fail(`Compilation de l'installateur échouée : ${(firstError || res.stdout || String(res.err)).trim()}`);
  }
}

async function makeSetup() {
  const csc = findCsc();
  if (!csc) fail('Compilateur C# du .NET Framework introuvable (csc.exe).');
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  const setupInfo = path.join(BUILD, 'SetupInfo.cs');
  fs.writeFileSync(setupInfo, [
    '// Generated by tools/make-release.js',
    'static class SetupInfo',
    '{',
    `    public const string Version = "${VERSION}";`,
    `    public const string AssemblyVersion = "${VERSION}.0";`,
    '}',
    '',
  ].join('\r\n'), 'utf8');
  const source = path.join(ROOT, 'launcher', 'PixelQG-Setup.cs');
  // The launcher icon (launcher/make-icon.js writes it when build.bat runs).
  const icon = ['pixelqg.ico', 'clawd.ico'].map((f) => path.join(ROOT, 'launcher', f)).find((f) => fs.existsSync(f));
  const common = [
    '/target:winexe', '/optimize+',
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
  ];
  if (icon) common.push(`/win32icon:${icon}`);
  else warn('launcher\\pixelqg.ico manque : installateur sans icône (lance launcher\\build.bat une fois).');
  const uninstaller = path.join(BUILD, 'Desinstaller.exe');
  await compile(csc, [...common, `/out:${uninstaller}`, source, setupInfo]);
  fs.rmSync(SETUP, { force: true });
  await compile(csc, [...common, `/out:${SETUP}`,
    `/resource:${ZIP},PixelQG.payload.zip`, `/resource:${uninstaller},PixelQG.uninstaller.exe`, source, setupInfo]);
  fs.rmSync(BUILD, { recursive: true, force: true });
  return fs.statSync(SETUP).size;
}

/** Dry extraction: the setup's /extract-to mode into a temporary folder, compared with OUT. */
async function checkSetup(expected) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pixelqg-setup-check-'));
  try {
    const res = await run(SETUP, ['/extract-to', tmp], { timeoutMs: 180000 });
    if (res.code !== 0 || !/^OK \d+/.test(res.stdout.trim())) {
      fail(`Vérification de l'installateur échouée (code ${res.code}) : ${(res.stderr || res.stdout).trim()}`);
    }
    const got = new Set(listFiles(tmp));
    const missing = expected.filter((f) => !got.has(f));
    if (missing.length) fail(`Fichiers absents après extraction : ${missing.slice(0, 10).join(', ')}`);
    for (const f of expected) {
      if (fs.statSync(path.join(tmp, f)).size !== fs.statSync(path.join(OUT, f)).size) fail(`Taille différente après extraction : ${f}`);
    }
    if (!got.has('Desinstaller.exe')) fail('Desinstaller.exe absent après extraction.');
    const pty = fs.statSync(path.join(tmp, 'server', 'bin', 'hq-pty.exe')).mtimeMs;
    const ptySrc = fs.statSync(path.join(tmp, 'server', 'bin', 'hq-pty.cs')).mtimeMs;
    if (pty < ptySrc) fail('hq-pty.exe extrait plus ancien que sa source : le serveur le recompilerait.');
    return got.size;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== 'win32') fail('Ce script prépare la version Windows : lance-le sous Windows.');
  console.log(`\n  PixelQG ${VERSION} : préparation de la version Windows\n`);
  const { files, hasLauncher } = await buildRelease();
  info(`Dossier prêt : release\\${NAME} (${files.length} fichiers).`);

  const zipSize = await makeZip();
  info(`Archive : release\\${NAME}.zip (${mb(zipSize)}).`);
  if (zipSize > MAX_ZIP_MB * 1024 * 1024) warn(`L'archive dépasse ${MAX_ZIP_MB} Mo.`);

  const setupSize = await makeSetup();
  info(`Installateur : release\\PixelQG-Setup-${VERSION}.exe (${mb(setupSize)}).`);
  if (setupSize > MAX_SETUP_MB * 1024 * 1024) warn(`L'installateur dépasse ${MAX_SETUP_MB} Mo (limite visée pour une GitHub Release).`);
  const extracted = await checkSetup(files);
  info(`Installateur vérifié : ${extracted} fichiers extraits à blanc, identiques au dossier portable.`);

  if (!hasLauncher) warn('Sans PixelQG.exe, cette version n\'est pas distribuable : compile-le puis relance ce script.');
  // For the GitHub Release page (the file names never change for a given version).
  console.log('\n  À publier :');
  for (const file of [SETUP, ZIP]) {
    console.log(`    ${path.basename(file)}  ${mb(fs.statSync(file).size)} (${fs.statSync(file).size} octets)`);
    console.log(`      SHA-256 ${await sha256(file)}`);
  }
  console.log('');
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
