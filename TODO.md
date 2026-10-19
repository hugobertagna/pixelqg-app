# Idées à faire — PixelQG

Liste notée le 19 octobre 2026. Ordre de la liste = ordre donné, pas une priorité.

## À finir
- [ ] **Confidentialité, à faire avant toute mise en ligne :** retirer ton vrai nom d'utilisateur et tes chemins de dossiers de toutes les images du site, de la vidéo de démo et de la boucle vidéo du haut de page. Les remplacer par un profil fictif, par exemple `C:\Users\alex\Projets\…`.
  Comment : refaire les captures avec un profil Windows fictif pour le serveur de démo, puis régénérer les images et les vidéos du site.
- [x] **Renommer le dossier `claude-hq` en `pixelqg-app`.** Fait le 19 octobre.

## Vidéo
- [ ] **Voix off sur le texte du début de la vidéo.**
  Note : la vidéo se refait à partir de `pixelqg-site/video-src` (rendu image par image + ffmpeg). Il faudra choisir une voix : la tienne, ou une voix de synthèse.
- [ ] **Refaire la vidéo avec toutes les nouveautés** une fois le reste fait (dernière étape).

## Appli
- [ ] **Compatible Mac, Linux et Android.**
  Note : le serveur et le jeu marchent déjà hors Windows. Le terminal intégré utilise le pseudo-terminal Windows et devra avoir un équivalent Mac/Linux. Le lanceur `PixelQG.exe` aussi. Android rejoint l'idée « gérer depuis le téléphone » plus bas.
- [ ] **Enlever le mode démo.**
- [ ] **Bouton « Mes skills » :** lister tous les skills installés dans ton Claude Code (et les plugins), en montrant ceux qui appellent des agents.
- [ ] **Remplacer les petits Claude par les robots PixelQG de la vidéo**, dans l'appli (personnages, avatars, icône).
  Note : ça règle aussi le souci de marque pour la vente.
- [ ] **Groupes d'agents :** regrouper des agents par spécialité (par exemple « Bug bounty », « Web design ») et utiliser un groupe d'un coup. Il faudra choisir comment : lancer toute l'équipe sur une mission, ou un chef de groupe qui délègue aux autres.
  Note : ça rejoint la bibliothèque (profils d'agents) et le bouton « Mes skills ». Dans le jeu, chaque groupe pourrait avoir son propre coin du bureau.
- [ ] **Ajouter des serveurs MCP directement depuis l'appli.**
- [ ] **Voir dans le jeu le site qu'un agent développe** (par exemple un grand écran dans le bureau qui affiche le site en direct).
- [ ] **Ajouter des clés API pour brancher d'autres IA** si besoin.
- [ ] **Version téléphone :** gérer tes agents depuis ton mobile quand le PC tourne chez toi.
  Note : demande un accès sécurisé de l'extérieur (authentification solide). Piste à étudier : la fonction Remote Control de Claude Code.

## Site
- [ ] **Shop communautaire de packs de skills et d'agents :** les gens publient leurs agents, gratuits ou payants, avec des commentaires. Il faudra des comptes utilisateurs, donc un vrai serveur et une base de données.
  On détaillera ensemble : modération, paiements, sécurité des packs.

## Licence et comptes
- [ ] **Licence liée à un compte :** à l'installation, l'appli demande de se connecter. Sans compte connecté avec une licence valide, l'appli ne s'utilise pas.
  Note : ce sont les mêmes comptes que le site et le shop. Il faut un serveur de licences : achat, activation sur un PC, vérification au démarrage. Il faut aussi décider combien de temps l'appli marche hors connexion, et sur combien de PC une licence s'active.
- [ ] **Créer ton compte administrateur** (gestion des comptes, licences et shop). Je te guiderai étape par étape. C'est toi qui créeras le compte et choisiras le mot de passe.

## Lancement et pub
- [ ] **Faire la pub de l'appli** une fois tout prêt. Je te guiderai : où publier (réseaux, communautés de devs, forums Claude Code), quels formats (la vidéo, des extraits courts, des captures) et quels messages.

## Déjà en place (pour mémoire)
- Appli : bureau en pixel art (10 pièces, jour/nuit, niveaux, succès), lancement d'agents, terminal intégré qui relie les sessions `claude`, bibliothèque de dépôts GitHub de skills, `PixelQG.exe` sur le bureau.
- Site de vente PixelQG : `pixelqg-site/index.html` + vidéo de démo. À faire avant de vendre : lien de paiement dans `config.js`, mentions légales et CGV, hébergement, zip de l'appli pour les acheteurs.
