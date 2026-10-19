'use strict';

// Demo mode (contract section 5): simulated agents that produce synthetic
// stream-json events and feed them to the very same StreamParser used for real
// Claude Code processes. Never spawns any process and never spends tokens.

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

const MODELS = ['claude-haiku-5-5', 'claude-opus-5-5'];
const SUB_MODEL = 'claude-haiku-5-5';

// Prices in USD per million tokens, used only to compute a plausible fake cost.
const PRICES = {
  'claude-haiku-5-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-5-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
};

// ------------------------------------------------------------------------------------------------
// Scenario library. Paths are relative to the agent's (fake) project directory.

const SCENARIOS = [
  {
    project: 'boutique-en-ligne',
    prompt: 'Refactoriser le module de paiement : isole la logique Stripe, ajoute une gestion d\'erreurs claire et garde les tests au vert.',
    final: 'Le module de paiement est refactorisé : la logique Stripe vit dans src/paiement/stripe.ts, les erreurs sont typées dans src/paiement/erreurs.ts et les 42 tests passent.',
    steps: [
      { think: 'Je commence par repérer tous les fichiers du module de paiement.' },
      { tool: 'Glob', input: { pattern: 'src/paiement/**/*.ts' }, result: 'src/paiement/stripe.ts\nsrc/paiement/facture.ts\nsrc/paiement/remboursement.ts\nsrc/paiement/index.ts' },
      { tool: 'Read', file: 'src/paiement/stripe.ts', result: '1\timport Stripe from "stripe";\n2\timport { calculerTotal } from "./facture";\n3\t\n4\texport async function payer(commande) {\n5\t  const total = calculerTotal(commande);\n6\t  return stripe.paymentIntents.create({ amount: total, currency: "eur" });\n7\t}' },
      { tool: 'Grep', input: { pattern: 'calculerTotal', path: 'src', output_mode: 'content' }, result: 'src/paiement/facture.ts:12:export function calculerTotal(commande) {\nsrc/paiement/stripe.ts:5:  const total = calculerTotal(commande);\nsrc/panier/resume.ts:31:  const total = calculerTotal(panier);' },
      { tool: 'Read', file: 'src/paiement/facture.ts', result: '12\texport function calculerTotal(commande) {\n13\t  return commande.lignes.reduce((s, l) => s + l.prix * l.quantite, 0);\n14\t}' },
      { tool: 'TodoWrite', input: { todos: [{ content: 'Isoler le client Stripe', status: 'in_progress' }, { content: 'Typer les erreurs de paiement', status: 'pending' }, { content: 'Relancer les tests', status: 'pending' }] }, result: 'Todos have been modified successfully.' },
      { tool: 'Write', file: 'src/paiement/erreurs.ts', input: { content: 'export class ErreurPaiement extends Error {\n  constructor(message, public readonly code: string) { super(message); }\n}\n' }, result: 'File created successfully at: src/paiement/erreurs.ts' },
      { tool: 'Edit', file: 'src/paiement/stripe.ts', input: { old_string: 'return stripe.paymentIntents.create', new_string: 'try {\n    return await stripe.paymentIntents.create' }, result: 'The file src/paiement/stripe.ts has been updated successfully.' },
      { tool: 'Bash', input: { command: 'npm test -- paiement', description: 'Lance les tests du paiement' }, result: 'FAIL tests/paiement/stripe.test.ts\n  ● payer › renvoie une ErreurPaiement si la carte est refusée\n    Expected: ErreurPaiement\n    Received: Error', isError: true },
      { think: 'Le test attend une ErreurPaiement : il faut convertir l\'erreur Stripe dans le bloc catch.' },
      { tool: 'Edit', file: 'src/paiement/stripe.ts', input: { old_string: '} catch (e) {\n    throw e;', new_string: '} catch (e) {\n    throw new ErreurPaiement(e.message, e.code);' }, result: 'The file src/paiement/stripe.ts has been updated successfully.' },
      { tool: 'Bash', input: { command: 'npm test -- paiement', description: 'Relance les tests du paiement' }, result: 'PASS tests/paiement/stripe.test.ts\nPASS tests/paiement/facture.test.ts\n\nTests: 42 passed, 42 total\nTime: 3.18 s' },
    ],
  },
  {
    project: 'api-commandes',
    prompt: 'Écrire les tests de l\'API : couvre les routes /commandes et /utilisateurs avec des cas d\'erreur.',
    final: 'Les tests de l\'API sont écrits : 18 cas pour /commandes et 11 pour /utilisateurs, y compris les erreurs 400, 401 et 404. Tout passe.',
    steps: [
      { think: 'Je vais d\'abord cartographier les routes existantes.' },
      {
        delegate: [
          {
            description: 'Cartographier les routes de l\'API',
            subagent_type: 'Explore',
            prompt: 'Liste toutes les routes Express de src/api avec leur méthode HTTP et le fichier qui les déclare.',
            summary: '9 routes trouvées : GET/POST /commandes, GET/PATCH/DELETE /commandes/:id, GET/POST /utilisateurs, GET /utilisateurs/:id, POST /connexion.',
            steps: [
              { tool: 'Glob', input: { pattern: 'src/api/**/*.ts' }, result: 'src/api/commandes.ts\nsrc/api/utilisateurs.ts\nsrc/api/routes.ts\nsrc/api/middlewares/auth.ts' },
              { tool: 'Grep', input: { pattern: 'router\\.(get|post|patch|delete)', path: 'src/api' }, result: 'src/api/commandes.ts:8:router.get("/commandes", lister)\nsrc/api/commandes.ts:9:router.post("/commandes", creer)\nsrc/api/utilisateurs.ts:6:router.get("/utilisateurs", lister)' },
              { tool: 'Read', file: 'src/api/routes.ts', result: '1\timport commandes from "./commandes";\n2\timport utilisateurs from "./utilisateurs";\n3\texport default [commandes, utilisateurs];' },
            ],
          },
        ],
      },
      { tool: 'Read', file: 'src/api/commandes.ts', result: '8\trouter.get("/commandes", lister);\n9\trouter.post("/commandes", valider(schemaCommande), creer);\n10\trouter.get("/commandes/:id", trouver);' },
      { tool: 'Read', file: 'src/api/utilisateurs.ts', result: '6\trouter.get("/utilisateurs", exigerAdmin, lister);\n7\trouter.post("/utilisateurs", creer);' },
      { tool: 'Write', file: 'tests/api/commandes.test.ts', input: { content: 'describe("POST /commandes", () => {\n  it("refuse une commande vide (400)", async () => { /* … */ });\n});\n' }, result: 'File created successfully at: tests/api/commandes.test.ts' },
      { tool: 'Write', file: 'tests/api/utilisateurs.test.ts', input: { content: 'describe("GET /utilisateurs", () => {\n  it("exige un administrateur (401)", async () => { /* … */ });\n});\n' }, result: 'File created successfully at: tests/api/utilisateurs.test.ts' },
      { tool: 'Bash', input: { command: 'npm test', description: 'Lance toute la suite de tests' }, result: 'PASS tests/api/commandes.test.ts (18 tests)\nPASS tests/api/utilisateurs.test.ts (11 tests)\n\nTests: 29 passed, 29 total' },
    ],
  },
  {
    project: 'site-vitrine',
    prompt: 'Auditer les dépendances : trouve les paquets vulnérables ou inutilisés et propose des mises à jour sûres.',
    final: 'Audit terminé : lodash et minimist mis à jour (2 vulnérabilités corrigées), 3 dépendances inutilisées retirées, toutes les licences sont compatibles MIT.',
    steps: [
      { tool: 'Read', file: 'package.json', result: '{\n  "name": "site-vitrine",\n  "dependencies": {\n    "lodash": "4.17.20",\n    "minimist": "1.2.5",\n    "moment": "2.29.1"\n  }\n}' },
      { tool: 'Bash', input: { command: 'npm audit --json', description: 'Analyse les vulnérabilités connues' }, result: '{ "vulnerabilities": { "lodash": { "severity": "high" }, "minimist": { "severity": "critical" } } }' },
      { tool: 'WebSearch', input: { query: 'vulnérabilité lodash 4.17.20 prototype pollution CVE' }, result: 'CVE-2021-23337 — Command Injection in lodash (corrigé en 4.17.21)\nGHSA-35jh-r3h4-6jhm — Prototype Pollution in lodash' },
      { tool: 'WebFetch', input: { url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', prompt: 'Quelle version corrige la faille ?' }, result: 'La version 4.17.21 corrige la faille. Aucun changement cassant signalé.' },
      {
        delegate: [
          {
            description: 'Vérifier les licences des dépendances',
            subagent_type: 'general-purpose',
            prompt: 'Vérifie la licence de chaque dépendance directe et signale toute licence incompatible avec MIT.',
            summary: 'Toutes les licences (MIT, ISC, BSD-2-Clause) sont compatibles avec MIT.',
            steps: [
              { tool: 'Bash', input: { command: 'npx license-checker --summary', description: 'Résume les licences' }, result: '├─ MIT: 214\n├─ ISC: 18\n└─ BSD-2-Clause: 4' },
              { tool: 'Read', file: 'node_modules/moment/LICENSE', result: 'Copyright (c) JS Foundation and other contributors\n\nPermission is hereby granted, free of charge…' },
            ],
          },
          {
            description: 'Chercher les dépendances inutilisées',
            subagent_type: 'Explore',
            prompt: 'Trouve les dépendances déclarées dans package.json qui ne sont importées nulle part dans src/.',
            summary: 'moment, classnames et left-pad ne sont importés nulle part.',
            steps: [
              { tool: 'Grep', input: { pattern: 'from "moment"', path: 'src' }, result: 'No matches found' },
              { tool: 'Grep', input: { pattern: 'require\\("left-pad"\\)', path: 'src' }, result: 'No matches found' },
              { tool: 'Glob', input: { pattern: 'src/**/*.{js,ts}' }, result: 'src/index.ts\nsrc/composants/entete.ts\nsrc/composants/pied-de-page.ts' },
            ],
          },
        ],
      },
      { tool: 'Edit', file: 'package.json', input: { old_string: '"lodash": "4.17.20"', new_string: '"lodash": "4.17.21"' }, result: 'The file package.json has been updated successfully.' },
      { tool: 'Bash', input: { command: 'npm uninstall moment classnames left-pad && npm install', description: 'Met à jour les dépendances' }, result: 'removed 3 packages, changed 2 packages, and audited 236 packages in 4s\n\nfound 0 vulnerabilities' },
      { tool: 'Bash', input: { command: 'npm audit', description: 'Vérifie qu\'il ne reste aucune faille' }, result: 'found 0 vulnerabilities' },
    ],
  },
  {
    project: 'outil-facturation',
    prompt: 'Rédiger la doc : un guide de démarrage et une référence de l\'API du générateur de factures.',
    final: 'Documentation rédigée : docs/guide-demarrage.md (installation, premier export PDF) et docs/reference-api.md (12 fonctions documentées). Le README pointe vers les deux.',
    steps: [
      { tool: 'Glob', input: { pattern: 'docs/**/*.md' }, result: 'docs/historique.md' },
      { tool: 'Read', file: 'README.md', result: '# Outil de facturation\n\nGénère des factures PDF à partir de fichiers CSV.\n\n## Installation\n\n(section vide)' },
      { tool: 'Read', file: 'src/facturation/generateur.ts', result: '15\texport function genererFacture(client, lignes, options = {}) {\n16\t  const numero = prochainNumero();\n17\t  return rendrePdf(gabarit(client, lignes, numero), options);\n18\t}' },
      { tool: 'Grep', input: { pattern: '^export function', path: 'src/facturation' }, result: 'src/facturation/generateur.ts:15:export function genererFacture\nsrc/facturation/numerotation.ts:4:export function prochainNumero\nsrc/facturation/pdf.ts:9:export function rendrePdf' },
      { tool: 'WebFetch', input: { url: 'https://nodejs.org/api/esm.html', prompt: 'Comment importer un module ESM depuis CommonJS ?' }, result: 'Use dynamic import() to load an ES module from CommonJS.' },
      { tool: 'Write', file: 'docs/guide-demarrage.md', input: { content: '# Guide de démarrage\n\n1. Installe Node.js 20+\n2. `npm install`\n3. `npm run facture -- clients.csv`\n' }, result: 'File created successfully at: docs/guide-demarrage.md' },
      { tool: 'Write', file: 'docs/reference-api.md', input: { content: '# Référence de l\'API\n\n## genererFacture(client, lignes, options)\n…' }, result: 'File created successfully at: docs/reference-api.md' },
      { tool: 'Edit', file: 'README.md', input: { old_string: '## Installation\n\n(section vide)', new_string: '## Installation\n\nVoir [le guide de démarrage](docs/guide-demarrage.md).' }, result: 'The file README.md has been updated successfully.' },
    ],
  },
  {
    project: 'application-mobile',
    prompt: 'Corriger le bug de connexion : certains utilisateurs sont déconnectés juste après s\'être identifiés.',
    final: 'Bug corrigé : le jeton de session expirait car l\'horodatage était en secondes au lieu de millisecondes. Test de non-régression ajouté et pull request ouverte.',
    steps: [
      { think: 'Une déconnexion immédiate ressemble à un problème d\'expiration de session.' },
      { tool: 'Grep', input: { pattern: 'seConnecter', path: 'src' }, result: 'src/auth/session.ts:22:export async function seConnecter(identifiants) {\nsrc/ecrans/connexion.tsx:48:    await seConnecter(form);' },
      { tool: 'Read', file: 'src/auth/session.ts', result: '22\texport async function seConnecter(identifiants) {\n23\t  const jeton = await api.post("/connexion", identifiants);\n24\t  stockage.set("expire", Date.now() / 1000 + jeton.duree);\n25\t}' },
      { tool: 'Bash', input: { command: 'npm run test:e2e -- connexion', description: 'Reproduit le bug en test e2e' }, result: '✕ reste connecté après identification (2304 ms)\n  Expected: "accueil"\n  Received: "connexion"', isError: true },
      { tool: 'Edit', file: 'src/auth/session.ts', input: { old_string: 'Date.now() / 1000 + jeton.duree', new_string: 'Date.now() + jeton.duree * 1000' }, result: 'The file src/auth/session.ts has been updated successfully.' },
      { tool: 'Write', file: 'tests/auth/session.test.ts', input: { content: 'it("garde la session ouverte pendant toute sa durée", () => { /* … */ });\n' }, result: 'File created successfully at: tests/auth/session.test.ts' },
      { tool: 'Bash', input: { command: 'npm run test:e2e -- connexion', description: 'Relance le test e2e de connexion' }, result: '✓ reste connecté après identification (1876 ms)\n\n1 passed' },
      { tool: 'mcp__github__create_pull_request', input: { title: 'Corrige l\'expiration immédiate de la session', base: 'main', head: 'correctif/session' }, result: 'Pull request #128 créée.' },
    ],
  },
  {
    project: 'tableau-de-bord',
    prompt: 'Optimiser les performances du tableau de bord : la page des statistiques met plus de 3 secondes à s\'afficher.',
    final: 'Le tableau de bord s\'affiche maintenant en 0,9 s : liste virtualisée, calculs mémorisés et requêtes regroupées. Build vérifié.',
    steps: [
      { tool: 'Read', file: 'src/tableau-de-bord/graphiques.tsx', result: '30\texport function Graphiques({ ventes }) {\n31\t  const series = calculerSeries(ventes);\n32\t  return ventes.map((v) => <Ligne key={v.id} vente={v} />);\n33\t}' },
      { tool: 'WebSearch', input: { query: 'React useMemo liste virtualisée grandes tables performance' }, result: 'react-window — Rendu efficace de grandes listes\nuseMemo — Mémoriser un calcul coûteux (react.dev)' },
      {
        delegate: [
          {
            description: 'Repérer les rendus inutiles',
            subagent_type: 'Explore',
            prompt: 'Identifie les composants du tableau de bord qui se re-rendent sans changement de props.',
            summary: 'Graphiques et FiltreDates se re-rendent à chaque frappe : les props objets sont recréées à chaque rendu.',
            steps: [
              { tool: 'Glob', input: { pattern: 'src/tableau-de-bord/**/*.tsx' }, result: 'src/tableau-de-bord/graphiques.tsx\nsrc/tableau-de-bord/filtre-dates.tsx\nsrc/tableau-de-bord/index.tsx' },
              { tool: 'Read', file: 'src/tableau-de-bord/filtre-dates.tsx', result: '12\t<FiltreDates options={{ debut, fin }} onChange={(d) => setDates(d)} />' },
            ],
          },
        ],
      },
      { tool: 'Edit', file: 'src/tableau-de-bord/graphiques.tsx', input: { old_string: 'const series = calculerSeries(ventes);', new_string: 'const series = useMemo(() => calculerSeries(ventes), [ventes]);' }, result: 'The file src/tableau-de-bord/graphiques.tsx has been updated successfully.' },
      { tool: 'Edit', file: 'src/tableau-de-bord/filtre-dates.tsx', input: { old_string: 'options={{ debut, fin }}', new_string: 'options={optionsDates}' }, result: 'The file src/tableau-de-bord/filtre-dates.tsx has been updated successfully.' },
      { tool: 'Bash', input: { command: 'npm run build', description: 'Compile le projet' }, result: 'vite v6.2.0 building for production...\n✓ 412 modules transformed.\ndist/assets/index.js  182.40 kB │ gzip: 58.11 kB\n✓ built in 6.42s' },
    ],
  },
];

// Extra steps used to vary scenario length (8–20 steps).
const FILLERS = [
  { think: 'Je vérifie que rien d\'autre ne dépend de ce code.' },
  { think: 'Je relis les changements avant de continuer.' },
  { tool: 'Grep', input: { pattern: 'console\\.log', path: 'src' }, result: 'src/utils/dates.ts:18:  console.log("fuseau", fuseau);' },
  { tool: 'Read', file: 'tsconfig.json', result: '{\n  "compilerOptions": { "strict": true, "target": "ES2022" }\n}' },
  { tool: 'Bash', input: { command: 'git status --short', description: 'Liste les fichiers modifiés' }, result: ' M src/index.ts\n?? docs/' },
  { tool: 'Bash', input: { command: 'npm run lint', description: 'Vérifie le style du code' }, result: '✔ Aucun problème trouvé.' },
  { tool: 'Glob', input: { pattern: '**/*.config.{js,ts}' }, result: 'vite.config.ts\neslint.config.js' },
  { tool: 'Read', file: 'src/utils/format.ts', result: '1\texport const formaterPrix = (c) => (c / 100).toFixed(2) + " €";' },
  { tool: 'TodoWrite', input: { todos: [{ content: 'Relire le diff', status: 'in_progress' }] }, result: 'Todos have been modified successfully.' },
];

// ------------------------------------------------------------------------------------------------

function truncate(text, max) {
  const chars = Array.from(String(text));
  return chars.length <= max ? chars.join('') : chars.slice(0, max - 1).join('') + '…';
}

function randInt(rng, min, max) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function pick(rng, list) {
  return list[Math.floor(rng() * list.length) % list.length];
}

function shortId(rng, len = 24) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += alphabet[Math.floor(rng() * alphabet.length) % alphabet.length];
  return s;
}

/**
 * Builds the timed event list of one scenario run. Pure function of its inputs.
 * @returns {{items: {delay: number, event: object}[]}}
 */
function buildScenarioEvents(opts) {
  const { rng, scenario, prompt, sessionId, cwd, model, speed } = opts;
  const items = [];
  const delay = (min = 800, max = 3500) => Math.max(5, Math.round(randInt(rng, min, max) / speed));
  const push = (event, d) => items.push({ delay: d === undefined ? delay() : d, event });
  const full = (rel) => path.join(cwd, rel);
  const price = PRICES[model] || PRICES['claude-haiku-5-5'];

  // Root context grows over the turn: cache reads track the conversation size.
  const rootCtx = { size: randInt(rng, 16000, 26000), out: 0, input: 0, read: 0, write: 0 };
  const subTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  function usageFor(ctx, outStart) {
    const write = randInt(rng, 180, 2600);
    const u = { input_tokens: randInt(rng, 2, 9), output_tokens: outStart, cache_read_input_tokens: ctx.size, cache_creation_input_tokens: write };
    ctx.size += write;
    return u;
  }

  function assistantEvents(ctx, blocks, parentToolUseId, msgModel, extra = {}) {
    const id = `msg_demo_${shortId(rng)}`;
    const base = usageFor(ctx, randInt(rng, 6, 30));
    const finalOut = base.output_tokens + randInt(rng, 40, 650);
    const evs = blocks.map((block, i) => {
      const last = i === blocks.length - 1;
      const usage = { ...base, output_tokens: last ? finalOut : base.output_tokens };
      return {
        type: 'assistant',
        message: { model: msgModel, id, type: 'message', role: 'assistant', content: [block], usage },
        parent_tool_use_id: parentToolUseId,
        session_id: sessionId,
        ...extra,
      };
    });
    const target = parentToolUseId ? subTotals : null;
    if (target) {
      target.input += base.input_tokens;
      target.output += finalOut;
      target.cacheRead += base.cache_read_input_tokens;
      target.cacheWrite += base.cache_creation_input_tokens;
    } else {
      rootCtx.input += base.input_tokens;
      rootCtx.out += finalOut;
      rootCtx.read += base.cache_read_input_tokens;
      rootCtx.write += base.cache_creation_input_tokens;
    }
    return evs;
  }

  function toolInput(step) {
    const input = { ...(step.input || {}) };
    if (step.file) input.file_path = full(step.file);
    if (input.path && !path.isAbsolute(input.path)) input.path = full(input.path);
    return input;
  }

  function toolResultEvent(toolUseId, step, parentToolUseId, extra = {}) {
    const block = { tool_use_id: toolUseId, type: 'tool_result', content: step.result || '' };
    if (step.isError) block.is_error = true;
    return {
      type: 'user',
      message: { role: 'user', content: [block] },
      parent_tool_use_id: parentToolUseId,
      session_id: sessionId,
      ...extra,
    };
  }

  function stepEvents(step, ctx, parentToolUseId, msgModel, extra) {
    const out = [];
    if (step.think) {
      const blocks = [{ type: 'thinking', thinking: '', signature: 'demo' }, { type: 'text', text: step.think }];
      for (const ev of assistantEvents(ctx, blocks, parentToolUseId, msgModel, extra)) out.push(ev);
      return out;
    }
    const toolUseId = `toolu_demo_${shortId(rng)}`;
    const blocks = [];
    if (rng() < 0.35) blocks.push({ type: 'thinking', thinking: '', signature: 'demo' });
    blocks.push({ type: 'tool_use', id: toolUseId, name: step.tool, input: toolInput(step) });
    for (const ev of assistantEvents(ctx, blocks, parentToolUseId, msgModel, extra)) out.push(ev);
    out.push(toolResultEvent(toolUseId, step, parentToolUseId, extra));
    ctx.size += Math.min(4000, String(step.result || '').length * 2);
    return out;
  }

  // Step list: scenario steps padded with fillers to a random length of 8–20.
  const steps = scenario.steps.slice();
  const wanted = randInt(rng, 8, 20);
  while (steps.length < wanted) {
    const at = randInt(rng, 1, Math.max(1, steps.length - 1));
    steps.splice(at, 0, pick(rng, FILLERS));
  }

  push({
    type: 'system',
    subtype: 'init',
    cwd,
    session_id: sessionId,
    model,
    permissionMode: 'default',
    tools: ['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'TodoWrite', 'WebFetch', 'WebSearch', 'Write'],
    apiKeySource: 'none',
  }, delay(800, 1500));

  for (const step of steps) {
    if (!step.delegate) {
      for (const ev of stepEvents(step, rootCtx, null, model)) push(ev);
      continue;
    }
    // Delegation: one assistant message with one Agent tool_use per subagent.
    const subs = step.delegate.map((d) => ({
      def: d,
      toolUseId: `toolu_demo_${shortId(rng)}`,
      ctx: { size: randInt(rng, 9000, 14000) },
      model: d.subagent_type === 'Explore' ? SUB_MODEL : model,
      taskId: shortId(rng, 17).toLowerCase(),
    }));
    const agentBlocks = subs.map((s) => ({
      type: 'tool_use',
      id: s.toolUseId,
      name: 'Agent',
      input: { description: s.def.description, subagent_type: s.def.subagent_type, prompt: s.def.prompt },
    }));
    for (const ev of assistantEvents(rootCtx, agentBlocks, null, model)) push(ev);
    for (const s of subs) {
      push({
        type: 'system',
        subtype: 'task_started',
        task_id: s.taskId,
        tool_use_id: s.toolUseId,
        description: s.def.description,
        subagent_type: s.def.subagent_type,
        prompt: s.def.prompt,
        session_id: sessionId,
      }, delay(800, 1200));
    }
    // Interleave the subagents' work.
    const queues = subs.map((s) => {
      const extra = { subagent_type: s.def.subagent_type, task_description: s.def.description };
      const evs = [];
      s.def.steps.forEach((st, i) => {
        const sEvents = stepEvents(st, s.ctx, s.toolUseId, s.model, extra);
        if (st.think) {
          evs.push(...sEvents);
          return;
        }
        evs.push(...sEvents.slice(0, -1));
        evs.push({
          type: 'system',
          subtype: 'task_progress',
          task_id: s.taskId,
          tool_use_id: s.toolUseId,
          description: progressLabel(st),
          subagent_type: s.def.subagent_type,
          last_tool_name: st.tool,
          usage: { total_tokens: s.ctx.size, tool_uses: i + 1 },
          session_id: sessionId,
        });
        evs.push(sEvents[sEvents.length - 1]);
      });
      evs.push(...assistantEvents(s.ctx, [{ type: 'text', text: s.def.summary }], s.toolUseId, s.model, extra));
      return evs;
    });
    let remaining = true;
    while (remaining) {
      remaining = false;
      for (const q of queues) {
        if (q.length) {
          push(q.shift());
          remaining = true;
        }
      }
    }
    for (const s of subs) {
      push({
        type: 'system',
        subtype: 'task_notification',
        task_id: s.taskId,
        tool_use_id: s.toolUseId,
        status: 'completed',
        summary: s.def.summary,
        session_id: sessionId,
      }, delay(800, 1200));
      push({
        type: 'user',
        message: { role: 'user', content: [{ tool_use_id: s.toolUseId, type: 'tool_result', content: [{ type: 'text', text: s.def.summary }] }] },
        parent_tool_use_id: null,
        session_id: sessionId,
        tool_use_result: { status: 'completed', agentType: s.def.subagent_type, content: [{ type: 'text', text: s.def.summary }] },
      }, delay(800, 1200));
    }
  }

  const finalText = opts.finalText || scenario.final;
  for (const ev of assistantEvents(rootCtx, [{ type: 'text', text: finalText }], null, model)) push(ev);

  const durationMs = items.reduce((s, it) => s + it.delay, 0) * speed;
  const cost = (
    (rootCtx.input + subTotals.input) * price.input
    + (rootCtx.out + subTotals.output) * price.output
    + (rootCtx.read + subTotals.cacheRead) * price.cacheRead
    + (rootCtx.write + subTotals.cacheWrite) * price.cacheWrite
  ) / 1e6;
  push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: finalText,
    total_cost_usd: Math.round(cost * 1e8) / 1e8,
    duration_ms: Math.round(durationMs),
    num_turns: steps.length,
    session_id: sessionId,
    usage: {
      input_tokens: rootCtx.input,
      output_tokens: Math.round(rootCtx.out * 1.15),
      cache_read_input_tokens: rootCtx.read,
      cache_creation_input_tokens: rootCtx.write,
    },
  }, delay(800, 1500));

  return { items, prompt };
}

