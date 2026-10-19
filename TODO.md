# Idées à faire — PixelQG

Liste notée le 19 octobre 2026. Ordre de la liste = ordre donné, pas une priorité.

## À finir
- [x] **Confidentialité :** ton nom d'utilisateur a été retiré des images, vidéos et textes du site (chemins en `C:\Users\alex`). Fait le 19 octobre.
- [ ] **Recapturer les images du site avec la nouvelle interface de jeu.** Elles montrent encore l'ancienne interface, avec le profil fictif.
- [x] **Renommer le dossier `claude-hq` en `pixelqg-app`.** Fait le 19 octobre.

## Vidéo
- [x] ~~**Voix off sur la vidéo.**~~ Abandonné le 19 octobre : tu préfères la vidéo sans voix, avec la musique seule.
- [ ] **Refaire la vidéo avec toutes les nouveautés** une fois le reste fait (dernière étape).

## Appli
- [ ] **Compatible Mac, Linux et Android.**
  Note : le serveur et le jeu marchent déjà hors Windows. Le terminal intégré utilise le pseudo-terminal Windows et devra avoir un équivalent Mac/Linux. Le lanceur `PixelQG.exe` aussi. Android rejoint l'idée « gérer depuis le téléphone » plus bas.
- [x] **Enlever le mode démo.** Fait le 19 octobre.
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
- [x] **Workshop communautaire (v1) :** page `workshop.html`, publication réservée aux acheteurs, commentaires. Fait le 19 octobre. Reste éventuellement : packs payants.
- [ ] **Shop communautaire de packs de skills et d'agents :** les gens publient leurs agents, gratuits ou payants, avec des commentaires. Il faudra des comptes utilisateurs, donc un vrai serveur et une base de données.
  On détaillera ensemble : modération, paiements, sécurité des packs.

## Licence et comptes
- [x] **Licence liée à un compte :** connexion obligatoire dans l'appli, certificat signé par PC (3 PC par licence, valable 14 jours hors ligne), backend Supabase « pixelqg » (Paris). Fait le 19 octobre.
- [ ] **Stripe (en dernier) :** lien de paiement à 10 €, webhook vers la fonction `stripe-webhook`, secret `STRIPE_WEBHOOK_SECRET`. En attendant, licences attribuées à la main depuis « Mon compte ».
- [ ] **Créer ton compte administrateur** (gestion des comptes, licences et shop). Je te guiderai étape par étape. C'est toi qui créeras le compte et choisiras le mot de passe.

## Lancement et pub
- [ ] **Faire la pub de l'appli** une fois tout prêt. Je te guiderai : où publier (réseaux, communautés de devs, forums Claude Code), quels formats (la vidéo, des extraits courts, des captures) et quels messages.

## Déjà en place (pour mémoire)
- Appli : bureau en pixel art (10 pièces, jour/nuit, niveaux, succès), lancement d'agents, terminal intégré qui relie les sessions `claude`, bibliothèque de dépôts GitHub de skills, `PixelQG.exe` sur le bureau.
- Site de vente PixelQG en ligne sur https://pixelqg-site.pages.dev/ (Cloudflare Pages, gratuit), avec vidéo de démo navigable. À faire avant de vendre : lien de paiement Stripe dans `config.js`, mentions légales et CGV, zip de l'appli pour les acheteurs.
- Code sur GitHub en privé : `hugobertagna/pixelqg-app` et `hugobertagna/pixelqg-site`. Serveurs MCP Supabase et Cloudflare branchés.
