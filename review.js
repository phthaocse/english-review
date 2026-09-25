// Review engine: scheduling, grading, and question selection.
//
// Design follows the vocabulary-retention evidence rather than the classic
// flashcard loop:
//   - You type the answer. The app grades it, so you never self-rate.
//   - Each item climbs recognition -> cued recall -> free production, because
//     retrieval direction transfers: recognising a word never makes you able
//     to produce it.
//   - FSRS-6 (vendored ts-fsrs) picks the interval.

import { fsrs, createEmptyCard, Rating, State, generatorParameters } from './vendor/ts-fsrs.mjs';

export const LEVELS = ['recognise', 'gapfill', 'produce'];

// An answer typed this fast was known outright, not reconstructed.
const INSTANT_MS = 4000;
// One slip in a long word is a typo; one slip in a short word is a wrong word.
const TYPO_RATIO = 0.25;
// Below this length a single edit changes the word outright (cat/cut), so the
// answer has to be exact.
const TYPO_MIN_LEN = 5;

const STORE_KEY = 'english-review/progress/v1';

const scheduler = fsrs(generatorParameters({
  enable_fuzz: true,
  enable_short_term: true,
}));

// ---------------------------------------------------------------- progress --

function blankProgress() {
  return { cards: {}, history: [], settings: { retention: 0.9 } };
}

export function loadProgress() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return blankProgress();
    const data = JSON.parse(raw);
    return { ...blankProgress(), ...data };
  } catch {
    return blankProgress();
  }
}

export function saveProgress(progress) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(progress));
    return true;
  } catch {
    return false; // private window, or quota — the session still works in memory
  }
}

/** The stored record for an item, created on first sight. */
export function cardFor(progress, id) {
  let record = progress.cards[id];
  if (!record) {
    record = { level: 0, seen: 0, correct: 0, streak: 0, lapses: 0, card: serialise(createEmptyCard()) };
    progress.cards[id] = record;
  }
  return record;
}

function serialise(card) {
  return { ...card, due: card.due.toISOString(), last_review: card.last_review ? card.last_review.toISOString() : undefined };
}

function deserialise(stored) {
  return { ...stored, due: new Date(stored.due), last_review: stored.last_review ? new Date(stored.last_review) : undefined };
}

// ----------------------------------------------------------------- grading --

/**
 * Normalise for comparison: case, smart quotes, spacing — and punctuation,
 * unless `strict`.
 *
 * Strict mode exists for the punctuation drills: the whole point of the
 * comma-splice card is that a full stop is right where a comma is wrong, and
 * stripping punctuation would accept the splice itself as a correct answer.
 */
