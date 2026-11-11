# Scrim Simulator

Jeu de management esport FPS (navigateur). Jeu indépendant : tous les noms sont fictifs.


## Classements en ligne

- `src/worker.js` : petit serveur (Cloudflare Worker + Durable Object SQLite) qui stocke les scores publiés (pseudo, score, identifiant aléatoire). Routes : `/api/score`, `/api/top`, `/api/week`, `/api/forget`.
- `wrangler.jsonc` : configuration du déploiement (site statique + serveur). `.assetsignore` empêche de publier ces fichiers comme pages du site.
- Rien à configurer dans le tableau de bord Cloudflare : la base est créée automatiquement au déploiement.
