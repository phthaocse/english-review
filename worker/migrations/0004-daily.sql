-- ------------------------------------------------------------ daily check --
-- The Oxford 5000 and Oxford Phrase List, seeded from the Mac (tools/oxford_seed.py)
-- rather than committed: the lists are Oxford's, and this repo is public.
-- Definitions and examples are read from Oxford the first time an entry is drawn.
CREATE TABLE IF NOT EXISTS oxford_entry (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  list       TEXT NOT NULL CHECK (list IN ('word', 'phrase')),
  term       TEXT NOT NULL,
  pos        TEXT,
  level      TEXT NOT NULL,
  path       TEXT NOT NULL,       -- /definition/english/bit_1#bit_sng_1
  meaning    TEXT,
  examples   TEXT,                -- JSON array
  ipa        TEXT,
  vi         TEXT,
  fetched_at TEXT,
  UNIQUE (list, term, pos, path)
);
CREATE INDEX IF NOT EXISTS idx_oxford_entry_band ON oxford_entry(list, level);

-- One row per entry a person has been dealt. 'active' rows are today's set;
-- an entry is never dealt twice, so mastered rows also keep it out of the draw.
CREATE TABLE IF NOT EXISTS daily_card (
  user_id      INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  entry_id     INTEGER NOT NULL REFERENCES oxford_entry(id) ON DELETE CASCADE,
  list         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'mastered')),
  added_on     TEXT NOT NULL,
  tested_on    TEXT,
  mastered_on  TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  situation    TEXT,              -- a fresh scene each day, so yesterday's answer cannot be reused
  sample       TEXT,
  situation_on TEXT,
  last_result  TEXT,              -- JSON: what was typed and how it was judged
  PRIMARY KEY (user_id, entry_id)
);
CREATE INDEX IF NOT EXISTS idx_daily_card_status ON daily_card(user_id, list, status);
