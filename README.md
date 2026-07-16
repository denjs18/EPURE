# épure.

**L'outil d'anti-gestion de projet.** Épure limite drastiquement la charge
mentale des équipes en forçant la simplicité : son ergonomie empêche
physiquement les usines à gaz, le multitâche et les réunions inutiles.

Trois objectifs. Un tableau unique. Zéro réunion inutile.

---

## Démarrage

```bash
npm install
npm start
```

L'application est disponible sur **http://localhost:3000**. La base de
données (SQLite, relationnelle) est créée et remplie de données de
démonstration au premier lancement : une Direction et deux Escouades avec
leurs cycles, objectifs et actions.

```bash
npm run seed   # repartir de zéro avec les données de démonstration
npm run dev    # serveur avec rechargement automatique
```

Aucune configuration requise. Choisissez un profil sur l'écran d'entrée
(chef d'équipe, membre ou Direction) pour explorer les différents rôles —
ouvrez deux navigateurs avec deux profils pour voir la synchronisation
(les écrans se rafraîchissent par polling).

## Les 5 modules

| Module | Rôle |
|---|---|
| **Étoile du Nord** | Bandeau de 3 emplacements d'objectifs, pas un de plus. Un 4ᵉ objectif déclenche la modale **Swap** : il faut archiver ou remettre au backlog un objectif actif. Un objectif dont toutes les actions sont terminées disparaît et libère son slot. |
| **Moteur TAF** | Le tableau central. Une ligne n'est enregistrable que si les 4 règles sont remplies : liaison à un objectif actif, **verbe d'action** validé en temps réel par le module NLP, **pilote unique**, livrable + échéance. Une action cochée disparaît en fondu vers l'historique filtrable. |
| **Métronome** | Curseur horizontal de 3 jours à 1 mois qui remplace les sprints. Compte à rebours discret « J-4 avant l'Évaluation ». |
| **Pulse** | Routine matinale automatisée : zéro action rouge → webhook « Réunion Pulse annulée » ; au moins une rouge → lien visio de 10 min généré, invitation limitée aux pilotes bloqués et au chef d'équipe. Webhook Slack/Teams configurable. |
| **Évaluation Éclair** | À l'échéance du Métronome, l'interface **gèle** pour toute l'équipe : une seule question (« Qu'est-ce qui nous a ralenti ? »), 3 minutes chrono. Les mots-clés extraits sont épinglés à côté de l'Étoile du Nord du cycle suivant. |

## Alignement Fractal

- **Niveau 1 — Direction** : 3 Macro-Objectifs à grandes échéances, sans TAF.
- **Niveau 2 — Escouades** : chaque escouade ne voit que son tableau ;
  la **Règle de Liaison** oblige à rattacher chaque objectif d'escouade à un
  Macro-Objectif.
- **Vue Zoom** : la Direction visualise l'arbre fractal — le statut
  Vert/Orange/Rouge des objectifs de chaque escouade, sans le détail du TAF.

## Architecture

```
api/
  index.js     point d'entrée serverless Vercel (réexporte l'app Express)
server/
  app.js       application Express : API REST + gel des cycles + scan Pulse
  index.js     point d'entrée local (serveur HTTP persistant)
  db.js        couche de données à double pilote (SQLite / PostgreSQL / PGlite)
  seed.js      données de démonstration
  verbs.js     module NLP local : validation des verbes d'action
  keywords.js  extraction de mots-clés des rétrospectives
public/
  index.html / styles.css / app.js   SPA sans dépendance, thème clair/sombre
vercel.json    routage /api/* + Cron quotidien du Pulse
```

- **Temps réel** : polling — statuts RAG, actions terminées, objectifs et gel
  de la rétrospective se synchronisent sur l'écran de toute l'escouade. Le
  polling se met en pause pendant une saisie (formulaire TAF, modale, réponse
  de rétrospective) pour ne rien perturber.
- **Zéro personnalisation structurelle** : pas de colonnes ni de champs
  personnalisés, la méthode dicte l'interface.
- **Design** : white space, typographie claire, mode sombre/clair
  automatique, aucune pastille de notification anxiogène.
- **Base de données à double pilote** : SQLite en local (zéro config), et
  PostgreSQL dès qu'une variable `POSTGRES_URL` est présente. Les requêtes
  métier sont écrites une seule fois ; les dates sont générées en ISO-8601
  côté serveur pour un comportement identique quel que soit le moteur.
- **Visio** : les liens de réunion Pulse sont générés sur Jitsi Meet
  (fonctionnels sans clé API) ; l'architecture webhook permet de brancher
  Google Meet / Teams / Zoom.

## Déploiement sur Vercel

L'application tourne en serverless sur Vercel, avec la base Postgres intégrée.

1. **Importer le dépôt** dans Vercel (New Project → Import).
2. **Créer la base** : onglet *Storage* → *Create Database* → *Postgres*, puis
   la connecter au projet. Vercel injecte automatiquement `POSTGRES_URL` — le
   code bascule alors seul sur PostgreSQL (plus besoin de SQLite).
3. **Déployer.** Au premier appel, le schéma est créé et les données de
   démonstration sont insérées automatiquement.

Détails techniques du portage serverless :

| Besoin | Solution |
|---|---|
| Données | Postgres Vercel (variable `POSTGRES_URL`, pilote `pg`) |
| Temps réel | Polling client (pas de WebSocket, incompatible serverless) |
| Routine Pulse | **Vercel Cron** → `GET /api/cron/pulse` (voir `vercel.json`) |
| Gel des cycles | Paresseux : évalué à chaque chargement d'état, sans tâche de fond |

- **Cron** : `vercel.json` planifie un scan quotidien du Pulse. Pour le
  protéger, définis la variable `CRON_SECRET` dans le projet Vercel — elle est
  automatiquement envoyée en en-tête `Authorization` par les exécutions Cron.
  Sur le plan Hobby, le Cron est limité à une exécution par jour ; le bouton
  **« Scanner maintenant »** permet de déclencher le Pulse à la demande, et le
  plan Pro autorise une fréquence plus fine (ex. `0 * * * *`).
- **Tester le dialecte Postgres en local**, sans serveur : `npm run seed:pglite`
  puis `PGLITE=1 npm start` (Postgres embarqué en WebAssembly).

> Autre option, sans aucune modification : les plateformes à serveur persistant
> (Render, Railway, Fly.io) exécutent `npm start` tel quel. Le double pilote
> reste actif (SQLite par défaut, Postgres si `POSTGRES_URL` est fournie).
