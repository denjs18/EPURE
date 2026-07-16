// Application Épure — API REST sans état, compatible serveur persistant
// (local) comme fonction serverless (Vercel). Le temps réel est assuré par
// polling côté client ; la routine Pulse est déclenchée par un Cron.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureReady, dbGet, dbAll, dbRun, dbInsert, nowIso } from './db.js';
import { checkActionVerb, VERB_ERROR_MESSAGE } from './verbs.js';
import { extractKeywords } from './keywords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Prépare la base (schéma + données de démo) une fois par instance.
app.use((req, res, next) => {
  ensureReady().then(() => next()).catch(next);
});

// Enveloppe les handlers async pour capturer les rejets de promesse.
const h = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: 'server', message: 'Erreur serveur.' });
  });

// ---------------------------------------------------------------------------
// Requêtes métier (écrites une fois, traduites par la couche db.js)
// ---------------------------------------------------------------------------
const q = {
  team: (id) => dbGet('SELECT * FROM teams WHERE id = ?', [id]),
  teams: () => dbAll('SELECT * FROM teams ORDER BY kind DESC, id'),
  user: (id) => dbGet('SELECT * FROM users WHERE id = ?', [id]),
  teamUsers: (teamId) =>
    dbAll('SELECT * FROM users WHERE team_id = ? ORDER BY role DESC, name', [teamId]),
  allUsers: () => dbAll('SELECT * FROM users ORDER BY team_id, role DESC, name'),
  objective: (id) => dbGet('SELECT * FROM objectives WHERE id = ?', [id]),
  activeObjectives: (teamId) =>
    dbAll("SELECT * FROM objectives WHERE team_id = ? AND status = 'active' ORDER BY activated_at", [teamId]),
  backlogObjectives: (teamId) =>
    dbAll("SELECT * FROM objectives WHERE team_id = ? AND status = 'backlog' ORDER BY created_at", [teamId]),
  runningCycle: (teamId) =>
    dbGet("SELECT * FROM cycles WHERE team_id = ? AND status IN ('run', 'retro') ORDER BY id DESC LIMIT 1", [teamId]),
  lastClosedCycle: (teamId) =>
    dbGet("SELECT * FROM cycles WHERE team_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 1", [teamId]),
  openActions: (teamId) =>
    dbAll('SELECT * FROM actions WHERE team_id = ? AND done = 0 ORDER BY due_date, id', [teamId]),
  doneActions: (teamId) =>
    dbAll('SELECT * FROM actions WHERE team_id = ? AND done = 1 ORDER BY done_at DESC LIMIT 200', [teamId]),
  objectiveActions: (objectiveId) =>
    dbAll('SELECT * FROM actions WHERE objective_id = ?', [objectiveId]),
  action: (id) => dbGet('SELECT * FROM actions WHERE id = ?', [id]),
  retroAnswers: (cycleId) =>
    dbAll('SELECT * FROM retro_answers WHERE cycle_id = ?', [cycleId]),
  pulseToday: (teamId, day) =>
    dbAll('SELECT * FROM pulse_events WHERE team_id = ? AND day = ?', [teamId, day]),
  lastPulse: (teamId) =>
    dbGet('SELECT * FROM pulse_events WHERE team_id = ? ORDER BY id DESC LIMIT 1', [teamId]),
};

function httpError(res, status, code, message) {
  return res.status(status).json({ error: code, message });
}

async function requireUser(req, res) {
  const userId = Number(req.headers['x-user-id'] || req.body?.user_id);
  const user = userId ? await q.user(userId) : null;
  if (!user) {
    httpError(res, 401, 'unauthenticated', 'Utilisateur inconnu.');
    return null;
  }
  return user;
}

async function directionTeamIds() {
  const rows = await dbAll("SELECT id FROM teams WHERE kind = 'direction'");
  return rows.map((t) => t.id);
}

// Gel du système : à l'échéance du Métronome, le cycle bascule en Évaluation
// Éclair et l'interface se bloque pour toute l'équipe.
async function refreshCycle(teamId) {
  const cycle = await q.runningCycle(teamId);
  if (cycle && cycle.status === 'run' && new Date(cycle.ends_at) <= new Date()) {
    await dbRun("UPDATE cycles SET status = 'retro' WHERE id = ?", [cycle.id]);
    cycle.status = 'retro';
  }
  return cycle;
}

