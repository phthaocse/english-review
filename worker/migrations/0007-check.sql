-- ------------------------------------------------------------ word check --
-- Where each study word stands for one person.
CREATE TABLE IF NOT EXISTS word_state (
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  entry_id    INTEGER NOT NULL REFERENCES oxford_entry(id) ON DELETE CASCADE,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'mastered')),
  how         TEXT CHECK (how IN ('known', 'learnt', 'self')),
  dealt_on    TEXT NOT NULL,
  tested_on   TEXT,
  occasions   INTEGER NOT NULL DEFAULT 0,
  passes      INTEGER NOT NULL DEFAULT 0,
  mastered_on TEXT,
  today       TEXT,               -- JSON: today's two questions and how each went
  PRIMARY KEY (user_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_word_state_status ON word_state(user_id, status);

-- Every answer: what progress is computed from, and what keeps a question from
-- being shown again before its other versions.
CREATE TABLE IF NOT EXISTS answer_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  entry_id  INTEGER NOT NULL,
  item_id   INTEGER NOT NULL REFERENCES quiz_item(id) ON DELETE CASCADE,
  point_key TEXT NOT NULL,
  feature   TEXT NOT NULL,
  day       TEXT NOT NULL,
  slot      INTEGER NOT NULL,
  answer    TEXT,
  verdict   TEXT NOT NULL CHECK (verdict IN ('right', 'wrong', 'pending', 'skipped', 'self', 'reported')),
  feedback  TEXT,
  corrected TEXT,
  ms        INTEGER,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_answer_log_word ON answer_log(user_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_answer_log_day ON answer_log(user_id, day);

-- A short IELTS-format reading task over recent words, every few days.
CREATE TABLE IF NOT EXISTS ielts_task (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  created_on TEXT NOT NULL,
  entry_ids  TEXT NOT NULL,       -- JSON
  title      TEXT,
  passage    TEXT NOT NULL,
  questions  TEXT NOT NULL,       -- JSON shown to the page
  keys       TEXT NOT NULL,       -- JSON, never sent before answering
  answers    TEXT,
  score      INTEGER,
  status     TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'done'))
);
CREATE INDEX IF NOT EXISTS idx_ielts_task_user ON ielts_task(user_id, created_on DESC);
