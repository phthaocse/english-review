-- ------------------------------------------------------------ levels --
-- A word's level (0 new, 1 recognise, 2 can use, 3 secure) and retest answers,
-- which are practice and never move the level.
ALTER TABLE word_state ADD COLUMN level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE answer_log ADD COLUMN retest INTEGER NOT NULL DEFAULT 0;

UPDATE word_state SET level = 3 WHERE status = 'mastered';
UPDATE word_state SET level = 1 WHERE status = 'active' AND json_extract(today, '$.r1') = 'right';
