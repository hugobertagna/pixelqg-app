# PixelQG

**PixelQG** est un petit QG en pixel art qui tourne sur ton ordinateur : tu y lances des agents
**Claude Code**, et tu les regardes travailler dans un bureau, comme dans un jeu. Chaque agent est un
petit bonhomme Clawd (la mascotte de Claude Code) avec sa propre couleur et son prénom. Quand il lit
des fichiers, il file à la bibliothèque ; quand il lance une commande, il court à la salle serveurs ;
quand il a fini, il va prendre un café.

Pour chaque agent tu vois en direct : ce qu'il fait, les outils qu'il utilise, les jetons (tokens)
consommés, le coût, le temps de travail, ses sous-agents et le journal complet de son activité.

- 100 % local : rien n'est envoyé ailleurs que vers Claude Code lui-même.
- Aucune dépendance npm : uniquement Node.js.
- Un **mode démo** permet de tout essayer sans dépenser le moindre jeton.

---

## Prérequis

| Outil | Version | Vérifier |
|---|---|---|
| [Node.js](https://nodejs.org) | 20 ou plus récent | `node --version` |
| Claude Code (`npm install -g @anthropic-ai/claude-code`) | installé **et connecté** | `claude --version`, puis `claude` une fois pour te connecter |

Le mode démo fonctionne même sans Claude Code.

---

## Lancer PixelQG

### Windows (le plus simple)

Double-clique sur **`start.bat`**. Une fenêtre noire s'ouvre (c'est le serveur : laisse-la ouverte),
puis PixelQG s'affiche dans une fenêtre Edge dédiée (sinon dans ton navigateur par défaut).

Pour arrêter : ferme la fenêtre noire ou appuie sur **Ctrl+C** dedans. Les agents encore en train de
travailler sont alors stoppés proprement.

### En ligne de commande (Windows, macOS, Linux)

```bash
npm start          # lance le serveur, puis ouvre http://127.0.0.1:4317
npm run demo       # idem, avec 4 agents simulés (aucun jeton dépensé)
./start.sh         # macOS / Linux : lance et ouvre le navigateur (chmod +x start.sh la première fois)
```

Options disponibles (aussi utilisables avec `start.bat` / `start.sh`, par exemple `start.bat --demo`) :

| Option | Effet |
|---|---|
| `--port N` | port d'écoute (par défaut 4317 ; variable d'environnement `HQ_PORT` possible) |
| `--demo` | démarre 4 agents simulés |
| `--no-observe` | n'observe pas les sessions Claude Code lancées ailleurs |
| `--open` | ouvre le navigateur automatiquement |

---

## Utiliser PixelQG

1. Dans le **lanceur** (sous le bureau), écris ta demande (le *prompt*), choisis éventuellement un
   nom, une couleur, un modèle, un mode de permission, un niveau d'effort et le dossier de travail.
2. Clique sur **« Lancer l'agent »** (ou **Ctrl+Entrée**). Un nouveau bonhomme sort de l'ascenseur.
3. Clique sur un agent (dans le bureau ou dans la liste à droite) pour voir son détail : statut,
   jetons (entrée / sortie / cache lu / cache écrit), coût, outils utilisés, sous-agents, résultat
   et journal en direct.
4. Quand il a fini, tu peux lui **envoyer un nouveau message** : il reprend la même session
   (avec tout le contexte de la conversation précédente).
5. **« Arrêter »** stoppe immédiatement l'agent (et tous ses processus). **« Retirer »** l'enlève
   du bureau.

### Les pièces du bureau

| Pièce | Ce que l'agent y fait |
|---|---|
| **Open space** (au centre) | il écrit ou modifie du code, réfléchit ou rédige sa réponse — chacun a son bureau attitré |
| **Bibliothèque** (en haut à gauche) | il lit des fichiers ou cherche dans le projet (Read, Glob, Grep…) |
| **Salle serveurs** (en haut à droite) | il exécute des commandes (Bash, PowerShell…) |
| **Labo web** (à droite) | il consulte le web (WebFetch, WebSearch) ou utilise un outil externe (MCP…) |
| **Salle de réunion** (en bas à gauche) | il délègue à un sous-agent ou organise ses tâches ; les sous-agents apparaissent ici, à côté de leur parent |
| **Cafétéria** (en bas à droite) | il a terminé, il est arrêté ou en pause |
| **Entrée** (ascenseur, en bas) | les agents arrivent et repartent par ici |

### Les statuts