function progressLabel(step) {
  if (step.think) return 'Réflexion';
  switch (step.tool) {
    case 'Read':
      return `Lecture de ${path.basename(step.file || '')}`;
    case 'Grep':
    case 'Glob':
      return `Recherche de ${(step.input && step.input.pattern) || 'fichiers'}`;
    case 'Bash':
      return (step.input && step.input.description) || 'Commande en cours';
    default:
      return `Utilise ${step.tool}`;
  }
}

// ------------------------------------------------------------------------------------------------

class DemoSession {
  constructor(runner, agentId, scenarioIndex, model, cwd) {
    this.runner = runner;
    this.manager = runner.manager;
    this.id = agentId;
    this.scenarioIndex = scenarioIndex;
    this.model = model;
    this.cwd = cwd;
    this.sessionId = crypto.randomUUID();
    this.queue = [];
    this.timer = null;
    this.stopped = false;
    this.disposed = false;
  }

  /** Starts a new scenario run (optionally with a user-provided prompt). */
  startScenario(customPrompt) {
    if (this.disposed) return;
    this._clear();
    this.stopped = false;
    const rng = this.runner.random;
    let scenario;
    if (customPrompt) {
      scenario = pick(rng, SCENARIOS);
    } else {
      scenario = SCENARIOS[this.scenarioIndex % SCENARIOS.length];
      this.scenarioIndex += 1 + randInt(rng, 0, 2);
    }
    const prompt = customPrompt || scenario.prompt;
    const cwd = this.cwd;
    const built = buildScenarioEvents({
      rng,
      scenario,
      prompt,
      finalText: customPrompt
        ? `Demande traitée : « ${truncate(customPrompt.replace(/\s+/g, ' ').trim(), 80)} ». J'ai analysé le code concerné, appliqué les modifications nécessaires et vérifié que les tests passent.`
        : null,
      sessionId: this.sessionId,
      cwd,
      model: this.model,
      speed: this.runner.speed,
    });
    this.queue = built.items;
    this._pruneFinishedSubs();
    this.manager.beginTurn(this.id, prompt);
    this._next();
  }

