// The daily check on the word bank: ten words in play, two short questions per
// word per day, stopping at a missed first question. Keys never leave the Worker.

import { askJson, GeminiError } from './gemini.js';
import { CHECKLIST_SIZE } from './profile.js';
import { buildFor } from './bank.js';
import { today } from './daily.js';

export const SET_SIZE = 10;
export const REPLACEMENTS_PER_DAY = 10;
export const RELEARN_PASSES = 3;
const COLLECTION = 'core-1000';
const SELF_MARK_LEVELS = new Set(['a1', 'a2']);
const CHECK_TYPES = ['meaning_mc', 'pattern_mc'];
const PRODUCE_TYPES = ['fix_word', 'rewrite', 'sentence'];
const MARK_BATCH = 5;
const TYPO_MIN_LEN = 5;
const FEATURE_WINDOW_DAYS = 30;

/** Which IELTS Lexical Resource / Grammatical Range feature an answer is evidence for. */
export function featureOf(type, pointKind) {
  if (type === 'meaning_mc') return 'meaning';
  if (type === 'pattern_mc') return pointKind === 'collocation' ? 'collocation' : 'accuracy';
  if (type === 'fix_word') return 'collocation';
  if (type === 'rewrite') return 'paraphrase';
  return 'use';
}

// ---------------------------------------------------------------- picking --

