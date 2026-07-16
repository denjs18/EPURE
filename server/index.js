import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { db } from './db.js';
import { ensureSeeded } from './seed.js';
import { checkActionVerb, VERB_ERROR_MESSAGE } from './verbs.js';
import { extractKeywords } from './keywords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

ensureSeeded();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// Temps réel (WebSockets) : chaque client s'abonne à son équipe. Toute
// mutation diffuse un événement de synchronisation à l'escouade concernée
// et à la Direction (vue fractale).
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket) => {
  socket.teamId = null;
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'subscribe') socket.teamId = Number(msg.team_id);
    } catch {
      /* message ignoré */
    }
  });
});

const directionTeamIds = () =>
  db.prepare("SELECT id FROM teams WHERE kind = 'direction'").all().map((t) => t.id);

function broadcast(teamId, payload = {}) {
  const dirIds = directionTeamIds();
  const message = JSON.stringify({ type: 'sync', team_id: teamId, ...payload });
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    if (client.teamId === teamId || dirIds.includes(client.teamId)) {
      client.send(message);
    }
  }
}

// ---------------------------------------------------------------------------
// Requêtes préparées et aides métier
// ---------------------------------------------------------------------------
const q = {
  team: db.prepare('SELECT * FROM teams WHERE id = ?'),
  teams: db.prepare('SELECT * FROM teams ORDER BY kind DESC, id'),
  user: db.prepare('SELECT * FROM users WHERE id = ?'),
  teamUsers: db.prepare('SELECT * FROM users WHERE team_id = ? ORDER BY role DESC, name'),
  allUsers: db.prepare('SELECT * FROM users ORDER BY team_id, role DESC, name'),
  objective: db.prepare('SELECT * FROM objectives WHERE id = ?'),
  activeObjectives: db.prepare(
    "SELECT * FROM objectives WHERE team_id = ? AND status = 'active' ORDER BY activated_at"
  ),
  backlogObjectives: db.prepare(
    "SELECT * FROM objectives WHERE team_id = ? AND status = 'backlog' ORDER BY created_at"
  ),
  runningCycle: db.prepare(
    "SELECT * FROM cycles WHERE team_id = ? AND status IN ('run', 'retro') ORDER BY id DESC LIMIT 1"
  ),
  lastClosedCycle: db.prepare(
    "SELECT * FROM cycles WHERE team_id = ? AND status = 'closed' ORDER BY closed_at DESC LIMIT 1"
  ),
  openActions: db.prepare(
    'SELECT * FROM actions WHERE team_id = ? AND done = 0 ORDER BY due_date, id'
  ),
  doneActions: db.prepare(
    'SELECT * FROM actions WHERE team_id = ? AND done = 1 ORDER BY done_at DESC LIMIT 200'
  ),
  objectiveActions: db.prepare('SELECT * FROM actions WHERE objective_id = ?'),
  action: db.prepare('SELECT * FROM actions WHERE id = ?'),
  retroAnswers: db.prepare('SELECT * FROM retro_answers WHERE cycle_id = ?'),
  pulseToday: db.prepare('SELECT * FROM pulse_events WHERE team_id = ? AND day = ?'),
  lastPulse: db.prepare(
    'SELECT * FROM pulse_events WHERE team_id = ? ORDER BY id DESC LIMIT 1'
  ),
};

function httpError(res, status, code, message) {
  return res.status(status).json({ error: code, message });
}

function requireUser(req, res) {
  const userId = Number(req.headers['x-user-id'] || req.body?.user_id);
  const user = userId ? q.user.get(userId) : null;
  if (!user) {
    httpError(res, 401, 'unauthenticated', 'Utilisateur inconnu.');
    return null;
  }
  return user;
}

// Gel du système : au passage de l'échéance du Métronome, le cycle bascule
// en Évaluation Éclair et l'interface se bloque pour toute l'équipe.
function refreshCycle(teamId) {
  const cycle = q.runningCycle.get(teamId);
  if (cycle && cycle.status === 'run' && new Date(cycle.ends_at) <= new Date()) {
    db.prepare("UPDATE cycles SET status = 'retro' WHERE id = ?").run(cycle.id);
    cycle.status = 'retro';
    broadcast(teamId, { event: 'freeze' });
  }
  return cycle;
}

