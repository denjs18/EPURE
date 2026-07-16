// Couche d'accès aux données à double pilote.
//   • SQLite (better-sqlite3) en local : zéro configuration.
//   • PostgreSQL (pg) dès qu'une variable POSTGRES_URL / DATABASE_URL est
//     présente — c'est le cas sur Vercel avec la base Postgres intégrée.
//   • PGlite (Postgres WASM embarqué) quand PGLITE=1 — sert uniquement à
//     tester le dialecte Postgres en local, sans serveur.
//
// Les requêtes métier sont écrites une seule fois avec des marqueurs « ? »
// (traduits en « $1, $2 … » pour Postgres) et toutes les dates sont générées
// côté JS en ISO-8601, pour un format identique quel que soit le pilote.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PG_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
export const driver = process.env.PGLITE ? 'pglite' : PG_URL ? 'pg' : 'sqlite';
export const dialect = driver === 'sqlite' ? 'sqlite' : 'postgres';

export const nowIso = () => new Date().toISOString();

// Traduction des marqueurs positionnels ? -> $1, $2 … pour Postgres.
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

let impl = null; // { get, all, run, exec }

async function initSqlite() {
  const DATA_DIR = path.join(__dirname, '..', 'data');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const { default: Database } = await import('better-sqlite3');
  const database = new Database(path.join(DATA_DIR, 'epure.db'));
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  impl = {
    get: async (sql, p = []) => database.prepare(sql).get(...p),
    all: async (sql, p = []) => database.prepare(sql).all(...p),
    run: async (sql, p = []) => void database.prepare(sql).run(...p),
    exec: async (sql) => void database.exec(sql),
  };
}

async function initPg() {
  const { default: pg } = await import('pg');
  const isLocal = /localhost|127\.0\.0\.1/.test(PG_URL);
  const pool = new pg.Pool({
    connectionString: PG_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 3,
  });
  impl = {
    get: async (sql, p = []) => (await pool.query(toPg(sql), p)).rows[0],
    all: async (sql, p = []) => (await pool.query(toPg(sql), p)).rows,
    run: async (sql, p = []) => void (await pool.query(toPg(sql), p)),
    exec: async (sql) => void (await pool.query(sql)),
  };
}

async function initPglite() {
  const { PGlite } = await import('@electric-sql/pglite');
  const pdb = new PGlite(process.env.PGLITE_DIR || undefined);
  await pdb.waitReady;
  impl = {
    get: async (sql, p = []) => (await pdb.query(toPg(sql), p)).rows[0],
    all: async (sql, p = []) => (await pdb.query(toPg(sql), p)).rows,
    run: async (sql, p = []) => void (await pdb.query(toPg(sql), p)),
    exec: async (sql) => void (await pdb.exec(sql)),
  };
}

function schemaSql() {
  const pk =
    dialect === 'postgres'
      ? 'INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY'
      : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  // Horodatage par défaut (non affiché ; les champs affichés sont écrits
  // explicitement en ISO depuis le code).
  const createdAt =
    dialect === 'postgres'
      ? "TEXT NOT NULL DEFAULT (now()::text)"
      : "TEXT NOT NULL DEFAULT (datetime('now'))";

  return `
CREATE TABLE IF NOT EXISTS teams (
  id          ${pk},
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('direction', 'squad')),
  pulse_time  TEXT NOT NULL DEFAULT '09:00',
  webhook_url TEXT,
  created_at  ${createdAt}
);

CREATE TABLE IF NOT EXISTS users (
  id         ${pk},
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('leader', 'member')),
  color      TEXT NOT NULL,
  created_at ${createdAt}
);

CREATE TABLE IF NOT EXISTS objectives (
  id           ${pk},
  team_id      INTEGER NOT NULL REFERENCES teams(id),
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'backlog'
               CHECK (status IN ('backlog', 'active', 'done', 'archived')),
  macro_id     INTEGER REFERENCES objectives(id),
  due_date     TEXT,
  activated_at TEXT,
  completed_at TEXT,
  created_at   ${createdAt}
);

CREATE TABLE IF NOT EXISTS cycles (
  id             ${pk},
  team_id        INTEGER NOT NULL REFERENCES teams(id),
  duration_days  INTEGER NOT NULL CHECK (duration_days BETWEEN 3 AND 31),
  started_at     TEXT NOT NULL,
  ends_at        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'run'
                 CHECK (status IN ('run', 'retro', 'closed')),
  retro_keywords TEXT,
  closed_at      TEXT
);

CREATE TABLE IF NOT EXISTS actions (
  id           ${pk},
  team_id      INTEGER NOT NULL REFERENCES teams(id),
  objective_id INTEGER NOT NULL REFERENCES objectives(id),
  cycle_id     INTEGER REFERENCES cycles(id),
  title        TEXT NOT NULL,
  pilot_id     INTEGER NOT NULL REFERENCES users(id),
  deliverable  TEXT NOT NULL,
  due_date     TEXT NOT NULL,
  rag          TEXT NOT NULL DEFAULT 'green' CHECK (rag IN ('green', 'orange', 'red')),
  done         INTEGER NOT NULL DEFAULT 0,
  done_at      TEXT,
  created_at   ${createdAt}
);

CREATE TABLE IF NOT EXISTS retro_answers (
  id         ${pk},
  cycle_id   INTEGER NOT NULL REFERENCES cycles(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,
  created_at ${createdAt},
  UNIQUE (cycle_id, user_id)
);

CREATE TABLE IF NOT EXISTS pulse_events (
  id         ${pk},
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  cycle_id   INTEGER REFERENCES cycles(id),
  day        TEXT NOT NULL,
  scenario   TEXT NOT NULL CHECK (scenario IN ('A', 'B')),
  message    TEXT NOT NULL,
  meet_link  TEXT,
  invitees   TEXT,
  red_count  INTEGER NOT NULL DEFAULT 0,
  created_at ${createdAt}
);
`;
}

let readyPromise = null;

async function init() {
  if (driver === 'pg') await initPg();
  else if (driver === 'pglite') await initPglite();
  else await initSqlite();

  await impl.exec(schemaSql());

  const { n } = await impl.get('SELECT COUNT(*) AS n FROM teams');
  if (Number(n) === 0) {
    const { seed } = await import('./seed.js');
    await seed();
  }
}

// Prête la base une seule fois par instance (idempotent, adapté au serverless).
export function ensureReady() {
  return (readyPromise ??= init());
}

export const dbGet = (sql, params) => impl.get(sql, params);
export const dbAll = (sql, params) => impl.all(sql, params);
export const dbRun = (sql, params) => impl.run(sql, params);
export const dbExec = (sql) => impl.exec(sql);

// Insert générique renvoyant l'identifiant créé (RETURNING, supporté par
// SQLite ≥ 3.35 et PostgreSQL).
export async function dbInsert(table, row) {
  const cols = Object.keys(row);
  const placeholders = cols.map(() => '?').join(', ');
  const values = cols.map((c) => row[c]);
  const { id } = await impl.get(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) RETURNING id`,
    values
  );
  return id;
}
