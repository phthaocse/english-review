-- Canonical store for the knowledge base.
--
-- SQLite is the source of truth; every destination (Obsidian .md, Anki CSV,
-- .docx) is produced by an exporter reading from here, so switching note-taking
-- tools costs one exporter rather than a migration.
--
-- Runs on Cloudflare D1 in production and on plain SQLite in tests.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- identity --
-- The allowlist. Membership is data, not code, so granting or revoking access
-- never needs a redeploy.
CREATE TABLE IF NOT EXISTS user (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL UNIQUE,
  name         TEXT,
  role         TEXT NOT NULL DEFAULT 'member'  CHECK (role   IN ('owner', 'member')),
  status       TEXT NOT NULL DEFAULT 'allowed' CHECK (status IN ('allowed', 'revoked')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT
);

-- ----------------------------------------------------------------- content --
-- One row per thing learnt. Shared across users: the knowledge base is one
-- library, while progress through it (below) is per person.
CREATE TABLE IF NOT EXISTS item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  term        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  meaning     TEXT,
  vi          TEXT,
  ipa         TEXT,
  cefr        TEXT,
  register    TEXT,
  rule        TEXT,               -- grammar patterns / pronunciation rules / drills
  notes       TEXT,               -- markdown
  -- 'captured' is a human-reviewed draft; 'enriched' has been through the
  -- Oxford lookup on the Mac; 'published' has reached the vault.
  status      TEXT NOT NULL DEFAULT 'captured'
              CHECK (status IN ('captured', 'enriched', 'published')),
  source      TEXT,               -- photo | typed | vault
  source_note TEXT,               -- where you met it
  captured_by INTEGER REFERENCES user(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (term, kind)
);
CREATE INDEX IF NOT EXISTS idx_item_status ON item(status);
CREATE INDEX IF NOT EXISTS idx_item_created ON item(created_at DESC);

-- Example sentences keep their **bold** target: it marks the gap for
-- practice and the exporters rely on it too.
CREATE TABLE IF NOT EXISTS example (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id  INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  text     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_example_item ON example(item_id);

CREATE TABLE IF NOT EXISTS sense (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id  INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  gloss    TEXT NOT NULL,
  vi       TEXT,
  example  TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sense_item ON sense(item_id);

CREATE TABLE IF NOT EXISTS tag (
  item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  tag     TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);

-- ---------------------------------------------------------------- progress --
-- Per user, so two people study the same library on their own schedules —
-- and so one person's phone and laptop finally agree.
CREATE TABLE IF NOT EXISTS review_state (
  user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  level   INTEGER NOT NULL DEFAULT 0,
  seen    INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  streak  INTEGER NOT NULL DEFAULT 0,
  lapses  INTEGER NOT NULL DEFAULT 0,
  fsrs    TEXT NOT NULL,          -- the FSRS card, as JSON
  due     TEXT NOT NULL,          -- lifted out of fsrs so it can be indexed
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_review_due ON review_state(user_id, due);

CREATE TABLE IF NOT EXISTS review_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  at      TEXT NOT NULL,
  rating  INTEGER NOT NULL,
  mode    TEXT,
  verdict TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_user_at ON review_log(user_id, at DESC);

-- ------------------------------------------------------------ abuse limits --
-- Bounds the damage if a session token is ever stolen: the Gemini key behind
-- this Worker can only be spent so many times a day, per person.
CREATE TABLE IF NOT EXISTS usage_counter (
  user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  day     TEXT NOT NULL,
  kind    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);