async function assertNotFrozen(teamId, res) {
  const cycle = await refreshCycle(teamId);
  if (cycle && cycle.status === 'retro') {
    httpError(
      res, 423, 'frozen',
      "Évaluation Éclair en cours : l'interface est gelée jusqu'à la fin de la rétrospective."
    );
    return false;
  }
  return true;
}

async function objectiveRag(objectiveId) {
  const actions = (await q.objectiveActions(objectiveId)).filter((a) => !a.done);
  if (actions.some((a) => a.rag === 'red')) return 'red';
  if (actions.some((a) => a.rag === 'orange')) return 'orange';
  return 'green';
}

async function objectiveProgress(objectiveId) {
  const actions = await q.objectiveActions(objectiveId);
  return { total: actions.length, done: actions.filter((a) => a.done).length };
}

// Validation d'un objectif : toutes ses actions TAF terminées → il disparaît
// et libère un emplacement de l'Étoile du Nord.
async function maybeCompleteObjective(objectiveId) {
  const objective = await q.objective(objectiveId);
  if (!objective || objective.status !== 'active') return false;
  const { total, done } = await objectiveProgress(objectiveId);
  if (total > 0 && done === total) {
    await dbRun("UPDATE objectives SET status = 'done', completed_at = ? WHERE id = ?", [nowIso(), objectiveId]);
    return true;
  }
  return false;
}

async function activeMacros() {
  const dirId = (await directionTeamIds())[0];
  return dirId ? q.activeObjectives(dirId) : [];
}

// ---------------------------------------------------------------------------
// Le Déclencheur "Pulse"
// ---------------------------------------------------------------------------
function slugify(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

async function sendWebhook(url, text) {
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error(`[Pulse] Échec du webhook ${url}: ${err.message}`);
  }
}

async function runPulse(team, { manual = false } = {}) {
  const cycle = await refreshCycle(team.id);
  const day = new Date().toISOString().slice(0, 10);
  const reds = (await q.openActions(team.id)).filter((a) => a.rag === 'red');

  let scenario, message, meetLink = null, invitees = [];
  if (reds.length === 0) {
    scenario = 'A';
    message = 'Épure : Aucun blocage détecté. Réunion Pulse annulée.';
  } else {
    scenario = 'B';
    meetLink = `https://meet.jit.si/EpurePulse-${slugify(team.name)}-${day.replaceAll('-', '')}`;
    const pilotIds = [...new Set(reds.map((a) => a.pilot_id))];
    const leader = (await q.teamUsers(team.id)).find((u) => u.role === 'leader');
    if (leader && !pilotIds.includes(leader.id)) pilotIds.push(leader.id);
    const names = await Promise.all(pilotIds.map(async (id) => (await q.user(id))?.name));
    invitees = names.filter(Boolean);
    message =
      `Épure : ${reds.length} blocage${reds.length > 1 ? 's' : ''} détecté${reds.length > 1 ? 's' : ''}. ` +
      `Réunion Pulse de 10 minutes maximum convoquée pour : ${invitees.join(', ')}.`;
  }

  const id = await dbInsert('pulse_events', {
    team_id: team.id, cycle_id: cycle?.id ?? null, day, scenario, message,
    meet_link: meetLink, invitees: JSON.stringify(invitees), red_count: reds.length,
    created_at: nowIso(),
  });

  await sendWebhook(team.webhook_url, meetLink ? `${message}\n${meetLink}` : message);
  return { id, scenario, message, meet_link: meetLink, invitees, manual };
}