function assertNotFrozen(teamId, res) {
  const cycle = refreshCycle(teamId);
  if (cycle && cycle.status === 'retro') {
    httpError(
      res, 423, 'frozen',
      "Évaluation Éclair en cours : l'interface est gelée jusqu'à la fin de la rétrospective."
    );
    return false;
  }
  return true;
}

function objectiveRag(objectiveId) {
  const actions = q.objectiveActions.all(objectiveId).filter((a) => !a.done);
  if (actions.some((a) => a.rag === 'red')) return 'red';
  if (actions.some((a) => a.rag === 'orange')) return 'orange';
  return 'green';
}

function objectiveProgress(objectiveId) {
  const actions = q.objectiveActions.all(objectiveId);
  return {
    total: actions.length,
    done: actions.filter((a) => a.done).length,
  };
}

// Validation d'un objectif : toutes ses actions TAF terminées → il disparaît
// et libère un emplacement de l'Étoile du Nord.
function maybeCompleteObjective(objectiveId) {
  const objective = q.objective.get(objectiveId);
  if (!objective || objective.status !== 'active') return false;
  const { total, done } = objectiveProgress(objectiveId);
  if (total > 0 && done === total) {
    db.prepare(
      "UPDATE objectives SET status = 'done', completed_at = datetime('now') WHERE id = ?"
    ).run(objectiveId);
    return true;
  }
  return false;
}

function activeMacros() {
  const dirId = directionTeamIds()[0];
  return dirId ? q.activeObjectives.all(dirId) : [];
}

// ---------------------------------------------------------------------------
// Le Déclencheur "Pulse" — routine matinale anti-réunionite
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

