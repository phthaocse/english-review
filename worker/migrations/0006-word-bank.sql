-- ------------------------------------------------------------- word bank --
-- The study set: which Oxford entries are in which collection, in a fixed order.
CREATE TABLE IF NOT EXISTS study_word (
  entry_id   INTEGER PRIMARY KEY REFERENCES oxford_entry(id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  position   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_study_word_collection ON study_word(collection, position);

-- What Oxford's entry says that a question can be built on, parsed once.
CREATE TABLE IF NOT EXISTS word_profile (
  entry_id       INTEGER PRIMARY KEY REFERENCES oxford_entry(id) ON DELETE CASCADE,
  profile        TEXT NOT NULL,   -- JSON: senses, patterns, collocations, idioms
  points         TEXT NOT NULL,   -- JSON: the checklist, most important first
  parser_version INTEGER NOT NULL,
  parsed_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Several questions per checklist point, so a retest repeats none until all are used.
-- `answer` stays on the Worker; only `body` is ever sent to the page.
CREATE TABLE IF NOT EXISTS quiz_item (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id    INTEGER NOT NULL REFERENCES oxford_entry(id) ON DELETE CASCADE,
  point_key   TEXT NOT NULL,
  type        TEXT NOT NULL
              CHECK (type IN ('meaning_mc', 'pattern_mc', 'fix_word', 'rewrite', 'explain', 'sentence')),
  body        TEXT NOT NULL,
  answer      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'verified', 'rejected')),
  verify_note TEXT,
  model       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_quiz_item_word ON quiz_item(entry_id, point_key, status);