  /**
   * Demo agents loop forever: without pruning, every scenario would leave its finished
   * subagents behind and the office would fill up. Finished helpers leave when a new run starts.
   */
  _pruneFinishedSubs() {
    let ids = [];
    try {
      ids = this.manager.subIdsOf(this.id) || [];
    } catch {
      return;
    }
    for (const subId of ids) {
      const sub = this.manager.get(subId);
      if (!sub || sub.status === 'working' || sub.status === 'starting' || sub.status === 'waiting') continue;
      try {
        this.manager.remove(subId);
      } catch {
        /* already gone */
      }
    }
  }

  _next() {
    if (this.disposed || this.stopped) return;
    if (!this.queue.length) {
      const rest = Math.max(10, Math.round(randInt(this.runner.random, 6000, 12000) / this.runner.speed));
      this.timer = setTimeout(() => {
        this.timer = null;
        this.startScenario();
      }, rest);
      this.timer.unref();
      return;
    }
    const item = this.queue[0];
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed || this.stopped) return;
      this.queue.shift();
      this.runner.emitted += 1;
      this.manager.feed(this.id, item.event);
      this._next();
    }, item.delay);
    this.timer.unref();
  }

  _clear() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Controller API used by AgentManager. */
  stop() {
    this.stopped = true;
    this._clear();
    this.queue = [];
  }

  message(prompt) {
    this.startScenario(prompt);
  }

  dispose() {
    this.disposed = true;
    this._clear();
    this.queue = [];
    this.runner.sessions.delete(this.id);
  }
}

