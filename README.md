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
ouvrez deux navigateurs avec deux profils pour voir le temps réel.

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
server/
  index.js     API REST + WebSockets + planificateur Pulse / gel des cycles
  db.js        schéma relationnel SQLite (better-sqlite3, WAL)
  seed.js      données de démonstration
  verbs.js     module NLP local : validation des verbes d'action
  keywords.js  extraction de mots-clés des rétrospectives
public/
  index.html / styles.css / app.js   SPA sans dépendance, thème clair/sombre
```

- **Temps réel** : WebSockets — statuts RAG, actions terminées et objectifs
  se synchronisent instantanément sur l'écran de toute l'escouade (et de la
  Direction).
- **Zéro personnalisation structurelle** : pas de colonnes ni de champs
  personnalisés, la méthode dicte l'interface.
- **Design** : white space, typographie claire, mode sombre/clair
  automatique, aucune pastille de notification anxiogène.
- **Base de données** : SQLite en mode WAL ; le schéma est purement
  relationnel et transposable tel quel vers PostgreSQL pour la production.
- **Visio** : les liens de réunion Pulse sont générés sur Jitsi Meet
  (fonctionnels sans clé API) ; l'architecture webhook permet de brancher
  Google Meet / Teams / Zoom.
