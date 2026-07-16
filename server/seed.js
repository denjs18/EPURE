// Données de démonstration : une direction, deux escouades, cycles,
// objectifs liés aux macro-objectifs et actions TAF réalistes.
// Compatible SQLite / Postgres / PGlite via la couche db.js.
import { dbGet, dbRun, dbInsert, ensureReady } from './db.js';

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

export async function isSeeded() {
  const row = await dbGet('SELECT COUNT(*) AS n FROM teams');
  return Number(row.n) > 0;
}

// Ordre inverse des dépendances (clés étrangères).
export async function resetAll() {
  for (const t of [
    'pulse_events', 'retro_answers', 'actions', 'cycles',
    'objectives', 'users', 'teams',
  ]) {
    await dbRun(`DELETE FROM ${t}`);
  }
}

export async function seed() {
  const team = (name, kind, pulse) =>
    dbInsert('teams', { name, kind, pulse_time: pulse });
  const user = (team_id, name, role, color) =>
    dbInsert('users', { team_id, name, role, color });

  const direction = await team('Direction', 'direction', '09:00');
  const produit = await team('Escouade Produit', 'squad', '09:00');
  const marketing = await team('Escouade Marketing', 'squad', '09:30');

  await user(direction, 'Claire Fontaine', 'leader', '#5B7B6C');
  await user(direction, 'Marc Delval', 'member', '#8A6D5B');

  const yann = await user(produit, 'Yann Morel', 'leader', '#4A6FA5');
  const ines = await user(produit, 'Inès Ferrand', 'member', '#A5744A');
  const theo = await user(produit, 'Théo Lambert', 'member', '#6C5B7B');
  const lea = await user(produit, 'Léa Guichard', 'member', '#3E8E7E');

  await user(marketing, 'Sofia Ricci', 'leader', '#B0574F');
  await user(marketing, 'Hugo Blanchet', 'member', '#54708C');
  await user(marketing, 'Anna Keller', 'member', '#7C8A4D');

  // Macro-objectifs de la Direction (grandes échéances, pas de TAF).
  const macro1 = await dbInsert('objectives', {
    team_id: direction, title: "Lancer l'offre Entreprise avant la fin du trimestre",
    status: 'active', due_date: dateOnly(45), activated_at: iso(daysFromNow(-20)),
  });
  const macro2 = await dbInsert('objectives', {
    team_id: direction, title: 'Réduire le churn client de 20 %',
    status: 'active', due_date: dateOnly(75), activated_at: iso(daysFromNow(-20)),
  });
  await dbInsert('objectives', {
    team_id: direction, title: 'Ouvrir le marché espagnol', status: 'backlog',
  });

  // Escouade Produit : cycle en cours (Métronome 10 jours, démarré il y a 6 jours).
  const cycleProduit = await dbInsert('cycles', {
    team_id: produit, duration_days: 10,
    started_at: iso(daysFromNow(-6)), ends_at: iso(daysFromNow(4)), status: 'run',
    retro_keywords: JSON.stringify([
      { word: 'dépendances', count: 3 },
      { word: 'validation', count: 2 },
      { word: 'tardive', count: 2 },
    ]),
  });

  const objSSO = await dbInsert('objectives', {
    team_id: produit, title: "Livrer l'authentification SSO pour les grands comptes",
    status: 'active', macro_id: macro1, activated_at: iso(daysFromNow(-6)),
  });
  const objOnboarding = await dbInsert('objectives', {
    team_id: produit, title: "Refondre le parcours d'onboarding",
    status: 'active', macro_id: macro2, activated_at: iso(daysFromNow(-6)),
  });
  await dbInsert('objectives', {
    team_id: produit, title: 'Automatiser la facturation annuelle', status: 'backlog',
  });
  await dbInsert('objectives', {
    team_id: produit, title: "Réécrire l'API publique en v2", status: 'backlog',
  });

  const action = (objective_id, title, pilot_id, deliverable, dueDays, rag, done) =>
    dbInsert('actions', {
      team_id: produit, objective_id, cycle_id: cycleProduit, title, pilot_id,
      deliverable, due_date: dateOnly(dueDays), rag, done: done ? 1 : 0,
      done_at: done ? iso(daysFromNow(dueDays)) : null,
    });

  await action(objSSO, 'Coder le connecteur SAML côté backend', theo, 'Pull request GitHub', 2, 'green', 0);
  await action(objSSO, "Tester l'intégration avec Okta et Azure AD", lea, 'Rapport de recette', 3, 'red', 0);
  await action(objSSO, 'Rédiger la documentation client du SSO', ines, 'Page Notion', 4, 'orange', 0);
  await action(objOnboarding, 'Maquetter les 5 écrans du nouvel onboarding', ines, 'Lien Figma', 1, 'green', 0);
  await action(objOnboarding, 'Interviewer 6 clients récemment inscrits', yann, "Synthèse d'entretiens", 3, 'green', 0);
  await action(objSSO, 'Cadrer le périmètre SSO avec les grands comptes', yann, 'Note de cadrage', -3, 'green', 1);
  await action(objOnboarding, "Auditer le tunnel d'inscription actuel", lea, "Rapport d'audit", -4, 'green', 1);

  // Escouade Marketing : pas de cycle en cours → workflow de lancement complet.
  await dbInsert('objectives', {
    team_id: marketing, title: "Générer 200 leads qualifiés sur l'offre Entreprise",
    status: 'active', macro_id: macro1, activated_at: iso(daysFromNow(-1)),
  });
  await dbInsert('objectives', {
    team_id: marketing, title: 'Lancer la newsletter mensuelle', status: 'backlog',
  });
  await dbInsert('objectives', {
    team_id: marketing, title: 'Refondre la page tarifs', status: 'backlog',
  });
}

// Exécution directe : `node server/seed.js [--reset]`
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  const reset = process.argv.includes('--reset');
  await ensureReady();
  if (reset) {
    await resetAll();
    await seed();
    console.log('Base réinitialisée avec les données de démonstration.');
  } else if (await isSeeded()) {
    console.log('Base déjà initialisée (utilisez --reset pour repartir de zéro).');
  } else {
    await seed();
    console.log('Base initialisée avec les données de démonstration.');
  }
  process.exit(0);
}
