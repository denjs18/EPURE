// Données de démonstration : une direction, deux escouades, cycles,
// objectifs liés aux macro-objectifs et actions TAF réalistes.
import { db } from './db.js';

const now = () => new Date();

function iso(date) {
  return date.toISOString();
}

function daysFromNow(days) {
  const d = now();
  d.setDate(d.getDate() + days);
  return d;
}

function dateOnly(days) {
  return daysFromNow(days).toISOString().slice(0, 10);
}

export function isSeeded() {
  return db.prepare('SELECT COUNT(*) AS n FROM teams').get().n > 0;
}

export function reset() {
  db.exec(`
    DELETE FROM pulse_events; DELETE FROM retro_answers; DELETE FROM actions;
    DELETE FROM cycles; DELETE FROM objectives; DELETE FROM users; DELETE FROM teams;
  `);
}

export function seed() {
  const insTeam = db.prepare(
    'INSERT INTO teams (name, kind, pulse_time) VALUES (?, ?, ?)'
  );
  const insUser = db.prepare(
    'INSERT INTO users (team_id, name, role, color) VALUES (?, ?, ?, ?)'
  );
  const insObjective = db.prepare(
    `INSERT INTO objectives (team_id, title, status, macro_id, due_date, activated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insCycle = db.prepare(
    `INSERT INTO cycles (team_id, duration_days, started_at, ends_at, status, retro_keywords, closed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insAction = db.prepare(
    `INSERT INTO actions (team_id, objective_id, cycle_id, title, pilot_id, deliverable, due_date, rag, done, done_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  const direction = insTeam.run('Direction', 'direction', '09:00').lastInsertRowid;
  const produit = insTeam.run('Escouade Produit', 'squad', '09:00').lastInsertRowid;
  const marketing = insTeam.run('Escouade Marketing', 'squad', '09:30').lastInsertRowid;

  const claire = insUser.run(direction, 'Claire Fontaine', 'leader', '#5B7B6C').lastInsertRowid;
  insUser.run(direction, 'Marc Delval', 'member', '#8A6D5B');

  const yann = insUser.run(produit, 'Yann Morel', 'leader', '#4A6FA5').lastInsertRowid;
  const ines = insUser.run(produit, 'Inès Ferrand', 'member', '#A5744A').lastInsertRowid;
  const theo = insUser.run(produit, 'Théo Lambert', 'member', '#6C5B7B').lastInsertRowid;
  const lea = insUser.run(produit, 'Léa Guichard', 'member', '#3E8E7E').lastInsertRowid;

  const sofia = insUser.run(marketing, 'Sofia Ricci', 'leader', '#B0574F').lastInsertRowid;
  const hugo = insUser.run(marketing, 'Hugo Blanchet', 'member', '#54708C').lastInsertRowid;
  const anna = insUser.run(marketing, 'Anna Keller', 'member', '#7C8A4D').lastInsertRowid;

  // Macro-objectifs de la Direction (grandes échéances, pas de TAF).
  const macro1 = insObjective.run(
    direction, "Lancer l'offre Entreprise avant la fin du trimestre",
    'active', null, dateOnly(45), iso(daysFromNow(-20))
  ).lastInsertRowid;
  const macro2 = insObjective.run(
    direction, 'Réduire le churn client de 20 %',
    'active', null, dateOnly(75), iso(daysFromNow(-20))
  ).lastInsertRowid;
  insObjective.run(
    direction, "Ouvrir le marché espagnol",
    'backlog', null, null, null
  );

  // Escouade Produit : cycle en cours (Métronome 10 jours, démarré il y a 6 jours).
  const cycleProduit = insCycle.run(
    produit, 10, iso(daysFromNow(-6)), iso(daysFromNow(4)), 'run',
    JSON.stringify([
      { word: 'dépendances', count: 3 },
      { word: 'validation', count: 2 },
      { word: 'tardive', count: 2 },
    ]),
    null
  ).lastInsertRowid;

  const objSSO = insObjective.run(
    produit, "Livrer l'authentification SSO pour les grands comptes",
    'active', macro1, null, iso(daysFromNow(-6))
  ).lastInsertRowid;
  const objOnboarding = insObjective.run(
    produit, "Refondre le parcours d'onboarding",
    'active', macro2, null, iso(daysFromNow(-6))
  ).lastInsertRowid;
  insObjective.run(produit, 'Automatiser la facturation annuelle', 'backlog', null, null, null);
  insObjective.run(produit, "Réécrire l'API publique en v2", 'backlog', null, null, null);

  insAction.run(produit, objSSO, cycleProduit, 'Coder le connecteur SAML côté backend',
    theo, 'Pull request GitHub', dateOnly(2), 'green', 0, null);
  insAction.run(produit, objSSO, cycleProduit, "Tester l'intégration avec Okta et Azure AD",
    lea, 'Rapport de recette', dateOnly(3), 'red', 0, null);
  insAction.run(produit, objSSO, cycleProduit, 'Rédiger la documentation client du SSO',
    ines, 'Page Notion', dateOnly(4), 'orange', 0, null);
  insAction.run(produit, objOnboarding, cycleProduit, "Maquetter les 5 écrans du nouvel onboarding",
    ines, 'Lien Figma', dateOnly(1), 'green', 0, null);
  insAction.run(produit, objOnboarding, cycleProduit, 'Interviewer 6 clients récemment inscrits',
    yann, "Synthèse d'entretiens", dateOnly(3), 'green', 0, null);
  insAction.run(produit, objSSO, cycleProduit, 'Cadrer le périmètre SSO avec les grands comptes',
    yann, 'Note de cadrage', dateOnly(-3), 'green', 1, iso(daysFromNow(-3)));
  insAction.run(produit, objOnboarding, cycleProduit, "Auditer le tunnel d'inscription actuel",
    lea, "Rapport d'audit", dateOnly(-4), 'green', 1, iso(daysFromNow(-4)));

  // Escouade Marketing : pas de cycle en cours → workflow de lancement complet.
  insObjective.run(
    marketing, "Générer 200 leads qualifiés sur l'offre Entreprise",
    'active', macro1, null, iso(daysFromNow(-1))
  );
  insObjective.run(marketing, 'Lancer la newsletter mensuelle', 'backlog', null, null, null);
  insObjective.run(marketing, 'Refondre la page tarifs', 'backlog', null, null, null);

  return { direction, produit, marketing, users: { claire, yann, ines, theo, lea, sofia, hugo, anna } };
}

export function ensureSeeded() {
  if (!isSeeded()) seed();
}

if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  if (process.argv.includes('--reset')) reset();
  if (!isSeeded()) {
    seed();
    console.log('Base de données Épure initialisée avec les données de démonstration.');
  } else {
    console.log('Base déjà initialisée (utilisez --reset pour repartir de zéro).');
  }
}