| Statut | Signification |
|---|---|
| Démarre | Claude Code est en train de se lancer |
| Travaille | un tour est en cours |
| En attente | session externe inactive depuis 90 secondes |
| Terminé | le tour s'est bien terminé (le coût final est affiché) |
| Erreur | Claude Code a planté ou signalé une erreur (le message est affiché) |
| Arrêté | tu as arrêté l'agent |

### Modèles et effort

- **Modèle** : « Par défaut » utilise le modèle configuré dans ton Claude Code ; Haiku est rapide et
  économique ; Sonnet et Opus sont plus puissants ; Fable est le plus puissant.
- **Effort** : plus l'effort est élevé, plus l'agent réfléchit (et consomme de jetons).

---

## Modes de permission

Un agent lancé par PixelQG tourne **sans fenêtre de confirmation** : personne n'est là pour
cliquer « Autoriser ». Le mode de permission décide donc de ce que l'agent a le droit de faire tout seul.

| Mode | Ce que l'agent peut faire |
|---|---|
| **Prudent** (par défaut) | lire et chercher ; toute modification ou commande non autorisée d'avance est refusée |
| **Modifications de fichiers autorisées** | créer et modifier des fichiers dans le dossier de travail |
| **Auto** | Claude Code décide lui-même, avec ses garde-fous automatiques |
| **Plan** | réfléchit et propose un plan, sans rien modifier |
| **Tout autoriser (dangereux)** | **tout** : modifier ou supprimer n'importe quel fichier, lancer n'importe quelle commande, sans aucune confirmation |

> ⚠️ **Attention avec « Tout autoriser ».** L'agent peut alors effacer des fichiers, exécuter des
> commandes système ou modifier ton ordinateur sans te demander. Ne l'utilise que dans un dossier de
> travail dédié (idéalement un projet sous Git, ou une machine virtuelle / un conteneur), avec des
> prompts dont tu es sûr. En cas de doute, choisis **Prudent** ou **Modifications de fichiers autorisées**.

Choisis aussi le **dossier de travail** avec soin : c'est là que l'agent lit et écrit.

---

## Sessions externes (observation)

PixelQG affiche aussi, avec un petit œil 👁, les sessions Claude Code que tu as lancées ailleurs
(dans un terminal, dans un éditeur…). Pour cela il lit, **en lecture seule**, les journaux que
Claude Code écrit dans `~/.claude/projects/` (ou `$CLAUDE_CONFIG_DIR/projects/`) :

- seules les sessions modifiées dans les **10 dernières minutes** apparaissent ;
- un agent observé passe « En attente » après **90 secondes** sans activité et disparaît après
  **20 minutes** sans changement ;
- on ne peut pas arrêter ni écrire à une session observée (elle ne t'appartient pas ici) ;
  « Retirer » la masque jusqu'à sa prochaine activité ;
- les sous-agents de ces sessions apparaissent aussi.

Tu peux désactiver l'observation avec le bouton **« Sessions externes »** ou l'option `--no-observe`.

---

## Terminal intégré

PixelQG contient un vrai terminal Windows (l'invite de commandes `cmd.exe`) : c'est l'onglet
**« Terminal »** du panneau sous le bureau. Tu y travailles comme dans n'importe quel terminal, et
surtout : **quand tu y tapes `claude`, la session apparaît dans le bureau.**

1. Choisis le dossier de travail (et, si tu veux, un nom et une couleur), puis clique sur
   **« Nouveau terminal »**.
2. Tape `claude`, avec tes options habituelles si besoin (`claude --model opus`, `claude -c`,
   `claude --resume`…). Claude Code démarre normalement, avec son interface complète.
3. Un petit bonhomme sort de l'ascenseur, relié à cette session : nom, couleur, jetons, activité,
   minuteur et journal, exactement comme un agent lancé depuis le formulaire.

Le bouton **« Lancer Claude Code »** fait tout d'un coup : il ouvre un terminal et y tape `claude`
pour toi (pour choisir un modèle, tape plutôt `claude --model opus` dans un « Nouveau terminal »).
Le nom et la couleur choisis pour un terminal sont donnés aux sessions lancées dedans (sinon, le
prochain prénom libre). Le bouton **« Agrandir »** donne au terminal les deux tiers de l'écran.

| Dans le terminal | Dans le bureau |
|---|---|
| Claude Code démarre | « Démarre », puis « T'attend » (Claude attend ton premier message) |
| tu envoies un message | « Travaille » : le bonhomme lit, cherche, exécute… |
| Claude a fini de répondre | « T'attend » — « Attend ta réponse » : il reste à son bureau avec un « ? » |
| tu quittes Claude Code (`/exit`, Ctrl+C deux fois) | « Terminé » |
| Claude Code s'arrête avec une erreur | « Erreur » (avec son code de sortie) |
| tu cliques « Arrêter », ou tu fermes le terminal | « Arrêté » |

Bon à savoir :

- Pour répondre à un agent du terminal, écris directement dans son terminal : sa fiche propose
  **« Voir son terminal »** à la place du champ de message.
- Le coût d'une session interactive n'est pas connu (affiché « — ») : les journaux de Claude Code ne
  le contiennent pas. Les jetons, eux, sont bien comptés.
- `claude -p …`, `claude --version`, `claude mcp …`, `claude update`… fonctionnent normalement mais
  ne créent pas d'agent : ce ne sont pas des sessions.
- Avec `claude --continue` (ou `claude --resume` sans identifiant), le bonhomme apparaît tout de suite
  et se relie à la conversation reprise dès que Claude Code y écrit. `claude --resume <identifiant>`
  d'une session déjà affichée réveille le même bonhomme.
- Les sessions des terminaux sont suivies même quand « Sessions externes » est désactivé, et ne sont
  jamais affichées une deuxième fois comme session observée.
- Jusqu'à **8 terminaux** ouverts en même temps. Fermer un terminal arrête ce qui tourne dedans (ses
  agents restent dans le bureau) ; quand PixelQG s'arrête, tous les terminaux sont fermés.
- Le terminal intégré n'existe que sous **Windows** pour le moment (Windows 10 version 1809 ou plus
  récent) ; ailleurs, l'onglet t'explique pourquoi il est indisponible.