// Scan quotidien déclenché par le Cron : convoque ou annule le Pulse de chaque
// escouade dont le cycle tourne et qui n'a pas encore été scannée aujourd'hui.
async function pulseScan() {
  const day = new Date().toISOString().slice(0, 10);
  const results = [];
  for (const team of await q.teams()) {
    await refreshCycle(team.id);
    if (team.kind !== 'squad') continue;
    const cycle = await q.runningCycle(team.id);
    if (!cycle || cycle.status !== 'run') continue;
    if ((await q.pulseToday(team.id, day)).length > 0) continue;
    results.push(await runPulse(team));
  }
  return results;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

app.get('/api/bootstrap', h(async (_req, res) => {
  res.json({ teams: await q.teams(), users: await q.allUsers() });
}));

app.get('/api/verb-check', h(async (req, res) => {
  const result = checkActionVerb(String(req.query.title || ''));
  res.json({ ...result, message: result.valid ? null : VERB_ERROR_MESSAGE });
}));

// État complet du tableau de bord (la Règle de l'Écran Unique).
app.get('/api/state', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const team = await q.team(user.team_id);
  const cycle = await refreshCycle(team.id);

  const decorate = async (o) => ({
    ...o,
    rag: await objectiveRag(o.id),
    progress: await objectiveProgress(o.id),
    macro: o.macro_id ? await q.objective(o.macro_id) : null,
  });

  const users = await q.teamUsers(team.id);
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const objTitles = {};
  const withPilot = async (a) => {
    if (!(a.objective_id in objTitles)) {
      objTitles[a.objective_id] = (await q.objective(a.objective_id))?.title;
    }
    return { ...a, pilot: byId[a.pilot_id] || (await q.user(a.pilot_id)), objective_title: objTitles[a.objective_id] };
  };

  const activeObjectives = await q.activeObjectives(team.id);
  const openActions = await q.openActions(team.id);
  const doneActions = await q.doneActions(team.id);
  const lastClosed = await q.lastClosedCycle(team.id);

  const state = {
    me: user,
    team,
    users,
    cycle,
    objectives: await Promise.all(activeObjectives.map(decorate)),
    backlog: await q.backlogObjectives(team.id),
    macros: await activeMacros(),
    actions: await Promise.all(openActions.map(withPilot)),
    history: await Promise.all(doneActions.map(withPilot)),
    lastPulse: (await q.lastPulse(team.id)) || null,
    retroKeywords: cycle?.retro_keywords
      ? JSON.parse(cycle.retro_keywords)
      : lastClosed?.retro_keywords
        ? JSON.parse(lastClosed.retro_keywords)
        : [],
  };

  if (cycle?.status === 'retro') {
    const answers = await q.retroAnswers(cycle.id);
    state.retro = {
      answered_user_ids: answers.map((a) => a.user_id),
      answered: answers.length,
      expected: users.length,
      mine: answers.some((a) => a.user_id === user.id),
    };
  }

  // Vue "Zoom" fractale pour la Direction.
  if (team.kind === 'direction') {
    state.fractal = await Promise.all(
      activeObjectives.map(async (macro) => {
        const children = await dbAll(
          `SELECT o.*, t.name AS team_name FROM objectives o
           JOIN teams t ON t.id = o.team_id
           WHERE o.macro_id = ? AND o.status IN ('active', 'done')
           ORDER BY t.name`,
          [macro.id]
        );
        return {
          ...macro,
          children: await Promise.all(
            children.map(async (o) => ({
              ...o,
              rag: o.status === 'done' ? 'done' : await objectiveRag(o.id),
            }))
          ),
        };
      })
    );
  }

  res.json(state);
}));

// -- Objectifs ---------------------------------------------------------------

app.post('/api/objectives', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await assertNotFrozen(user.team_id, res))) return;
  const title = String(req.body.title || '').trim();
  if (!title) return httpError(res, 400, 'invalid', "Le titre de l'objectif est requis.");
  const team = await q.team(user.team_id);
  const dueDate = team.kind === 'direction' ? req.body.due_date || null : null;
  const id = await dbInsert('objectives', {
    team_id: user.team_id, title, status: 'backlog',
    macro_id: req.body.macro_id || null, due_date: dueDate,
  });
  res.json({ id });
}));

