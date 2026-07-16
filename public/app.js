/* ============================================================
   Épure — application cliente (écran unique)
   ============================================================ */

'use strict';

const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast-root');

let state = null;
let bootstrap = null;
let ws = null;
let wsRetry = 1000;

// Brouillon du formulaire TAF (préservé entre deux rendus temps réel).
const draft = { title: '', objective_id: '', pilot_id: '', deliverable: '', due_date: '' };
let verbCheck = { valid: false, message: null, pending: false };
let verbTimer = null;

let historyOpen = false;
const historyFilter = { q: '', objective: '', pilot: '' };

let retroInterval = null;

// ---------------------------------------------------------------------------
// Utilitaires
// ---------------------------------------------------------------------------
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);

const initials = (name) =>
  name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

const avatar = (user, size = '') =>
  `<span class="avatar ${size}" style="background:${esc(user.color)}" title="${esc(user.name)}">${esc(initials(user.name))}</span>`;

const fmtDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
};

const currentUserId = () => Number(localStorage.getItem('epure_user') || 0);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': String(currentUserId()),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || 'Erreur inattendue');
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, ms = 3800) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  toastRoot.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.4s ease';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }, ms);
}

// ---------------------------------------------------------------------------
// Thème clair / sombre (automatique + bascule manuelle)
// ---------------------------------------------------------------------------
function applyTheme() {
  const saved = localStorage.getItem('epure_theme');
  if (saved) document.documentElement.dataset.theme = saved;
  else delete document.documentElement.dataset.theme;
}
function toggleTheme() {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const current = localStorage.getItem('epure_theme') || (dark ? 'dark' : 'light');
  localStorage.setItem('epure_theme', current === 'dark' ? 'light' : 'dark');
  applyTheme();
}
applyTheme();

// ---------------------------------------------------------------------------
// Temps réel
// ---------------------------------------------------------------------------
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    wsRetry = 1000;
    if (state) ws.send(JSON.stringify({ type: 'subscribe', team_id: state.team.id }));
  };
  ws.onmessage = async (event) => {
    let msg = {};
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type !== 'sync') return;
    const before = state?.lastPulse?.id;
    await loadState();
    if (msg.event === 'pulse' && state?.lastPulse && state.lastPulse.id !== before) {
      toast(state.lastPulse.message);
    }
    if (msg.event === 'freeze') {
      toast("Fin du cycle — Évaluation Éclair : l'interface est gelée.");
    }
  };
  ws.onclose = () => {
    setTimeout(connectWs, wsRetry);
    wsRetry = Math.min(wsRetry * 2, 15000);
  };
}

function subscribeWs() {
  if (ws && ws.readyState === 1 && state) {
    ws.send(JSON.stringify({ type: 'subscribe', team_id: state.team.id }));
  }
}