Sous le capot :

- Node.js n'a pas de pseudo-terminal intégré : un petit programme C#, `server/bin/hq-pty.exe` (source
  `hq-pty.cs`), utilise la pseudo-console de Windows (ConPTY). PixelQG le compile tout seul au
  démarrage, avec le compilateur fourni avec Windows (.NET Framework 4), s'il manque ou si sa source a
  changé ; tu peux aussi lancer `server\bin\build-pty.bat`. Aucune fenêtre ne s'ouvre : le terminal
  n'existe que dans la page, et tout ce qu'il lance s'arrête avec lui.
- Dans ces terminaux, le dossier `server/shim` est placé en tête du `PATH` : la commande `claude` passe
  par un petit relais (`server/claude-shim.js`) qui prévient PixelQG, lance le vrai Claude Code dans
  le même terminal, puis signale sa fin. Si PixelQG ne répond pas, Claude Code démarre quand même
  (une ligne grisée te le signale).

---

## Bibliothèque de skills

L'onglet **Bibliothèque** (à côté de « Nouvel agent » et « Terminal ») te permet de lier un dépôt GitHub
public de skills, d'agents ou de commandes Claude Code, par exemple `anthropics/skills` ou
`https://github.com/wshobson/agents`. PixelQG le clone (Git doit être installé), repère ce qu'il
contient et le rend disponible à **tous** les agents qu'il lance : formulaire, messages de suivi et
terminal intégré. Ta configuration globale de Claude Code n'est jamais modifiée.

- Chaque dépôt peut être activé ou désactivé, élément par élément si tu veux, mis à jour ou retiré.
- Les agents d'un dépôt deviennent des **profils** : choisis-en un dans le champ « Profil » du
  lanceur ou du terminal, et la session tourne comme cet agent (`--agent dépôt:agent`).