export function normalise(text, strict = false) {
  let out = (text || '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
  if (!strict) out = out.replace(/[.,!?;:"()\[\]]/g, '');
  return out.replace(/\s+/g, ' ').trim();
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * Same word, wrong ending — 'accuse' for 'accused', 'turn' for 'turned'.
 *
 * The trailing -e is dropped after the suffix because English drops it when
 * inflecting: accuse -> accused leaves 'accus', so the base has to lose its
 * 'e' too for the two to meet. Irregulars (go/went) are not caught, and fall
 * through to being marked plain wrong.
 */
function sameStem(a, b) {
  const stem = (w) => w.replace(/(ing|ed|es|en|s)$/, '').replace(/e$/, '');
  if (a.length < 4 || b.length < 4) return false;
  return stem(a) === stem(b) && a !== b;
}

/**
 * Grade a typed answer against the accepted forms.
 * Returns { verdict, rating, matched } where verdict is one of
 * 'exact' | 'typo' | 'form' | 'wrong'.
 */
export function grade(typed, accepted, elapsedMs, { strict = false } = {}) {
  const given = normalise(typed, strict);
  if (!given) return { verdict: 'wrong', rating: Rating.Again, matched: null };

  const forms = accepted.map((a) => ({ raw: a, norm: normalise(a, strict) })).filter((f) => f.norm);

  for (const form of forms) {
    if (given === form.norm) {
      const fast = elapsedMs != null && elapsedMs < INSTANT_MS;
      return { verdict: 'exact', rating: fast ? Rating.Easy : Rating.Good, matched: form.raw };
    }
  }

  for (const form of forms) {
    const givenWords = given.split(' ');
    const formWords = form.norm.split(' ');
    if (givenWords.length === formWords.length &&
        givenWords.every((w, i) => w === formWords[i] || sameStem(w, formWords[i]))) {
      return { verdict: 'form', rating: Rating.Hard, matched: form.raw };
    }
  }

  for (const form of forms) {
    if (strict || form.norm.length < TYPO_MIN_LEN) continue;
    const distance = levenshtein(given, form.norm);
    const budget = Math.max(1, Math.floor(form.norm.length * TYPO_RATIO));
    if (distance <= budget && distance <= 2) {
      return { verdict: 'typo', rating: Rating.Hard, matched: form.raw };
    }
  }

  return { verdict: 'wrong', rating: Rating.Again, matched: null };
}

// -------------------------------------------------------------- scheduling --

/** Apply a rating: advance FSRS, then move the item up or down the ladder. */
export function applyRating(progress, id, rating, meta = {}) {
  const record = cardFor(progress, id);
  const topLevel = meta.maxLevel != null ? meta.maxLevel : LEVELS.length - 1;
  const { card } = scheduler.next(deserialise(record.card), new Date(), rating);
  record.card = serialise(card);
  record.seen += 1;

  const passed = rating !== Rating.Again;
  if (passed) {
    record.correct += 1;
    record.streak += 1;
  } else {
    record.streak = 0;
    record.lapses += 1;
  }

  // Promote only on a clean answer, and demote a forgotten item one rung so it
  // is re-earned receptively before being asked to produce it again.
  if (rating === Rating.Good || rating === Rating.Easy) {
    if (record.streak >= 2 && record.level < topLevel) {
      record.level += 1;
      record.streak = 0;
    }
  } else if (rating === Rating.Again && record.level > 0) {
    record.level -= 1;
  }

  progress.history.push({
    id,
    at: Date.now(),
    rating,
    level: record.level,
    mode: meta.mode || null,
    verdict: meta.verdict || null,
  });
  if (progress.history.length > 4000) progress.history.splice(0, progress.history.length - 4000);

  return record;
}

export function dueDate(progress, id) {
  const record = progress.cards[id];
  return record ? new Date(record.card.due) : null;
}

export function isDue(progress, id, now = new Date()) {
  const record = progress.cards[id];
  if (!record) return true; // never studied
  return new Date(record.card.due) <= now;
}

export function isNew(progress, id) {
  const record = progress.cards[id];
  return !record || record.card.state === State.New;
}

export function retrievability(progress, id) {
  const record = progress.cards[id];
  if (!record || record.card.state === State.New) return null;
  return scheduler.get_retrievability(deserialise(record.card), new Date(), false);
}

/**
 * The queue for a session, filled to `limit` in priority order: everything
 * overdue (longest-overdue first), then items never studied, then — only to
 * top up a session that would otherwise come up short — items not yet due,
 * weakest memory first.
 *
 * The session length the learner picked is honoured rather than silently
 * truncated by a new-card cap: new items enter at the gentlest rung
 * (four-option recognition), and the start screen shows the due/new split so
 * the choice is an informed one.
 *
 * Types are deliberately mixed rather than grouped: interleaving beats
 * blocking by category for retention.
 */
export function buildQueue(items, progress, { limit = 20, kinds = null } = {}) {
  const now = new Date();
  const pool = kinds ? items.filter((i) => kinds.includes(i.type)) : items;

  const due = [];
  const fresh = [];
  const ahead = [];
  for (const item of pool) {
    if (isNew(progress, item.id)) fresh.push(item);
    else if (isDue(progress, item.id, now)) due.push(item);
    else ahead.push(item);
  }

  due.sort((a, b) => dueDate(progress, a.id) - dueDate(progress, b.id));
  fresh.sort((a, b) => {
    const rank = (i) => (i.priority === 'high' ? 0 : 1);
    return rank(a) - rank(b) || String(b.added).localeCompare(String(a.added));
  });
  ahead.sort((a, b) => (retrievability(progress, a.id) ?? 1) - (retrievability(progress, b.id) ?? 1));

  return [...due, ...fresh, ...ahead].slice(0, limit);
}

export function stats(items, progress) {
  const now = new Date();
  let due = 0, fresh = 0, learning = 0, mature = 0;
  for (const item of items) {
    const record = progress.cards[item.id];
    if (!record || record.card.state === State.New) { fresh += 1; continue; }
    if (isDue(progress, item.id, now)) due += 1;
    if (record.card.stability >= 21) mature += 1; else learning += 1;
  }
  return { total: items.length, due, fresh, learning, mature };
}

export { Rating, State };
