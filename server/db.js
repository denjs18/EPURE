import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'epure.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS teams (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('direction', 'squad')),
  pulse_time  TEXT NOT NULL DEFAULT '09:00',
  webhook_url TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('leader', 'member')),
  color      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS objectives (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id      INTEGER NOT NULL REFERENCES teams(id),
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'backlog'
               CHECK (status IN ('backlog', 'active', 'done', 'archived')),
  macro_id     INTEGER REFERENCES objectives(id),
  due_date     TEXT,
  activated_at TEXT,
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cycles (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS retro_answers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id   INTEGER NOT NULL REFERENCES cycles(id),
  user_id    INTEGER NOT NULL REFERENCES users(id),
  text       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (cycle_id, user_id)
);

CREATE TABLE IF NOT EXISTS pulse_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  cycle_id   INTEGER REFERENCES cycles(id),
  day        TEXT NOT NULL,
  scenario   TEXT NOT NULL CHECK (scenario IN ('A', 'B')),
  message    TEXT NOT NULL,
  meet_link  TEXT,
  invitees   TEXT,
  red_count  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