// Verrouillage dans l'Étoile du Nord (3 emplacements max, Swap, Règle de Liaison).
app.post('/api/objectives/:id/activate', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Seul le chef d'équipe fixe l'Étoile du Nord.");
  }
  if (!(await assertNotFrozen(user.team_id, res))) return;

  const objective = await q.objective(Number(req.params.id));
  if (!objective || objective.team_id !== user.team_id || objective.status !== 'backlog') {
    return httpError(res, 404, 'not_found', 'Objectif introuvable dans le backlog.');
  }

  const team = await q.team(user.team_id);
  const macros = await activeMacros();
  let macroId = req.body.macro_id ? Number(req.body.macro_id) : objective.macro_id;
  if (team.kind === 'squad' && macros.length > 0) {
    if (!macroId || !macros.some((m) => m.id === macroId)) {
      return httpError(
        res, 422, 'macro_required',
        'Règle de Liaison : cet objectif doit être lié à un Macro-Objectif de la Direction.'
      );
    }
  } else {
    macroId = team.kind === 'squad' ? macroId : null;
  }

  const active = await q.activeObjectives(user.team_id);
  const swapOutId = req.body.swap_out_id ? Number(req.body.swap_out_id) : null;

  if (active.length >= 3) {
    if (!swapOutId || !active.some((o) => o.id === swapOutId)) {
      return httpError(
        res, 409, 'slot_full',
        "Les 3 emplacements de l'Étoile du Nord sont occupés. Libérez un slot pour continuer."
      );
    }
    const swapTo = req.body.swap_to === 'archived' ? 'archived' : 'backlog';
    await dbRun('UPDATE objectives SET status = ?, activated_at = NULL WHERE id = ?', [swapTo, swapOutId]);
  }

  await dbRun(
    "UPDATE objectives SET status = 'active', macro_id = ?, activated_at = ? WHERE id = ?",
    [macroId, nowIso(), objective.id]
  );
  res.json({ ok: true });
}));

app.post('/api/objectives/:id/release', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Seul le chef d'équipe gère l'Étoile du Nord.");
  }
  if (!(await assertNotFrozen(user.team_id, res))) return;
  const objective = await q.objective(Number(req.params.id));
  if (!objective || objective.team_id !== user.team_id || objective.status !== 'active') {
    return httpError(res, 404, 'not_found', 'Objectif actif introuvable.');
  }
  const to = req.body.to === 'archived' ? 'archived' : 'backlog';
  await dbRun('UPDATE objectives SET status = ?, activated_at = NULL WHERE id = ?', [to, objective.id]);
  res.json({ ok: true });
}));

// -- Actions TAF -------------------------------------------------------------

app.post('/api/actions', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await assertNotFrozen(user.team_id, res))) return;

  const team = await q.team(user.team_id);
  if (team.kind === 'direction') {
    return httpError(res, 403, 'forbidden', 'La Direction ne gère pas de TAF quotidien.');
  }

  const { objective_id, title, pilot_id, deliverable, due_date } = req.body;

  const objective = await q.objective(Number(objective_id));
  if (!objective || objective.team_id !== user.team_id || objective.status !== 'active') {
    return httpError(
      res, 422, 'objective_required',
      "Liaison obligatoire : l'action doit être rattachée à un objectif actif de l'Étoile du Nord."
    );
  }

  const verb = checkActionVerb(title);
  if (!verb.valid) return httpError(res, 422, 'verb_invalid', VERB_ERROR_MESSAGE);

  if (Array.isArray(pilot_id)) {
    return httpError(res, 422, 'single_pilot', 'Pilote Unique : une action, un seul responsable.');
  }
  const pilot = await q.user(Number(pilot_id));
  if (!pilot || pilot.team_id !== user.team_id) {
    return httpError(res, 422, 'pilot_required', 'Un pilote unique de votre escouade est requis.');
  }

  if (!String(deliverable || '').trim() || !due_date) {
    return httpError(
      res, 422, 'deliverable_required',
      'Livrable & Échéance : un livrable et une date limite doivent être renseignés.'
    );
  }

  const cycle = await q.runningCycle(user.team_id);
  const id = await dbInsert('actions', {
    team_id: user.team_id, objective_id: objective.id, cycle_id: cycle?.id ?? null,
    title: String(title).trim(), pilot_id: pilot.id,
    deliverable: String(deliverable).trim(), due_date,
  });
  res.json({ id });
}));

app.patch('/api/actions/:id', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (!(await assertNotFrozen(user.team_id, res))) return;
  const action = await q.action(Number(req.params.id));
  if (!action || action.team_id !== user.team_id) {
    return httpError(res, 404, 'not_found', 'Action introuvable.');
  }

  if (req.body.rag !== undefined) {
    if (!['green', 'orange', 'red'].includes(req.body.rag)) {
      return httpError(res, 400, 'invalid', 'Statut RAG invalide.');
    }
    await dbRun('UPDATE actions SET rag = ? WHERE id = ?', [req.body.rag, action.id]);
  }

  let objectiveCompleted = false;
  if (req.body.done === true && !action.done) {
    await dbRun('UPDATE actions SET done = 1, done_at = ? WHERE id = ?', [nowIso(), action.id]);
    objectiveCompleted = await maybeCompleteObjective(action.objective_id);
  }

  res.json({ ok: true, objective_completed: objectiveCompleted });
}));