/** A shuffled order for the options, so a remembered position is no help. */
export function permutation(n, rand = Math.random) {
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/**
 * Today's two questions for a word. The first goes to the most important point
 * not yet passed; the second to a different point, so the first cannot give its
 * answer away. Within a point, a version not yet seen beats one already seen.
 */
export function pickItems(points, items, history) {
  const checklist = points.slice(0, CHECKLIST_SIZE).map((p) => p.key);
  const passed = new Set(history.filter((h) => h.verdict === 'right').map((h) => h.point_key));
  const lastSeen = new Map();
  const seenItems = new Map();
  for (const h of history) {
    lastSeen.set(h.point_key, h.at > (lastSeen.get(h.point_key) || '') ? h.at : lastSeen.get(h.point_key));
    seenItems.set(h.item_id, h.at > (seenItems.get(h.item_id) || '') ? h.at : seenItems.get(h.item_id));
  }
  const byPoint = (types) => (key) => items.some((it) => it.point_key === key && types.includes(it.type));
  const order = (types, avoid) => {
    const usable = checklist.filter((k) => k !== avoid && byPoint(types)(k));
    const fresh = usable.filter((k) => !passed.has(k));
    if (fresh.length) return fresh;
    return usable.sort((a, b) => (lastSeen.get(a) || '').localeCompare(lastSeen.get(b) || ''));
  };
  const version = (key, types) => items
    .filter((it) => it.point_key === key && types.includes(it.type))
    .sort((a, b) => (seenItems.get(a.id) || '').localeCompare(seenItems.get(b.id) || '') || a.id - b.id)[0] || null;

  const q1Point = order(CHECK_TYPES)[0];
  const q1 = q1Point ? version(q1Point, CHECK_TYPES) : null;
  const q2Point = order(PRODUCE_TYPES, q1Point)[0] || (byPoint(PRODUCE_TYPES)(q1Point) ? q1Point : null);
  const q2 = q2Point ? version(q2Point, PRODUCE_TYPES) : null;
  return { q1, q2 };
}

// ------------------------------------------------------------------ store --

const parse = (s, fallback) => { try { return s ? JSON.parse(s) : fallback; } catch { return fallback; } };

async function activeWords(db, userId) {
  const { results } = await db.prepare(`
    SELECT w.entry_id AS id, w.status, w.how, w.dealt_on, w.tested_on, w.occasions, w.passes, w.today,
           e.term, e.pos, e.level, p.points, p.profile, s.position,
           EXISTS (SELECT 1 FROM quiz_item q WHERE q.entry_id = w.entry_id AND q.status = 'verified') AS ready
    FROM word_state w JOIN oxford_entry e ON e.id = w.entry_id
    JOIN word_profile p ON p.entry_id = w.entry_id JOIN study_word s ON s.entry_id = w.entry_id
    WHERE w.user_id = ? AND w.status = 'active' ORDER BY s.position`).bind(userId).all();
  return results.map((r) => ({ ...r, ready: !!r.ready, today: parse(r.today, null),
                               points: parse(r.points, []), profile: parse(r.profile, null) }));
}

/** Keep ten words in play, dealt in order, within today's allowance of replacements. */
export async function refill(db, userId, day) {
  const active = await db.prepare("SELECT COUNT(*) AS n FROM word_state WHERE user_id = ? AND status = 'active'")
    .bind(userId).first('n');
  const masteredToday = await db.prepare('SELECT COUNT(*) AS n FROM word_state WHERE user_id = ? AND mastered_on = ?')
    .bind(userId, day).first('n');
  const fresh = await db.prepare('SELECT COUNT(*) AS n FROM word_state WHERE user_id = ?').bind(userId).first('n');
  // The first day fills the whole set; after that only mastered words are replaced.
  const room = Math.min(SET_SIZE - active, fresh === 0 ? SET_SIZE : REPLACEMENTS_PER_DAY - masteredToday);
  if (room <= 0) return;
  const { results } = await db.prepare(`
    SELECT s.entry_id FROM study_word s
    WHERE s.collection = ? AND NOT EXISTS (SELECT 1 FROM word_state w WHERE w.user_id = ? AND w.entry_id = s.entry_id)
    ORDER BY s.position LIMIT ?`).bind(COLLECTION, userId, room).all();
  for (const r of results) {
    await db.prepare('INSERT INTO word_state (user_id, entry_id, dealt_on) VALUES (?, ?, ?)').bind(userId, r.entry_id, day).run();
  }
}

async function itemsFor(db, entryId) {
  const { results } = await db.prepare(
    "SELECT id, point_key, type, body, answer FROM quiz_item WHERE entry_id = ? AND status = 'verified'",
  ).bind(entryId).all();
  return results.map((r) => ({ ...r, body: parse(r.body, {}), answer: parse(r.answer, {}) }));
}

async function historyFor(db, userId, entryId) {
  const { results } = await db.prepare(
    "SELECT item_id, point_key, verdict, at FROM answer_log WHERE user_id = ? AND entry_id = ? AND verdict != 'reported'",
  ).bind(userId, entryId).all();
  return results;
}

async function saveToday(db, userId, entryId, today) {
  await db.prepare('UPDATE word_state SET today = ? WHERE user_id = ? AND entry_id = ?')
    .bind(JSON.stringify(today), userId, entryId).run();
}

/** Today's occasion for a word, picked once and kept, so a reload shows the same questions. */
async function occasionFor(db, userId, word, day) {
  let occ = word.today?.day === day ? word.today : null;
  if (occ && occ.q1 && (occ.q2 || occ.r1 === 'wrong' || occ.r1 === 'skipped' || occ.done)) return occ;
  const items = await itemsFor(db, word.id);
  const { q1, q2 } = pickItems(word.points, items, await historyFor(db, userId, word.id));
  occ = {
    day, done: occ?.done || false, r1: occ?.r1 || null, r2: occ?.r2 || null,
    q1: occ?.q1 || (q1 && { item_id: q1.id, perm: q1.body.options ? permutation(q1.body.options.length) : null }),
    q2: occ?.q2 || (q2 && { item_id: q2.id, perm: q2.body.options ? permutation(q2.body.options.length) : null }),
  };
  await saveToday(db, userId, word.id, occ);
  return occ;
}

const shown = (item, perm) => ({
  id: item.id, type: item.type, stem: item.body.stem || null, instruction: item.body.instruction || null,
  options: item.body.options ? perm.map((i) => item.body.options[i]) : null,
});

const firstSight = (word) => word.occasions === 0 && !word.tested_on;

/** The next question to answer today, or `done`. Words still waiting for questions are counted. */
export async function nextQuestion(env, user, { now = new Date() } = {}) {
  const day = today(now);
  await refill(env.DB, user.id, day);
  const words = await activeWords(env.DB, user.id);
  const waiting = words.filter((w) => !w.ready).length;
  const queue = words.filter((w) => w.ready && !(w.today?.day === day && w.today.done));
  const done = words.filter((w) => w.today?.day === day && w.today.done).length;

  for (const word of queue) {
    const occ = await occasionFor(env.DB, user.id, word, day);
    const slot = !occ.r1 ? 1 : occ.r1 === 'right' && !occ.r2 && occ.q2 ? 2 : null;
    if (!slot) continue;
    const ref = slot === 1 ? occ.q1 : occ.q2;
    if (!ref) continue;
    const item = (await itemsFor(env.DB, word.id)).find((i) => i.id === ref.item_id);
    if (!item) continue;
    return {
      word: { id: word.id, term: word.term, pos: word.pos, level: word.level },
      slot, item: shown(item, ref.perm || []),
      offers: { selfKnown: slot === 1 && firstSight(word) && SELF_MARK_LEVELS.has(word.level) },
      progress: { done, total: words.length - waiting, waiting },
    };
  }
  return { done: true, progress: { done, total: words.length - waiting, waiting } };
}

// ---------------------------------------------------------------- marking --

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[.,!?;:'"]+/g, '').replace(/\s+/g, ' ');

function levenshtein(a, b) {
  const row = [...Array(b.length + 1).keys()];
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

/** A fix on the key, or one slip away from it on a longer word, is right at once. */
export function fixMatches(typed, fixes) {
  const t = norm(typed);
  return fixes.some((f) => {
    const k = norm(f);
    return t === k || (k.length >= TYPO_MIN_LEN && levenshtein(t, k) <= 1);
  });
}

async function log(db, entry) {
  await db.prepare(`INSERT INTO answer_log (user_id, entry_id, item_id, point_key, feature, day, slot, answer, verdict, ms)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(entry.userId, entry.entryId, entry.itemId, entry.pointKey, entry.feature, entry.day, entry.slot,
          entry.answer ?? null, entry.verdict, entry.ms ?? null).run();
}

const pointKind = (word, key) => word.points.find((p) => p.key === key)?.kind || 'sense';

/** Close a day's occasion: count it, and drop the word if it has earned that. */
async function settle(db, userId, word, occ, day) {
  const passed = occ.r1 === 'right' && occ.r2 === 'right';
  const occasions = word.occasions + 1;
  const passes = word.passes + (passed ? 1 : 0);
  const knewIt = passed && word.occasions === 0;
  const mastered = knewIt || passes >= RELEARN_PASSES;
  occ.done = true;
  await db.prepare(`UPDATE word_state SET tested_on = ?, occasions = ?, passes = ?, today = ?,
                      status = ?, how = ?, mastered_on = ? WHERE user_id = ? AND entry_id = ?`)
    .bind(day, occasions, passes, JSON.stringify(occ), mastered ? 'mastered' : 'active',
          mastered ? (knewIt ? 'known' : 'learnt') : null, mastered ? day : null, userId, word.id).run();
  return { passed, mastered, how: mastered ? (knewIt ? 'known' : 'learnt') : null, passes, passesNeeded: RELEARN_PASSES };
}

/** What the page shows after a miss: the right answer, and Oxford's meaning to learn from. */
function reveal(item, word) {
  const key = item.answer;
  const p = word.points.find((x) => x.key === item.point_key);
  return {
    correct: key.index != null ? item.body.options[key.index] : key.fixes ? key.fixes[0]
      : key.model_answers ? key.model_answers[0] : null,
    meaning: p?.def || null,
    oxford: p?.examples?.slice(0, 2) || [],
  };
}

/**
 * One answer. Keyed questions are marked here and now; a sentence or a rewrite
 * waits for the batch marking at the end of the sitting.
 */
export async function answer(env, user, body, { now = new Date() } = {}) {
  const day = today(now);
  const word = (await activeWords(env.DB, user.id)).find((w) => w.id === Number(body?.entry_id));
  if (!word || word.today?.day !== day || word.today.done) throw new GeminiError('that word has no open question today', 409);
  const occ = word.today;
  const slot = !occ.r1 ? 1 : 2;
  const ref = slot === 1 ? occ.q1 : occ.q2;
  const item = (await itemsFor(env.DB, word.id)).find((i) => i.id === ref?.item_id);
  if (!item) throw new GeminiError('that question is no longer in the bank', 409);

  const base = { userId: user.id, entryId: word.id, itemId: item.id, pointKey: item.point_key, day, slot,
                 feature: featureOf(item.type, pointKind(word, item.point_key)), ms: Number(body.ms) || null };

  if (body.selfKnown && !(slot === 1 && firstSight(word) && SELF_MARK_LEVELS.has(word.level))) {
    throw new GeminiError('"I know this well" is only for A1-A2 words the first time they are shown', 400);
  }
  if (body.selfKnown) {
    await log(env.DB, { ...base, verdict: 'self' });
    occ.r1 = 'self';
    occ.done = true;
    await env.DB.prepare(`UPDATE word_state SET status = 'mastered', how = 'self', mastered_on = ?, tested_on = ?,
                            today = ? WHERE user_id = ? AND entry_id = ?`)
      .bind(day, day, JSON.stringify(occ), user.id, word.id).run();
    return { verdict: 'self', done: true, mastered: true, how: 'self', undoable: true };
  }

  if (body.skipped) {
    await log(env.DB, { ...base, verdict: 'skipped' });
    if (slot === 1) occ.r1 = 'skipped'; else occ.r2 = 'wrong';
    const result = await settle(env.DB, user.id, word, occ, day);
    return { verdict: 'skipped', done: true, ...result, ...reveal(item, word), undoable: slot === 1 };
  }

  let verdict;
  if (CHECK_TYPES.includes(item.type)) {
    const chosen = ref.perm?.[Number(body.choice)];
    verdict = chosen === item.answer.index ? 'right' : 'wrong';
    await log(env.DB, { ...base, answer: item.body.options[chosen] ?? null, verdict });
  } else if (item.type === 'fix_word') {
    const typed = String(body.text ?? '').slice(0, 60);
    verdict = fixMatches(typed, item.answer.fixes) ? 'right' : 'pending';
    await log(env.DB, { ...base, answer: typed, verdict });
  } else {
    const typed = String(body.text ?? '').trim().slice(0, 400);
    if (!typed) throw new GeminiError('write an answer first', 400);
    verdict = 'pending';
    await log(env.DB, { ...base, answer: typed, verdict });
  }

  if (slot === 1) occ.r1 = verdict; else occ.r2 = verdict;
  const finished = verdict === 'wrong' || slot === 2 || !occ.q2;
  if (finished && verdict !== 'pending') {
    if (slot === 1 && !occ.q2 && verdict === 'right') occ.r2 = 'right';   // a word with nothing to produce
    const result = await settle(env.DB, user.id, word, occ, day);
    return { verdict, done: true, ...result, ...(verdict === 'wrong' ? reveal(item, word) : {}) };
  }
  await saveToday(env.DB, user.id, word.id, occ);
  return { verdict, done: finished };
}

const MARK_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'integer' },
          ok: { type: 'boolean' },
          feedback: { type: 'string' },
          corrected: { type: 'string' },
        },
        required: ['ref', 'ok', 'feedback', 'corrected'],
      },
    },
  },
  required: ['items'],
};

export function markPrompt(entries) {
  return `You are an IELTS examiner judging whether a B1-B2 learner can USE an English word or
phrase. Each answer comes with the target, the meaning or pattern being tested, the task
and the learner's answer. Judge only how the TARGET is handled, strictly but fairly.

- sentence: ok if the target is used in the meaning given, with its own grammar right
  (form, preposition, collocation, countability), in a sentence a fluent speaker could
  say in that situation. Small mistakes elsewhere in the sentence do not matter.
- rewrite: ok if the rewrite keeps the meaning of the original AND uses the required
  pattern correctly. Other small slips do not matter.
- fix_word: ok if the learner's replacement word makes the sentence correct and natural.

feedback: one or two short sentences in simple English to the learner ("You..."):
what was wrong, or what was good. corrected: the learner's answer with the smallest
change that makes it right; repeat it unchanged if it is already right.

Answers (JSON): ${JSON.stringify(entries)}`;
}

/** Mark today's sentences and rewrites, a few per request, and close their words. */
export async function markPending(env, user, { now = new Date(), allowModelCall = async () => true } = {}) {
  const day = today(now);
  const { results: pending } = await env.DB.prepare(`
    SELECT l.id, l.entry_id, l.item_id, l.answer, q.type, q.point_key, q.body, q.answer AS key, e.term
    FROM answer_log l JOIN quiz_item q ON q.id = l.item_id JOIN oxford_entry e ON e.id = l.entry_id
    WHERE l.user_id = ? AND l.day = ? AND l.verdict = 'pending' ORDER BY l.id`).bind(user.id, day).all();
  const words = new Map((await activeWords(env.DB, user.id)).map((w) => [w.id, w]));

  const outcomes = [];
  for (let i = 0; i < pending.length; i += MARK_BATCH) {
    const batch = pending.slice(i, i + MARK_BATCH);
    if (!(await allowModelCall())) throw new GeminiError('today\'s limit of marking requests is reached', 429);
    const { data } = await askJson(markPrompt(batch.map((r, ref) => {
      const word = words.get(r.entry_id);
      const point = word?.points.find((p) => p.key === r.point_key);
      const body = parse(r.body, {});
      return { ref, type: r.type, target: r.term, tests: point?.pattern || point?.collocation || point?.def,
               task: [body.stem, body.instruction].filter(Boolean).join(' '),
               model_answer: parse(r.key, {}).model_answers?.[0] || parse(r.key, {}).fixes?.[0] || null,
               learner_answer: r.answer };
    })), MARK_SCHEMA, env);
    const byRef = new Map((data.items || []).map((v) => [v.ref, v]));
    for (const [ref, r] of batch.entries()) {
      const v = byRef.get(ref);
      if (!v) continue;                 // unmarked stays pending and is sent again
      const verdict = v.ok ? 'right' : 'wrong';
      await env.DB.prepare('UPDATE answer_log SET verdict = ?, feedback = ?, corrected = ? WHERE id = ?')
        .bind(verdict, v.feedback || null, v.corrected || null, r.id).run();
      const word = words.get(r.entry_id);
      if (!word || word.today?.day !== day) continue;
      const occ = word.today;
      if (occ.q1?.item_id === r.item_id) occ.r1 = verdict; else occ.r2 = verdict;
      const closes = (occ.r1 === 'wrong') || (occ.r1 && occ.r2 && occ.r2 !== 'pending');
      const result = closes ? await settle(env.DB, user.id, word, occ, day) : null;
      if (!closes) await saveToday(env.DB, user.id, word.id, occ);
      outcomes.push({ entry_id: r.entry_id, term: r.term, type: r.type, answer: r.answer, verdict,
                      feedback: v.feedback, corrected: v.corrected, ...(result || {}) });
    }
  }
  await refill(env.DB, user.id, day);
  return outcomes;
}

// ----------------------------------------------------------- undo, report --

/** Take back an accidental "I don't know it" or "I know this well", today only. */
export async function undo(env, user, body, { now = new Date() } = {}) {
  const day = today(now);
  const entryId = Number(body?.entry_id);
  const last = await env.DB.prepare(`SELECT id, verdict FROM answer_log WHERE user_id = ? AND entry_id = ? AND day = ?
                                      ORDER BY id DESC LIMIT 1`).bind(user.id, entryId, day).first();
  if (!last || !['skipped', 'self'].includes(last.verdict)) {
    throw new GeminiError('only "I don\'t know it" and "I know this well" can be taken back', 409);
  }
  const row = await env.DB.prepare('SELECT occasions, passes, today FROM word_state WHERE user_id = ? AND entry_id = ?')
    .bind(user.id, entryId).first();
  const occ = parse(row.today, {});
  Object.assign(occ, { r1: null, r2: null, done: false });
  const counted = last.verdict === 'skipped' ? 1 : 0;
  await env.DB.prepare('DELETE FROM answer_log WHERE id = ?').bind(last.id).run();
  await env.DB.prepare(`UPDATE word_state SET status = 'active', how = NULL, mastered_on = NULL, today = ?,
                          occasions = ?, tested_on = CASE WHEN ? = 1 THEN NULL ELSE tested_on END
                        WHERE user_id = ? AND entry_id = ?`)
    .bind(JSON.stringify(occ), row.occasions - counted, row.occasions - counted === 0 ? 1 : 0, user.id, entryId).run();
  return { undone: true };
}

/** A bad question leaves the bank, and the answer given to it no longer counts. */
export async function report(env, user, body, { now = new Date() } = {}) {
  const day = today(now);
  const itemId = Number(body?.item_id);
  const note = String(body?.note ?? '').slice(0, 300);
  const item = await env.DB.prepare('SELECT id, entry_id FROM quiz_item WHERE id = ?').bind(itemId).first();
  if (!item) throw new GeminiError('no such question', 404);
  const row = await env.DB.prepare('SELECT today FROM word_state WHERE user_id = ? AND entry_id = ?')
    .bind(user.id, item.entry_id).first();
  const occ = parse(row?.today, null);
  // The bank is shared, so only a question this user was given today can be pulled from it.
  if (occ?.day !== day || (occ.q1?.item_id !== itemId && occ.q2?.item_id !== itemId)) {
    throw new GeminiError('only a question you were given today can be reported', 409);
  }
  await env.DB.prepare("UPDATE quiz_item SET status = 'rejected', verify_note = ? WHERE id = ?")
    .bind(`reported by ${user.email}${note ? `: ${note}` : ''}`, itemId).run();
  await env.DB.prepare("UPDATE answer_log SET verdict = 'reported' WHERE user_id = ? AND item_id = ?")
    .bind(user.id, itemId).run();
  if (!occ.done) {
    // The slot is picked again with another question; what was answered before it stands.
    if (occ.q1?.item_id === itemId) Object.assign(occ, { q1: null, r1: null, q2: null, r2: null });
    if (occ.q2?.item_id === itemId) Object.assign(occ, { q2: null, r2: null });
    await saveToday(env.DB, user.id, item.entry_id, occ);
  }
  return { reported: true };
}

/** Write the questions for the first word in play that has none. */
export async function prepare(env, user) {
  const word = (await activeWords(env.DB, user.id)).find((w) => !w.ready);
  if (!word) return { prepared: null };
  return { prepared: await buildFor(env, word.id) };
}

// ---------------------------------------------------------------- progress --

/** The overview: words in play with their checklist ticks, totals, and IELTS-feature accuracy. */
export async function overview(env, user, { now = new Date() } = {}) {
  const day = today(now);
  await refill(env.DB, user.id, day);
  const words = await activeWords(env.DB, user.id);
  const { results: logs } = await env.DB.prepare(`
    SELECT entry_id, point_key, verdict, feedback, corrected, answer, item_id, day FROM answer_log
    WHERE user_id = ? AND verdict IN ('right', 'wrong') AND entry_id IN (SELECT entry_id FROM word_state
          WHERE user_id = ? AND status = 'active')`).bind(user.id, user.id).all();

  const cards = words.map((w) => {
    const mine = logs.filter((l) => l.entry_id === w.id);
    const testedToday = w.today?.day === day && w.today.done;
    const checklist = w.points.slice(0, CHECKLIST_SIZE).map((p) => ({
      key: p.key, kind: p.kind, label: p.pattern || p.collocation || p.phrase || p.def,
      passed: mine.some((l) => l.point_key === p.key && l.verdict === 'right'),
    }));
    const todays = mine.filter((l) => l.day === day);
    // Untested words stay hidden, so the check meets them cold.
    return {
      id: w.id, level: w.level, ready: w.ready, testedToday, passes: w.passes, passesNeeded: RELEARN_PASSES,
      ...(w.tested_on || testedToday ? {
        term: w.term, pos: w.pos, ipa: w.profile?.ipa || null, checklist,
        senses: (w.profile?.senses || []).slice(0, 3).map((s) => ({ def: s.def, cefr: s.cefr,
          example: s.examples?.[0]?.text || null })),
        today: todays.map((l) => ({ verdict: l.verdict, answer: l.answer, feedback: l.feedback, corrected: l.corrected })),
      } : {}),
    };
  });

  const totals = await env.DB.prepare(`
    SELECT SUM(status = 'active') AS active, SUM(status = 'mastered') AS mastered,
           SUM(how = 'known') AS known, SUM(how = 'learnt') AS learnt, SUM(how = 'self') AS self,
           SUM(mastered_on = ?) AS mastered_today
    FROM word_state WHERE user_id = ?`).bind(day, user.id).first();
  const { results: byLevel } = await env.DB.prepare(`
    SELECT e.level, COUNT(*) AS n FROM word_state w JOIN oxford_entry e ON e.id = w.entry_id
    WHERE w.user_id = ? AND w.status = 'mastered' GROUP BY e.level`).bind(user.id).all();
  const since = new Date(now.getTime() - FEATURE_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const { results: features } = await env.DB.prepare(`
    SELECT feature, SUM(verdict = 'right') AS right, COUNT(*) AS n FROM answer_log
    WHERE user_id = ? AND day >= ? AND verdict IN ('right', 'wrong') GROUP BY feature`).bind(user.id, since).all();
  const pendingMarks = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM answer_log WHERE user_id = ? AND day = ? AND verdict = 'pending'").bind(user.id, day).first('n');
  const awaitingMark = (w) => w.today?.day === day && w.today.r2 === 'pending';
  const left = words.filter((w) => w.ready && !(w.today?.day === day && w.today.done) && !awaitingMark(w)).length;

  return {
    day, words: cards, left, waiting: words.filter((w) => !w.ready).length, pendingMarks,
    totals: { active: totals?.active || 0, mastered: totals?.mastered || 0, known: totals?.known || 0,
              learnt: totals?.learnt || 0, self: totals?.self || 0, masteredToday: totals?.mastered_today || 0,
              of: await env.DB.prepare('SELECT COUNT(*) AS n FROM study_word WHERE collection = ?').bind(COLLECTION).first('n') },
    byLevel: Object.fromEntries(byLevel.map((r) => [r.level, r.n])),
    features: Object.fromEntries(features.map((f) => [f.feature, { right: f.right, n: f.n }])),
  };
}
