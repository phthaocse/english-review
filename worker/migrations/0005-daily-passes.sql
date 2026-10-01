-- Days an item was passed. One that was failed first is dropped only after
-- RELEARN_PASSES of them, because one pass shows you knew it, not that you learnt it.
ALTER TABLE daily_card ADD COLUMN passes INTEGER NOT NULL DEFAULT 0;