// -- Métronome ---------------------------------------------------------------

app.post('/api/cycles', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Seul le chef d'équipe règle le Métronome.");
  }
  const existing = await refreshCycle(user.team_id);
  if (existing) {
    return httpError(res, 409, 'cycle_running', 'Un cycle est déjà en cours.');
  }
  const days = Number(req.body.duration_days);
  if (!Number.isInteger(days) || days < 3 || days > 31) {
    return httpError(res, 400, 'invalid', 'La durée du cycle va de 3 jours à 1 mois.');
  }
  if ((await q.activeObjectives(user.team_id)).length === 0) {
    return httpError(res, 422, 'no_objectives', "Fixez d'abord au moins un objectif dans l'Étoile du Nord.");
  }
  const start = new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  await dbInsert('cycles', {
    team_id: user.team_id, duration_days: days,
    started_at: start.toISOString(), ends_at: end.toISOString(), status: 'run',
  });
  res.json({ ok: true });
}));

// -- Pulse -------------------------------------------------------------------

app.post('/api/pulse/run', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Seul le chef d'équipe déclenche un Pulse manuel.");
  }
  const team = await q.team(user.team_id);
  if (team.kind !== 'squad') {
    return httpError(res, 403, 'forbidden', 'Le Pulse concerne les escouades.');
  }
  res.json(await runPulse(team, { manual: true }));
}));

// Endpoint déclenché par le Vercel Cron (requête GET) ou manuellement.
app.get('/api/cron/pulse', h(async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return httpError(res, 401, 'unauthorized', 'Cron non autorisé.');
  }
  const results = await pulseScan();
  res.json({ ran: results.length, results });
}));

app.post('/api/teams/settings', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Réglage réservé au chef d'équipe.");
  }
  const { pulse_time, webhook_url } = req.body;
  if (pulse_time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(pulse_time)) {
      return httpError(res, 400, 'invalid', 'Heure Pulse invalide (format HH:MM).');
    }
    await dbRun('UPDATE teams SET pulse_time = ? WHERE id = ?', [pulse_time, user.team_id]);
  }
  if (webhook_url !== undefined) {
    await dbRun('UPDATE teams SET webhook_url = ? WHERE id = ?',
      [String(webhook_url).trim() || null, user.team_id]);
  }
  res.json({ ok: true });
}));

// -- Évaluation Éclair --------------------------------------------------------

async function closeRetro(cycle) {
  const answers = await q.retroAnswers(cycle.id);
  const keywords = extractKeywords(answers.map((a) => a.text).filter(Boolean));
  await dbRun(
    "UPDATE cycles SET status = 'closed', retro_keywords = ?, closed_at = ? WHERE id = ?",
    [JSON.stringify(keywords), nowIso(), cycle.id]
  );
}

app.post('/api/retro/answer', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  const cycle = await refreshCycle(user.team_id);
  if (!cycle || cycle.status !== 'retro') {
    return httpError(res, 409, 'no_retro', "Aucune Évaluation Éclair n'est en cours.");
  }
  await dbRun(
    `INSERT INTO retro_answers (cycle_id, user_id, text, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (cycle_id, user_id) DO UPDATE SET text = excluded.text`,
    [cycle.id, user.id, String(req.body.text || '').trim(), nowIso()]
  );

  const answered = (await q.retroAnswers(cycle.id)).length;
  const expected = (await q.teamUsers(user.team_id)).length;
  if (answered >= expected) await closeRetro(cycle);
  res.json({ ok: true });
}));

app.post('/api/retro/close', h(async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Seul le chef d'équipe clôt l'évaluation.");
  }
  const cycle = await refreshCycle(user.team_id);
  if (!cycle || cycle.status !== 'retro') {
    return httpError(res, 409, 'no_retro', "Aucune Évaluation Éclair n'est en cours.");
  }
  await closeRetro(cycle);
  res.json({ ok: true });
}));

export default app;
