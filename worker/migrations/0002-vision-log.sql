-- ------------------------------------------------------------ vision reads --
-- One row per photo sent to Gemini, kept so a failure can be explained after
-- the fact: which models were tried, what each said, and how long it took.
CREATE TABLE IF NOT EXISTS vision_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  image_kb    INTEGER,
  model       TEXT,            -- the model that answered, when one did
  items       INTEGER,         -- how many drafts came back
  attempts    TEXT NOT NULL,   -- JSON: [{ model, status, ms }]
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_vision_log_user_at ON vision_log(user_id, at DESC);