// ---------------------------------------------------------------------------
// Chargement
// ---------------------------------------------------------------------------
async function loadState() {
  if (!currentUserId()) {
    state = null;
    await renderEntry();
    return;
  }
  try {
    state = await api('/api/state');
    render();
    subscribeWs();
  } catch (err) {
    if (err.status === 401) {
      localStorage.removeItem('epure_user');
      await renderEntry();
    } else {
      toast(err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Écran d'entrée : choix du profil
// ---------------------------------------------------------------------------
async function renderEntry() {
  bootstrap = bootstrap || (await api('/api/bootstrap'));
  const groups = bootstrap.teams
    .map((team) => {
      const members = bootstrap.users.filter((u) => u.team_id === team.id);
      return `
        <div class="entry-team">
          <h3>${esc(team.name)}</h3>
          <div class="kind">${team.kind === 'direction' ? 'Niveau 1 · Direction' : 'Niveau 2 · Escouade'}</div>
          ${members
            .map(
              (u) => `
            <button class="entry-user" data-user="${u.id}">
              ${avatar(u)}
              <span>${esc(u.name)}</span>
              <span class="role">${u.role === 'leader' ? (team.kind === 'direction' ? 'Direction' : "Chef d'équipe") : ''}</span>
            </button>`
            )
            .join('')}
        </div>`;
    })
    .join('');

  app.innerHTML = `
    <div class="entry">
      <h1 class="wordmark">épure<span class="dot">.</span></h1>
      <p class="entry-tagline">L'outil d'anti-gestion de projet. Trois objectifs, un tableau unique, zéro réunion inutile.</p>
      <div class="entry-teams">${groups}</div>
    </div>`;

  app.querySelectorAll('[data-user]').forEach((btn) =>
    btn.addEventListener('click', () => {
      localStorage.setItem('epure_user', btn.dataset.user);
      loadState();
    })
  );
}

// ---------------------------------------------------------------------------
// Tableau de bord
// ---------------------------------------------------------------------------
function daysLeft(cycle) {
  return Math.max(0, Math.ceil((new Date(cycle.ends_at) - Date.now()) / 86_400_000));
}

function render() {
  const focusId = document.activeElement?.id;
  const isLeader = state.me.role === 'leader';
  const isDirection = state.team.kind === 'direction';

  app.innerHTML = `
    <div class="shell">
      ${renderTopbar()}
      ${renderNorthStar(isLeader, isDirection)}
      ${isDirection ? renderFractal() : renderMetronome(isLeader) + renderTaf(isLeader) + renderPulse(isLeader) + renderHistory()}
    </div>`;

  bindDashboard(isLeader, isDirection);
  renderRetroOverlay();

  if (focusId) document.getElementById(focusId)?.focus();
}

function renderTopbar() {
  return `
    <header class="topbar">
      <span class="wordmark">épure<span class="dot">.</span></span>
      <span class="team-name">${esc(state.team.name)}</span>
      <div class="topbar-right">
        <span class="me-chip">${avatar(state.me)} ${esc(state.me.name)}</span>
        <button class="btn-subtle" id="switch-user" title="Changer de profil">Changer</button>
        <button class="btn-subtle theme-toggle" id="theme-toggle" title="Thème clair / sombre">◐</button>
      </div>
    </header>`;
}

function renderNorthStar(isLeader, isDirection) {
  const slots = [];
  for (const o of state.objectives) {
    const macroTag = o.macro
      ? `<span class="macro-link" title="Lié au Macro-Objectif : ${esc(o.macro.title)}">⭑ ${esc(o.macro.title)}</span>`
      : '';
    const due = isDirection && o.due_date
      ? `<span class="macro-due">Échéance ${fmtDate(o.due_date)}</span>`
      : '';
    const progress = !isDirection
      ? `<div class="progress"><div style="width:${o.progress.total ? Math.round((100 * o.progress.done) / o.progress.total) : 0}%"></div></div>
         <span>${o.progress.done}/${o.progress.total}</span>`
      : '';
    slots.push(`
      <div class="objective-card">
        ${isLeader ? `<button class="release" data-release="${o.id}" title="Libérer ce slot (backlog)">×</button>` : ''}
        ${macroTag}
        <h3>${esc(o.title)}</h3>
        <div class="foot">${isDirection ? '' : `<span class="rag-dot ${o.rag}"></span>`}${progress}${due}</div>
      </div>`);
  }
  while (slots.length < 3) {
    slots.push(
      isLeader
        ? `<button class="slot-empty" data-open-backlog><span class="plus">＋</span>Fixer un objectif</button>`
        : `<div class="slot-empty">Emplacement libre</div>`
    );
  }

  const caution = state.retroKeywords?.length
    ? `<div class="caution">Rappel de prudence — cycle précédent :
        ${state.retroKeywords.map((k) => `<span class="kw">${esc(k.word)}</span>`).join('')}
       </div>`
    : '';

  return `
    <section>
      <div class="section-head">
        <h2>✶ ${isDirection ? 'Macro-Objectifs' : 'Étoile du Nord'}</h2>
        <span class="hint">3 emplacements, pas un de plus</span>
        <span class="spacer"></span>
        <span class="hint">Backlog global · ${state.backlog.length}</span>
      </div>
      <div class="north-star">${slots.join('')}</div>
      ${caution}
    </section>`;
}

function renderMetronome(isLeader) {
  const cycle = state.cycle;
  if (cycle && cycle.status === 'run') {
    const days = daysLeft(cycle);
    return `
      <div class="metronome">
        <span class="count">J-${days}</span>
        <span>avant l'Évaluation · cycle de ${cycle.duration_days} jours</span>
      </div>
      <div style="height:34px"></div>`;
  }
  if (cycle && cycle.status === 'retro') {
    return `<div class="metronome"><span class="count">J-0</span><span>Évaluation Éclair en cours</span></div><div style="height:34px"></div>`;
  }
  if (isLeader) {
    return `
      <div class="metronome-setup">
        <div class="slider-wrap">
          <label>Métronome — durée du cycle : <span class="slider-value" id="slider-value">10 jours</span></label>
          <input type="range" id="cycle-slider" min="3" max="31" value="10" />
          <div class="slider-scale"><span>3 jours</span><span>1 mois</span></div>
        </div>
        <button class="btn btn-primary" id="start-cycle">Lancer le cycle</button>
      </div>
      <div style="height:34px"></div>`;
  }
  return `
    <div class="metronome"><span>Aucun cycle en cours — en attente du réglage du Métronome par le chef d'équipe.</span></div>
    <div style="height:34px"></div>`;
}

function renderRagSelect(action) {
  return `
    <span class="rag-select" role="group" aria-label="Statut">
      <button class="g ${action.rag === 'green' ? 'on' : ''}" data-rag="green" data-action="${action.id}" title="Vert — OK"></button>
      <button class="o ${action.rag === 'orange' ? 'on' : ''}" data-rag="orange" data-action="${action.id}" title="Orange — Risque"></button>
      <button class="r ${action.rag === 'red' ? 'on' : ''}" data-rag="red" data-action="${action.id}" title="Rouge — Bloqué"></button>
    </span>`;
}

function renderTaf() {
  const today = new Date().toISOString().slice(0, 10);
  const rows = state.actions
    .map((a) => {
      const late = a.due_date < today;
      return `
      <tr data-row="${a.id}">
        <td><button class="check" data-done="${a.id}" title="Marquer comme terminée">✓</button></td>
        <td class="action-title">${esc(a.title)}</td>
        <td class="obj-cell" title="${esc(a.objective_title)}">${esc(a.objective_title)}</td>
        <td>${a.pilot ? avatar(a.pilot, 'sm') : '—'}</td>
        <td class="meta">${esc(a.deliverable)}</td>
        <td class="meta ${late ? 'late' : ''}">${fmtDate(a.due_date)}</td>
        <td>${renderRagSelect(a)}</td>
      </tr>`;
    })
    .join('');

  const objectiveOptions =
    `<option value="">Objectif…</option>` +
    state.objectives
      .map((o) => `<option value="${o.id}" ${String(o.id) === draft.objective_id ? 'selected' : ''}>${esc(o.title)}</option>`)
      .join('');
  const pilotOptions =
    `<option value="">Pilote…</option>` +
    state.users
      .map((u) => `<option value="${u.id}" ${String(u.id) === draft.pilot_id ? 'selected' : ''}>${esc(u.name)}</option>`)
      .join('');

  return `
    <section>
      <div class="section-head">
        <h2>TAF — Tableau des Actions à Faire</h2>
        <span class="hint">une action, un verbe, un pilote, un livrable</span>
      </div>
      <div class="taf">
        <div class="taf-scroll">
        <table>
          <thead>
            <tr>
              <th></th><th>Action</th><th>Objectif</th><th>Pilote</th>
              <th>Livrable</th><th>Échéance</th><th>Statut</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="7"><div class="empty">Le tableau est propre. Découpez vos objectifs en actions concrètes ci-dessous.</div></td></tr>`}
          </tbody>
        </table>
        </div>
        <div class="taf-form">
          <div class="grid">
            <div>
              <input id="f-title" type="text" placeholder="Verbe d'action + quoi (ex : Rédiger la page tarifs)"
                     value="${esc(draft.title)}" autocomplete="off" />
              <div class="field-msg" id="f-title-msg"></div>
            </div>
            <select id="f-objective">${objectiveOptions}</select>
            <select id="f-pilot">${pilotOptions}</select>
            <input id="f-deliverable" type="text" placeholder="Livrable (ex : Lien Figma)" value="${esc(draft.deliverable)}" />
            <input id="f-due" type="date" value="${esc(draft.due_date)}" min="${today}" />
            <button class="btn btn-primary" id="f-save" disabled>Enregistrer</button>
          </div>
        </div>
      </div>
    </section>`;
}

function renderPulse(isLeader) {
  const p = state.lastPulse;
  const lastBlock = p
    ? `<div class="pulse-result ${p.scenario}">
         ${esc(p.message)}
         ${p.meet_link ? `<br /><a href="${esc(p.meet_link)}" target="_blank" rel="noopener">Rejoindre la réunion Pulse (10 min max)</a>` : ''}
         <span class="when">${new Date(p.created_at.replace(' ', 'T') + 'Z').toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
       </div>`
    : `<div class="empty">Aucun Pulse pour l'instant. La routine se déclenche chaque matin à ${esc(state.team.pulse_time)}.</div>`;

  const settings = isLeader
    ? `<div class="settings-row">
         <label for="pulse-time">Routine à</label>
         <input type="time" id="pulse-time" value="${esc(state.team.pulse_time)}" />
         <button class="btn btn-ghost" id="pulse-now">Scanner maintenant</button>
       </div>
       <div class="settings-row">
         <input type="url" id="webhook-url" placeholder="Webhook Slack / Teams (optionnel)"
                value="${esc(state.team.webhook_url || '')}" />
         <button class="btn btn-ghost" id="save-settings">Enregistrer</button>
       </div>`
    : `<p class="sub" style="margin-top:12px">Routine quotidienne à ${esc(state.team.pulse_time)} — réglée par le chef d'équipe.</p>`;

  return `
    <section>
      <div class="two-col">
        <div class="card">
          <h3>Pulse — synchronisation sans réunion</h3>
          <p class="sub">Chaque matin, Épure scanne le tableau. Zéro blocage : la réunion est annulée. Un rouge : 10 minutes, uniquement les pilotes concernés.</p>
          ${lastBlock}
          ${settings}
        </div>
        <div class="card">
          <h3>Le cycle en un coup d'œil</h3>
          <p class="sub">${state.actions.length} action${state.actions.length > 1 ? 's' : ''} en cours ·
            ${state.actions.filter((a) => a.rag === 'red').length} bloquée(s) ·
            ${state.history.length} terminée(s)</p>
          ${state.objectives
            .map(
              (o) => `
            <div class="fractal-child" style="margin-bottom:8px">
              <span class="rag-dot ${o.rag}"></span>
              <span style="flex:1">${esc(o.title)}</span>
              <span class="muted">${o.progress.done}/${o.progress.total}</span>
            </div>`
            )
            .join('') || `<div class="empty">Fixez vos objectifs pour démarrer.</div>`}
        </div>
      </div>
    </section>`;
}

function renderHistory() {
  const filtered = state.history.filter((a) => {
    if (historyFilter.q && !a.title.toLowerCase().includes(historyFilter.q.toLowerCase())) return false;
    if (historyFilter.objective && String(a.objective_id) !== historyFilter.objective) return false;
    if (historyFilter.pilot && String(a.pilot_id) !== historyFilter.pilot) return false;
    return true;
  });

  const allObjectiveIds = new Map();
  state.history.forEach((a) => allObjectiveIds.set(a.objective_id, a.objective_title));

  const body = !historyOpen
    ? ''
    : `
    <div class="card">
      <div class="history-filters">
        <input id="h-q" type="search" placeholder="Filtrer…" value="${esc(historyFilter.q)}" />
        <select id="h-objective">
          <option value="">Tous les objectifs</option>
          ${[...allObjectiveIds]
            .map(([id, t]) => `<option value="${id}" ${historyFilter.objective === String(id) ? 'selected' : ''}>${esc(t)}</option>`)
            .join('')}
        </select>
        <select id="h-pilot">
          <option value="">Tous les pilotes</option>
          ${state.users
            .map((u) => `<option value="${u.id}" ${historyFilter.pilot === String(u.id) ? 'selected' : ''}>${esc(u.name)}</option>`)
            .join('')}
        </select>
      </div>
      <div class="history-list">
        ${filtered
          .map(
            (a) => `
          <div class="history-row">
            ${a.pilot ? avatar(a.pilot, 'sm') : ''}
            <span class="title">${esc(a.title)}</span>
            <span class="meta">${esc(a.deliverable)} · terminé le ${fmtDate(a.done_at)}</span>
          </div>`
          )
          .join('') || `<div class="empty">Rien ici avec ces filtres.</div>`}
      </div>
    </div>`;

  return `
    <section>
      <div class="section-head">
        <h2>Historique</h2>
        <span class="hint">${state.history.length} action${state.history.length > 1 ? 's' : ''} terminée${state.history.length > 1 ? 's' : ''}</span>
        <span class="spacer"></span>
        <button class="btn-subtle" id="toggle-history">${historyOpen ? 'Masquer' : 'Afficher'}</button>
      </div>
      ${body}
    </section>`;
}

// Vue "Zoom" de la Direction : l'arbre fractal.
function renderFractal() {
  const tree = (state.fractal || [])
    .map(
      (macro) => `
    <div class="fractal-branch">
      <div class="fractal-child" style="font-weight:600; font-size:14.5px">
        <span class="rag-dot ${macro.children.some((c) => c.rag === 'red') ? 'red' : macro.children.some((c) => c.rag === 'orange') ? 'orange' : 'green'}"></span>
        <span>${esc(macro.title)}</span>
        ${macro.due_date ? `<span class="macro-due">· échéance ${fmtDate(macro.due_date)}</span>` : ''}
      </div>
      <div class="fractal-children">
        ${macro.children
          .map(
            (c) => `
          <div class="fractal-child">
            <span class="rag-dot ${c.rag}"></span>
            <span class="team">${esc(c.team_name)}</span>
            <span class="${c.rag === 'done' ? 'done-label' : ''}">${esc(c.title)}</span>
          </div>`
          )
          .join('') || `<div class="fractal-child muted">Aucune escouade liée pour l'instant.</div>`}
      </div>
    </div>`
    )
    .join('');

  return `
    <section>
      <div class="section-head">
        <h2>Vue Zoom — Alignement Fractal</h2>
        <span class="hint">statut des escouades, sans le détail de leur TAF</span>
      </div>
      <div class="card">${tree || `<div class="empty">Fixez vos Macro-Objectifs pour voir l'arbre fractal.</div>`}</div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Liaisons d'événements du tableau de bord
// ---------------------------------------------------------------------------
function bindDashboard(isLeader, isDirection) {
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  document.getElementById('switch-user')?.addEventListener('click', () => {
    localStorage.removeItem('epure_user');
    loadState();
  });

  app.querySelectorAll('[data-open-backlog]').forEach((el) =>
    el.addEventListener('click', () => openBacklogPicker(isDirection))
  );
  app.querySelectorAll('[data-release]').forEach((el) =>
    el.addEventListener('click', () =>
      guard(() => api(`/api/objectives/${el.dataset.release}/release`, { method: 'POST', body: { to: 'backlog' } }))
    )
  );

  // Métronome
  const slider = document.getElementById('cycle-slider');
  if (slider) {
    const label = document.getElementById('slider-value');
    const fmt = (v) => (Number(v) === 31 ? '1 mois' : `${v} jours`);
    slider.addEventListener('input', () => (label.textContent = fmt(slider.value)));
    document.getElementById('start-cycle').addEventListener('click', () =>
      guard(async () => {
        await api('/api/cycles', { method: 'POST', body: { duration_days: Number(slider.value) } });
        toast(`Cycle de ${fmt(slider.value)} lancé. Le compte à rebours est actif.`);
      })
    );
  }

  // TAF — done (fade out) et RAG
  app.querySelectorAll('[data-done]').forEach((el) =>
    el.addEventListener('click', () => {
      const row = app.querySelector(`tr[data-row="${el.dataset.done}"]`);
      row?.classList.add('fading');
      setTimeout(
        () =>
          guard(async () => {
            const res = await api(`/api/actions/${el.dataset.done}`, { method: 'PATCH', body: { done: true } });
            if (res.objective_completed) {
              toast("✶ Objectif atteint — un emplacement de l'Étoile du Nord est libéré.");
            }
          }),
        420
      );
    })
  );
  app.querySelectorAll('[data-rag]').forEach((el) =>
    el.addEventListener('click', () =>
      guard(() => api(`/api/actions/${el.dataset.action}`, { method: 'PATCH', body: { rag: el.dataset.rag } }))
    )
  );

  bindTafForm();

  // Pulse
  document.getElementById('pulse-now')?.addEventListener('click', () =>
    guard(async () => {
      const result = await api('/api/pulse/run', { method: 'POST', body: {} });
      toast(result.message);
    })
  );
  document.getElementById('save-settings')?.addEventListener('click', () =>
    guard(async () => {
      await api('/api/teams/settings', {
        method: 'POST',
        body: {
          pulse_time: document.getElementById('pulse-time').value,
          webhook_url: document.getElementById('webhook-url').value,
        },
      });
      toast('Réglages Pulse enregistrés.');
    })
  );
  document.getElementById('pulse-time')?.addEventListener('change', () => {});

  // Historique
  document.getElementById('toggle-history')?.addEventListener('click', () => {
    historyOpen = !historyOpen;
    render();
  });
  document.getElementById('h-q')?.addEventListener('input', (e) => {
    historyFilter.q = e.target.value;
    render();
  });
  document.getElementById('h-objective')?.addEventListener('change', (e) => {
    historyFilter.objective = e.target.value;
    render();
  });
  document.getElementById('h-pilot')?.addEventListener('change', (e) => {
    historyFilter.pilot = e.target.value;
    render();
  });
}

async function guard(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.code === 'slot_full') return; // géré par la modale Swap
    toast(err.message);
    loadState();
  }
}

// ---------------------------------------------------------------------------
// Formulaire TAF : les 4 règles de validation, en temps réel
// ---------------------------------------------------------------------------
function bindTafForm() {
  const title = document.getElementById('f-title');
  if (!title) return;
  const objective = document.getElementById('f-objective');
  const pilot = document.getElementById('f-pilot');
  const deliverable = document.getElementById('f-deliverable');
  const due = document.getElementById('f-due');
  const save = document.getElementById('f-save');
  const msg = document.getElementById('f-title-msg');

  const updateButton = () => {
    const valid =
      verbCheck.valid &&
      draft.title.trim() &&
      draft.objective_id &&
      draft.pilot_id &&
      draft.deliverable.trim() &&
      draft.due_date;
    save.disabled = !valid;
  };

  const showVerb = () => {
    if (!draft.title.trim()) {
      title.classList.remove('field-error-input');
      msg.textContent = '';
    } else if (verbCheck.pending) {
      title.classList.remove('field-error-input');
      msg.className = 'field-msg';
      msg.textContent = 'Analyse du verbe…';
    } else if (verbCheck.valid) {
      title.classList.remove('field-error-input');
      msg.className = 'field-msg ok';
      msg.textContent = "Verbe d'action détecté ✓";
    } else {
      title.classList.add('field-error-input');
      msg.className = 'field-msg';
      msg.textContent = verbCheck.message || "Veuillez utiliser un verbe d'action";
    }
  };

  title.addEventListener('input', () => {
    draft.title = title.value;
    verbCheck = { valid: false, message: null, pending: true };
    showVerb();
    updateButton();
    clearTimeout(verbTimer);
    const snapshot = draft.title;
    verbTimer = setTimeout(async () => {
      if (!snapshot.trim()) {
        verbCheck = { valid: false, message: null, pending: false };
      } else {
        try {
          const res = await api(`/api/verb-check?title=${encodeURIComponent(snapshot)}`);
          if (draft.title !== snapshot) return;
          verbCheck = { valid: res.valid, message: res.message, pending: false };
        } catch {
          verbCheck = { valid: false, message: null, pending: false };
        }
      }
      showVerb();
      updateButton();
    }, 220);
  });

  objective.addEventListener('change', () => { draft.objective_id = objective.value; updateButton(); });
  pilot.addEventListener('change', () => { draft.pilot_id = pilot.value; updateButton(); });
  deliverable.addEventListener('input', () => { draft.deliverable = deliverable.value; updateButton(); });
  due.addEventListener('change', () => { draft.due_date = due.value; updateButton(); });

  save.addEventListener('click', () =>
    guard(async () => {
      await api('/api/actions', {
        method: 'POST',
        body: {
          title: draft.title,
          objective_id: Number(draft.objective_id),
          pilot_id: Number(draft.pilot_id),
          deliverable: draft.deliverable,
          due_date: draft.due_date,
        },
      });
      Object.assign(draft, { title: '', deliverable: '', due_date: '' });
      verbCheck = { valid: false, message: null, pending: false };
      render();
      document.getElementById('f-title')?.focus();
    })
  );

  showVerb();
  updateButton();
}

// ---------------------------------------------------------------------------
// Modales : sélection backlog + mécanique de Swap
// ---------------------------------------------------------------------------
function closeModal() {
  modalRoot.innerHTML = '';
}

function openModal(html) {
  modalRoot.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}</div></div>`;
  modalRoot.querySelector('.modal-backdrop').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  return modalRoot.querySelector('.modal');
}

function macroSelectHtml(selected) {
  if (state.team.kind === 'direction' || !state.macros.length) return '';
  return `
    <div class="field">
      <label>Règle de Liaison — Macro-Objectif de la Direction <span style="color:var(--red)">*</span></label>
      <select id="m-macro">
        <option value="">Choisir…</option>
        ${state.macros
          .map((m) => `<option value="${m.id}" ${selected === m.id ? 'selected' : ''}>${esc(m.title)}</option>`)
          .join('')}
      </select>
    </div>`;
}

function openBacklogPicker(isDirection) {
  const modal = openModal(`
    <h3>Fixer un objectif</h3>
    <p class="sub">Sélectionnez un objectif du backlog global ou créez-en un nouveau.
       ${!isDirection && state.macros.length ? 'La Règle de Liaison exige un rattachement à un Macro-Objectif.' : ''}</p>
    ${state.backlog
      .map(
        (o) => `
      <button class="backlog-item" data-pick="${o.id}" data-macro="${o.macro_id || ''}">
        <span style="flex:1">${esc(o.title)}</span>
        <span class="muted">→</span>
      </button>`
      )
      .join('') || `<div class="empty">Le backlog est vide.</div>`}
    <div class="field" style="margin-top:18px">
      <label>Nouvel objectif</label>
      <input id="m-new-title" type="text" placeholder="${isDirection ? 'Ex : Doubler le revenu récurrent' : 'Ex : Livrer le module de facturation'}" />
    </div>
    ${isDirection ? `<div class="field"><label>Grande échéance (optionnel)</label><input id="m-new-due" type="date" /></div>` : ''}
    ${macroSelectHtml()}
    <div class="modal-actions">
      <button class="btn btn-ghost" data-close>Annuler</button>
      <button class="btn btn-primary" id="m-create">Créer et fixer</button>
    </div>`);

  modal.querySelector('[data-close]').addEventListener('click', closeModal);

  modal.querySelectorAll('[data-pick]').forEach((el) =>
    el.addEventListener('click', () => {
      const macroSelect = modal.querySelector('#m-macro');
      const macroId = macroSelect?.value
        ? Number(macroSelect.value)
        : el.dataset.macro
          ? Number(el.dataset.macro)
          : null;
      activateObjective(Number(el.dataset.pick), macroId);
    })
  );

  modal.querySelector('#m-create').addEventListener('click', async () => {
    const title = modal.querySelector('#m-new-title').value.trim();
    if (!title) return toast("Donnez un titre à l'objectif.");
    const macroId = modal.querySelector('#m-macro')?.value
      ? Number(modal.querySelector('#m-macro').value)
      : null;
    if (state.team.kind === 'squad' && state.macros.length && !macroId) {
      return toast('Règle de Liaison : choisissez un Macro-Objectif.');
    }
    try {
      const { id } = await api('/api/objectives', {
        method: 'POST',
        body: {
          title,
          macro_id: macroId,
          due_date: modal.querySelector('#m-new-due')?.value || null,
        },
      });
      activateObjective(id, macroId);
    } catch (err) {
      toast(err.message);
    }
  });
}

async function activateObjective(objectiveId, macroId, swap) {
  try {
    await api(`/api/objectives/${objectiveId}/activate`, {
      method: 'POST',
      body: { macro_id: macroId, ...(swap || {}) },
    });
    closeModal();
  } catch (err) {
    if (err.code === 'slot_full') {
      openSwapModal(objectiveId, macroId);
    } else if (err.code === 'macro_required') {
      toast(err.message);
    } else {
      toast(err.message);
      closeModal();
    }
  }
}

// La mécanique de Swap : les 3 slots sont pleins, il faut en libérer un.
function openSwapModal(objectiveId, macroId) {
  let selected = null;
  const modal = openModal(`
    <h3>Swap — les 3 emplacements sont occupés</h3>
    <p class="sub">L'Étoile du Nord est limitée à 3 objectifs. Choisissez celui à retirer pour libérer un slot.</p>
    ${state.objectives
      .map(
        (o) => `
      <button class="swap-option" data-swap="${o.id}">
        <span class="radio"></span>
        <span style="flex:1">${esc(o.title)}</span>
        <span class="muted">${o.progress ? `${o.progress.done}/${o.progress.total}` : ''}</span>
      </button>`
      )
      .join('')}
    <div class="field">
      <label>Destination de l'objectif retiré</label>
      <select id="swap-to">
        <option value="backlog">Remettre dans le backlog global</option>
        <option value="archived">Archiver définitivement</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-close>Annuler</button>
      <button class="btn btn-primary" id="swap-confirm" disabled>Libérer et fixer</button>
    </div>`);

  modal.querySelector('[data-close]').addEventListener('click', closeModal);
  const confirm = modal.querySelector('#swap-confirm');
  modal.querySelectorAll('[data-swap]').forEach((el) =>
    el.addEventListener('click', () => {
      selected = Number(el.dataset.swap);
      modal.querySelectorAll('[data-swap]').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      confirm.disabled = false;
    })
  );
  confirm.addEventListener('click', () => {
    activateObjective(objectiveId, macroId, {
      swap_out_id: selected,
      swap_to: modal.querySelector('#swap-to').value,
    });
  });
}

// ---------------------------------------------------------------------------
// Évaluation Éclair : freeze plein écran, 3 minutes, une seule question
// ---------------------------------------------------------------------------
function renderRetroOverlay() {
  const existing = document.querySelector('.retro-overlay');
  const active = state.cycle?.status === 'retro';

  if (!active) {
    if (existing) {
      existing.remove();
      clearInterval(retroInterval);
      retroInterval = null;
    }
    return;
  }

  const cycle = state.cycle;
  const retro = state.retro || { mine: false, answered: 0, expected: state.users.length };

  if (retro.mine) {
    clearInterval(retroInterval);
    retroInterval = null;
    const overlay = existing || document.createElement('div');
    overlay.className = 'retro-overlay';
    overlay.innerHTML = `
      <span class="wordmark" style="font-size:26px; margin-bottom:36px">épure<span class="dot">.</span></span>
      <h2>Merci. Votre réponse est enregistrée.</h2>
      <p class="waiting">L'écran se débloquera dès que toute l'équipe aura répondu.
        La synthèse sera épinglée à côté de l'Étoile du Nord du prochain cycle.</p>
      <p class="progress-note">${retro.answered} / ${retro.expected} réponses reçues</p>
      ${state.me.role === 'leader'
        ? `<div class="actions"><button class="btn btn-ghost" id="retro-close">Clore l'évaluation maintenant</button></div>`
        : ''}
    `;
    if (!existing) document.body.appendChild(overlay);
    overlay.querySelector('#retro-close')?.addEventListener('click', () =>
      guard(() => api('/api/retro/close', { method: 'POST', body: {} }))
    );
    return;
  }

  // Le membre n'a pas encore répondu : question unique + compte à rebours 3 min.
  if (existing?.dataset.mode === 'form') {
    return; // ne pas réinitialiser le formulaire ni le chrono
  }
  if (existing) existing.remove();

  const key = `epure_retro_start_${cycle.id}`;
  if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, String(Date.now()));
  const startedAt = Number(sessionStorage.getItem(key));

  const overlay = document.createElement('div');
  overlay.className = 'retro-overlay';
  overlay.dataset.mode = 'form';
  overlay.innerHTML = `
    <span class="wordmark" style="font-size:26px; margin-bottom:36px">épure<span class="dot">.</span></span>
    <div class="timer" id="retro-timer">3:00</div>
    <h2>Qu'est-ce qui nous a ralenti sur ce cycle&nbsp;?</h2>
    <textarea id="retro-text" placeholder="En quelques mots, sans filtre…" autofocus></textarea>
    <div class="actions">
      <button class="btn btn-primary" id="retro-submit">Envoyer</button>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#retro-text').focus();

  const submit = () =>
    guard(async () => {
      clearInterval(retroInterval);
      retroInterval = null;
      await api('/api/retro/answer', {
        method: 'POST',
        body: { text: overlay.querySelector('#retro-text').value },
      });
    });

  overlay.querySelector('#retro-submit').addEventListener('click', submit);

  const timerEl = overlay.querySelector('#retro-timer');
  const tick = () => {
    const remaining = Math.max(0, 180 - Math.floor((Date.now() - startedAt) / 1000));
    const m = Math.floor(remaining / 60);
    const s = String(remaining % 60).padStart(2, '0');
    timerEl.textContent = `${m}:${s}`;
    if (remaining <= 30) timerEl.classList.add('low');
    if (remaining === 0) submit();
  };
  tick();
  clearInterval(retroInterval);
  retroInterval = setInterval(tick, 1000);
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
connectWs();
loadState();

// Filet de sécurité : rafraîchit le compte à rebours et détecte le gel
// même si un événement temps réel se perd.
setInterval(() => {
  if (state && currentUserId()) loadState();
}, 60_000);