- Tout est rangé dans `%USERPROFILE%\.pixelqg` (ou le dossier de la variable `PIXELQG_HOME`) :
  les clones dans `repos\`, les plugins générés dans `library\`, passé à Claude Code avec
  `--plugin-dir`. Dans le terminal, si tu donnes toi-même `--plugin-dir`, PixelQG n'ajoute rien.
- Sécurité : les skills et agents donnent des instructions à Claude, ne lie que des dépôts de
  confiance. Les hooks (commandes automatiques) et les serveurs MCP d'un dépôt ne sont **jamais**
  chargés. Git tourne sans fenêtre et ne demande jamais d'identifiants : seuls les dépôts publics
  sont pris en charge.

---

## Sécurité

- Le serveur n'écoute que sur **127.0.0.1** (ton ordinateur) : il est inaccessible depuis le réseau.
- À chaque démarrage, un **jeton secret** aléatoire est généré et glissé dans la page ; toutes les
  requêtes de l'API doivent le présenter. Un autre site ouvert dans ton navigateur ne peut donc pas
  piloter tes agents.
- Les requêtes venant d'un autre nom d'hôte ou d'une autre origine sont refusées (protection contre
  le *DNS rebinding*).
- Le prompt est transmis à Claude Code par l'entrée standard, jamais par la ligne de commande, et
  aucun shell n'est utilisé pour lancer les processus.
- Le terminal intégré passe par une connexion WebSocket locale soumise aux mêmes contrôles (jeton,
  hôte, origine). Les programmes lancés dans un terminal (Claude Code et ses commandes compris) ne
  reçoivent jamais le jeton de la page : seulement un jeton propre à leur terminal, qui sert
  uniquement à y relier les sessions Claude Code.
- Le serveur de PixelQG n'écrit rien sur disque : l'historique affiché vit en mémoire et disparaît à l'arrêt
  (les sessions restent consultables dans Claude Code lui-même).
- Les agents utilisent **ton** compte Claude Code : leurs actions et leur consommation sont les tiennes.

---

## Dépannage

**« Claude Code introuvable »**
PixelQG cherche `claude` dans ton `PATH` (et les emplacements d'installation habituels). Vérifie
que `claude --version` fonctionne dans un terminal. Sinon, indique le chemin exact avec la variable
d'environnement `CLAUDE_BIN` avant de lancer :

```bat
:: Windows (invite de commandes)
set CLAUDE_BIN=C:\Users\toi\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe
start.bat
```

```bash
# macOS / Linux
CLAUDE_BIN=/chemin/vers/claude npm start
```

`CLAUDE_BIN` accepte un exécutable, un fichier `.cmd` créé par npm, ou un fichier `.js` (lancé avec Node).

**« Le port est occupé »**
Si le port 4317 est déjà pris, PixelQG essaie automatiquement les 10 suivants (l'adresse réelle est
affichée au démarrage). Tu peux aussi choisir un port : `start.bat --port 5000` ou `set HQ_PORT=5000`.

**L'agent passe tout de suite en « Erreur »**
Ouvre son détail : le message d'erreur de Claude Code y est affiché. Causes fréquentes : Claude Code
n'est pas connecté (lance `claude` une fois dans un terminal pour te connecter), dossier de travail
inaccessible, quota atteint.

**L'agent refuse de modifier des fichiers**
C'est le mode **Prudent** : relance-le avec « Modifications de fichiers autorisées ».

**La page reste vide ou affiche « Jeton d'accès invalide »**
Le serveur a redémarré : recharge la page (F5). Vérifie aussi que la fenêtre noire du serveur est
toujours ouverte.

**Node.js est introuvable**
Installe Node.js 20+ depuis [nodejs.org](https://nodejs.org), puis rouvre `start.bat`.

**L'onglet « Terminal » dit que le terminal est indisponible**
La raison est affichée dans l'onglet (et au démarrage du serveur). Le plus souvent : Windows trop
ancien, ou `hq-pty.exe` impossible à compiler. Lance `server\bin\build-pty.bat` dans une invite de
commandes pour voir l'erreur du compilateur, puis redémarre PixelQG.

**Je tape `claude` dans le terminal mais aucun bonhomme n'apparaît**
Vérifie que tu es bien dans un terminal de PixelQG : `where claude` doit afficher en premier
`…\pixelqg-app\server\shim\claude.cmd`. Si une ligne grisée « liaison impossible » s'affiche, PixelQG
n'a pas répondu à temps : Claude Code tourne quand même, mais sans bonhomme. Quitte-le (`/exit`) et
relance `claude`, ou ouvre un nouveau terminal.

---

## Pour les curieux

```bash
npm test     # lance les tests (aucun vrai agent n'est démarré : un faux Claude Code est utilisé)
```

```
pixelqg-app/
  start.bat / start.sh   lanceurs
  server/                serveur Node (API, flux temps réel, lancement et lecture des agents)
    terminals.js, ws.js  terminal intégré et sa connexion WebSocket
    claude-shim.js       relais de la commande `claude` des terminaux (shim/claude.cmd)
    bin/                 pont pseudo-console hq-pty (source C#, script de compilation)
    test/                tests automatiques et faux Claude Code
  public/                interface (bureau en pixel art, panneaux, journal)
  docs/CONTRACT.md       spécification technique (docs/TERMINAL.md pour le terminal)
```