function runPulse(team, { manual = false } = {}) {
  const cycle = refreshCycle(team.id);
  const day = new Date().toISOString().slice(0, 10);
  const reds = q.openActions
    .all(team.id)
    .filter((a) => a.rag === 'red');

  let scenario, message, meetLink = null, invitees = [];
  if (reds.length === 0) {
    scenario = 'A';
    message = 'Épure : Aucun blocage détecté. Réunion Pulse annulée.';
  } else {
    scenario = 'B';
    meetLink = `https://meet.jit.si/EpurePulse-${slugify(team.name)}-${day.replaceAll('-', '')}`;
    const pilotIds = [...new Set(reds.map((a) => a.pilot_id))];
    const leader = q.teamUsers.all(team.id).find((u) => u.role === 'leader');
    if (leader && !pilotIds.includes(leader.id)) pilotIds.push(leader.id);
    invitees = pilotIds.map((id) => q.user.get(id)?.name).filter(Boolean);
    message =
      `Épure : ${reds.length} blocage${reds.length > 1 ? 's' : ''} détecté${reds.length > 1 ? 's' : ''}. ` +
      `Réunion Pulse de 10 minutes maximum convoquée pour : ${invitees.join(', ')}.`;
  }

  db.prepare(
    `INSERT INTO pulse_events (team_id, cycle_id, day, scenario, message, meet_link, invitees, red_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(team.id, cycle?.id ?? null, day, scenario, message,
    meetLink, JSON.stringify(invitees), reds.length);

  sendWebhook(team.webhook_url, meetLink ? `${message}\n${meetLink}` : message);
  broadcast(team.id, { event: 'pulse' });
  return { scenario, message, meet_link: meetLink, invitees, manual };
}

// Planificateur : vérifie chaque demi-minute si l'heure Pulse d'une escouade
// est atteinte (une seule exécution automatique par jour et par équipe),
// et gèle les cycles arrivés à échéance.
setInterval(() => {
  const nowHm = new Date().toTimeString().slice(0, 5);
  const day = new Date().toISOString().slice(0, 10);
  for (const team of q.teams.all()) {
    refreshCycle(team.id);
    if (team.kind !== 'squad') continue;
    const cycle = q.runningCycle.get(team.id);
    if (!cycle || cycle.status !== 'run') continue;
    if (team.pulse_time === nowHm && q.pulseToday.all(team.id, day).length === 0) {
      runPulse(team);
    }
  }
}, 30_000);

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Profils disponibles (écran d'entrée).
app.get('/api/bootstrap', (_req, res) => {
  res.json({ teams: q.teams.all(), users: q.allUsers.all() });
});

// Vérification IA du verbe d'action, en temps réel.
app.get('/api/verb-check', (req, res) => {
  const result = checkActionVerb(String(req.query.title || ''));
  res.json({ ...result, message: result.valid ? null : VERB_ERROR_MESSAGE });
});

// État complet du tableau de bord (la Règle de l'Écran Unique).
app.get('/api/state', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const team = q.team.get(user.team_id);
  const cycle = refreshCycle(team.id);

  const decorate = (o) => ({
    ...o,
    rag: objectiveRag(o.id),
    progress: objectiveProgress(o.id),
    macro: o.macro_id ? q.objective.get(o.macro_id) : null,
  });

  const users = q.teamUsers.all(team.id);
  const byId = Object.fromEntries(users.map((u) => [u.id, u]));
  const withPilot = (a) => ({
    ...a,
    pilot: byId[a.pilot_id] || q.user.get(a.pilot_id),
    objective_title: q.objective.get(a.objective_id)?.title,
  });

  const lastClosed = q.lastClosedCycle.get(team.id);
  const state = {
    me: user,
    team,
    users,
    cycle,
    objectives: q.activeObjectives.all(team.id).map(decorate),
    backlog: q.backlogObjectives.all(team.id),
    macros: activeMacros(),
    actions: q.openActions.all(team.id).map(withPilot),
    history: q.doneActions.all(team.id).map(withPilot),
    lastPulse: q.lastPulse.get(team.id) || null,
    retroKeywords: cycle?.retro_keywords
      ? JSON.parse(cycle.retro_keywords)
      : lastClosed?.retro_keywords
        ? JSON.parse(lastClosed.retro_keywords)
        : [],
  };

  if (cycle?.status === 'retro') {
    const answers = q.retroAnswers.all(cycle.id);
    state.retro = {
      answered_user_ids: answers.map((a) => a.user_id),
      answered: answers.length,
      expected: users.length,
      mine: answers.some((a) => a.user_id === user.id),
    };
  }

  // Vue "Zoom" fractale pour la Direction : statut des objectifs des
  // escouades liés à chaque Macro-Objectif, sans le détail du TAF.
  if (team.kind === 'direction') {
    state.fractal = q.activeObjectives.all(team.id).map((macro) => ({
      ...macro,
      children: db
        .prepare(
          `SELECT o.*, t.name AS team_name FROM objectives o
           JOIN teams t ON t.id = o.team_id
           WHERE o.macro_id = ? AND o.status IN ('active', 'done')
           ORDER BY t.name`
        )
        .all(macro.id)
        .map((o) => ({ ...o, rag: o.status === 'done' ? 'done' : objectiveRag(o.id) })),
    }));
  }

  res.json(state);
});

// -- Objectifs ---------------------------------------------------------------

app.post('/api/objectives', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!assertNotFrozen(user.team_id, res)) return;
  const title = String(req.body.title || '').trim();
  if (!title) return httpError(res, 400, 'invalid', "Le titre de l'objectif est requis.");
  const team = q.team.get(user.team_id);
  const dueDate = team.kind === 'direction' ? req.body.due_date || null : null;
  const info = db
    .prepare(
      'INSERT INTO objectives (team_id, title, status, macro_id, due_date) VALUES (?, ?, ?, ?, ?)'
    )
    .run(user.team_id, title, 'backlog', req.body.macro_id || null, dueDate);
  broadcast(user.team_id);
  res.json({ id: info.lastInsertRowid });
});

// Verrouillage d'un objectif dans l'Étoile du Nord (3 emplacements max,
// mécanique de Swap, Règle de Liaison fractale).
app.post('/api/objectives/:id/activate', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Seul le chef d'équipe fixe l'Étoile du Nord.");
  }
  if (!assertNotFrozen(user.team_id, res)) return;

  const objective = q.objective.get(Number(req.params.id));
  if (!objective || objective.team_id !== user.team_id || objective.status !== 'backlog') {
    return httpError(res, 404, 'not_found', 'Objectif introuvable dans le backlog.');
  }

  const team = q.team.get(user.team_id);
  const macros = activeMacros();
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

  const active = q.activeObjectives.all(user.team_id);
  const swapOutId = req.body.swap_out_id ? Number(req.body.swap_out_id) : null;

  if (active.length >= 3) {
    if (!swapOutId || !active.some((o) => o.id === swapOutId)) {
      // Blocage strict : le client ouvre la modale "Swap".
      return httpError(
        res, 409, 'slot_full',
        "Les 3 emplacements de l'Étoile du Nord sont occupés. Libérez un slot pour continuer."
      );
    }
    const swapTo = req.body.swap_to === 'archived' ? 'archived' : 'backlog';
    db.prepare(
      "UPDATE objectives SET status = ?, activated_at = NULL WHERE id = ?"
    ).run(swapTo, swapOutId);
  }

  db.prepare(
    "UPDATE objectives SET status = 'active', macro_id = ?, activated_at = datetime('now') WHERE id = ?"
  ).run(macroId, objective.id);
  broadcast(user.team_id);
  res.json({ ok: true });
});

app.post('/api/objectives/:id/release', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Seul le chef d'équipe gère l'Étoile du Nord.");
  }
  if (!assertNotFrozen(user.team_id, res)) return;
  const objective = q.objective.get(Number(req.params.id));
  if (!objective || objective.team_id !== user.team_id || objective.status !== 'active') {
    return httpError(res, 404, 'not_found', 'Objectif actif introuvable.');
  }
  const to = req.body.to === 'archived' ? 'archived' : 'backlog';
  db.prepare(
    'UPDATE objectives SET status = ?, activated_at = NULL WHERE id = ?'
  ).run(to, objective.id);
  broadcast(user.team_id);
  res.json({ ok: true });
});

// -- Actions TAF -------------------------------------------------------------

// Les 4 règles de validation d'une ligne d'action sont vérifiées côté
// serveur : liaison à un objectif actif, verbe d'action, pilote unique,
// livrable + échéance.
app.post('/api/actions', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!assertNotFrozen(user.team_id, res)) return;

  const team = q.team.get(user.team_id);
  if (team.kind === 'direction') {
    return httpError(res, 403, 'forbidden', 'La Direction ne gère pas de TAF quotidien.');
  }

  const { objective_id, title, pilot_id, deliverable, due_date } = req.body;

  const objective = q.objective.get(Number(objective_id));
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
  const pilot = q.user.get(Number(pilot_id));
  if (!pilot || pilot.team_id !== user.team_id) {
    return httpError(res, 422, 'pilot_required', 'Un pilote unique de votre escouade est requis.');
  }

  if (!String(deliverable || '').trim() || !due_date) {
    return httpError(
      res, 422, 'deliverable_required',
      'Livrable & Échéance : un livrable et une date limite doivent être renseignés.'
    );
  }

  const cycle = q.runningCycle.get(user.team_id);
  const info = db
    .prepare(
      `INSERT INTO actions (team_id, objective_id, cycle_id, title, pilot_id, deliverable, due_date)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(user.team_id, objective.id, cycle?.id ?? null, String(title).trim(),
      pilot.id, String(deliverable).trim(), due_date);
  broadcast(user.team_id);
  res.json({ id: info.lastInsertRowid });
});

