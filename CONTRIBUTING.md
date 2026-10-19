# Contribuer à PixelQG

Merci de vouloir donner un coup de main ! PixelQG est un projet communautaire : code, graphismes, traductions, skills partagés, signalements de bugs, tout compte.

## Partager tes skills et tes agents

Le plus simple, sans écrire de code :
1. Mets tes skills ou tes agents dans un dépôt GitHub **public**. Un skill est un dossier avec un `SKILL.md`, un agent est un fichier `.md` avec un nom et une description en en-tête.
2. Ouvre une discussion dans la catégorie **Show and tell** des [Discussions](https://github.com/hugobertagna/pixelqg-app/discussions), avec le lien du dépôt, ce qu'il apporte et une capture si tu veux.
3. Les autres l'ajoutent depuis l'onglet **Bibliothèque** de PixelQG, en collant le lien.

Vérifie que ton dépôt ne contient ni secret, ni clé d'API, ni donnée personnelle.

## Signaler un bug ou proposer une idée

Ouvre une [issue](https://github.com/hugobertagna/pixelqg-app/issues/new/choose) avec le modèle adapté. Pour un bug, indique ta version de Windows, de PixelQG et de Claude Code (`claude --version`), et ce que tu as fait juste avant. Une capture aide beaucoup. Pense à masquer ton nom d'utilisateur dans les chemins de dossiers.

## Contribuer au code

### Lancer PixelQG depuis le code

```bash
git clone https://github.com/hugobertagna/pixelqg-app.git
cd pixelqg-app
node server/server.js --open
```

Il faut Node.js 20 ou plus récent, et Claude Code installé pour lancer de vrais pix.

### Lancer les tests

```bash
npm test
```

Les tests n'appellent jamais le vrai Claude Code : ils utilisent un faux CLI (`server/test/fake-claude.js`).

### Organisation du code

| Dossier | Contenu |
|---|---|
| `server/` | Serveur Node local : lancement des pix, lecture du flux de Claude Code, terminal intégré, bibliothèque de skills |
| `public/` | Interface : HUD, fenêtres, et le jeu dans `public/js/game/` (bureau, pix, éclairage, progression) |
| `launcher/` | Lanceur Windows `PixelQG.exe` et installateur, en C# compilé avec le `csc` fourni par Windows |
| `tools/` | Fabrication des releases (`node tools/make-release.js`) |
| `docs/` | Guide complet et spécifications techniques |

### Les règles du projet

- **Zéro dépendance.** Seulement Node.js et du JavaScript « vanilla » côté navigateur, sans étape de build. Les seuls fichiers tiers sont ceux de `public/vendor/`.
- **Interface en français,** au tutoiement. Les traductions sont bienvenues : propose d'abord la méthode dans une issue.
- **Commentaires de code en anglais.**
- **Les agents s'appellent des « pix »** dans tous les textes visibles : un pix, des pix.
- **Rien ne s'affiche à l'écran pendant les tests,** ni fenêtre ni popup.
- **Sécurité :** le serveur n'écoute que sur `127.0.0.1`. Ne construis jamais de commande shell avec une donnée venue de la page, et passe toujours les arguments en tableau.

### Proposer une modification

1. Crée une branche à partir de `main`.
2. Fais des commits courts, avec un message clair qui dit pourquoi.
3. Vérifie que `npm test` passe.
4. Ouvre une pull request avec ce qui change, pourquoi, et une capture si l'interface bouge.

Les premières contributions idéales sont marquées `good first issue`.

## Code de conduite

Sois bienveillant et constructif. Pas d'attaques personnelles, pas de harcèlement. Les messages qui ne respectent pas ça sont retirés.

---

**In English:** contributions are welcome in English too. The UI is in French for now; open an issue before starting a translation so we can agree on the approach.