class DemoRunner {
  /**
   * @param {import('./agents').AgentManager} manager
   * @param {{speed?: number, random?: () => number, maxAgents?: number, home?: string}} [opts]
   */
  constructor(manager, opts = {}) {
    this.manager = manager;
    this.speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    this.random = typeof opts.random === 'function' ? opts.random : Math.random;
    this.maxAgents = opts.maxAgents || 16;
    this.home = opts.home || os.homedir();
    this.sessions = new Map(); // agent id -> DemoSession
    this.emitted = 0;
    this.started = 0;
  }

  /** Whether at least one demo agent is live. */
  get active() {
    return this.sessions.size > 0;
  }

  /**
   * Starts `count` new simulated agents (capped so that at most maxAgents are live).
   * @returns {object[]} the created agents
   */
  start(count = 4) {
    const wanted = Math.max(1, Math.min(8, Math.floor(Number(count) || 4)));
    const room = Math.max(0, this.maxAgents - this.sessions.size);
    const n = Math.min(wanted, room);
    const created = [];
    for (let i = 0; i < n; i++) {
      const scenarioIndex = (this.started + i) % SCENARIOS.length;
      const scenario = SCENARIOS[scenarioIndex];
      const model = MODELS[(this.started + i) % MODELS.length];
      const cwd = path.join(this.home, 'Projets', scenario.project);
      const agent = this.manager.createRoot({
        source: 'demo',
        cwd,
        prompt: scenario.prompt,
        status: 'starting',
        canControl: true,
      });
      const session = new DemoSession(this, agent.id, scenarioIndex, model, cwd);
      this.sessions.set(agent.id, session);
      this.manager.attachController(agent.id, session);
      session.startScenario();
      created.push(this.manager.get(agent.id));
    }
    this.started += n;
    return created;
  }

  /** Removes every demo agent. */
  stopAll() {
    for (const id of Array.from(this.sessions.keys())) {
      if (this.manager.get(id)) this.manager.remove(id);
      else {
        const s = this.sessions.get(id);
        if (s) s.dispose();
      }
    }
  }
}

module.exports = { DemoRunner, DemoSession, buildScenarioEvents, SCENARIOS };