// Statut RAG (sélecteur 3 clics) ou passage en "Done".
app.patch('/api/actions/:id', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (!assertNotFrozen(user.team_id, res)) return;
  const action = q.action.get(Number(req.params.id));
  if (!action || action.team_id !== user.team_id) {
    return httpError(res, 404, 'not_found', 'Action introuvable.');
  }

  if (req.body.rag !== undefined) {
    if (!['green', 'orange', 'red'].includes(req.body.rag)) {
      return httpError(res, 400, 'invalid', 'Statut RAG invalide.');
    }
    db.prepare('UPDATE actions SET rag = ? WHERE id = ?').run(req.body.rag, action.id);
  }

  let objectiveCompleted = false;
  if (req.body.done === true && !action.done) {
    db.prepare("UPDATE actions SET done = 1, done_at = datetime('now') WHERE id = ?").run(action.id);
    objectiveCompleted = maybeCompleteObjective(action.objective_id);
  }

  broadcast(user.team_id);
  res.json({ ok: true, objective_completed: objectiveCompleted });
});

// -- Métronome ---------------------------------------------------------------

app.post('/api/cycles', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Seul le chef d'équipe règle le Métronome.");
  }
  const existing = refreshCycle(user.team_id);
  if (existing) {
    return httpError(res, 409, 'cycle_running', 'Un cycle est déjà en cours.');
  }
  const days = Number(req.body.duration_days);
  if (!Number.isInteger(days) || days < 3 || days > 31) {
    return httpError(res, 400, 'invalid', 'La durée du cycle va de 3 jours à 1 mois.');
  }
  if (q.activeObjectives.all(user.team_id).length === 0) {
    return httpError(
      res, 422, 'no_objectives',
      "Fixez d'abord au moins un objectif dans l'Étoile du Nord."
    );
  }
  const start = new Date();
  const end = new Date(start.getTime() + days * 86_400_000);
  db.prepare(
    "INSERT INTO cycles (team_id, duration_days, started_at, ends_at, status) VALUES (?, ?, ?, ?, 'run')"
  ).run(user.team_id, days, start.toISOString(), end.toISOString());
  broadcast(user.team_id);
  res.json({ ok: true });
});

// -- Pulse -------------------------------------------------------------------

app.post('/api/pulse/run', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Seul le chef d'équipe déclenche un Pulse manuel.");
  }
  const team = q.team.get(user.team_id);
  if (team.kind !== 'squad') {
    return httpError(res, 403, 'forbidden', 'Le Pulse concerne les escouades.');
  }
  res.json(runPulse(team, { manual: true }));
});

app.post('/api/teams/settings', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Réglage réservé au chef d'équipe.");
  }
  const { pulse_time, webhook_url } = req.body;
  if (pulse_time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(pulse_time)) {
      return httpError(res, 400, 'invalid', 'Heure Pulse invalide (format HH:MM).');
    }
    db.prepare('UPDATE teams SET pulse_time = ? WHERE id = ?').run(pulse_time, user.team_id);
  }
  if (webhook_url !== undefined) {
    db.prepare('UPDATE teams SET webhook_url = ? WHERE id = ?')
      .run(String(webhook_url).trim() || null, user.team_id);
  }
  broadcast(user.team_id);
  res.json({ ok: true });
});

// -- Évaluation Éclair --------------------------------------------------------

function closeRetro(cycle) {
  const texts = q.retroAnswers.all(cycle.id).map((a) => a.text).filter(Boolean);
  const keywords = extractKeywords(texts);
  db.prepare(
    "UPDATE cycles SET status = 'closed', retro_keywords = ?, closed_at = datetime('now') WHERE id = ?"
  ).run(JSON.stringify(keywords), cycle.id);
  broadcast(cycle.team_id, { event: 'retro_closed' });
}

app.post('/api/retro/answer', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const cycle = refreshCycle(user.team_id);
  if (!cycle || cycle.status !== 'retro') {
    return httpError(res, 409, 'no_retro', "Aucune Évaluation Éclair n'est en cours.");
  }
  db.prepare(
    `INSERT INTO retro_answers (cycle_id, user_id, text) VALUES (?, ?, ?)
     ON CONFLICT (cycle_id, user_id) DO UPDATE SET text = excluded.text`
  ).run(cycle.id, user.id, String(req.body.text || '').trim());

  const answered = q.retroAnswers.all(cycle.id).length;
  const expected = q.teamUsers.all(user.team_id).length;
  if (answered >= expected) {
    closeRetro(cycle);
  } else {
    broadcast(user.team_id);
  }
  res.json({ ok: true });
});

app.post('/api/retro/close', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (user.role !== 'leader') {
    return httpError(res, 403, 'forbidden', "Seul le chef d'équipe clôt l'évaluation.");
  }
  const cycle = refreshCycle(user.team_id);
  if (!cycle || cycle.status !== 'retro') {
    return httpError(res, 409, 'no_retro', "Aucune Évaluation Éclair n'est en cours.");
  }
  closeRetro(cycle);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
server.listen(PORT, () => {
  console.log(`Épure.app en écoute sur http://localhost:${PORT}`);
});
