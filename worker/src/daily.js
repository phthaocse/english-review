// The daily check: ten Oxford 5000 words and ten Oxford phrases per person,
// each tested cold. An item leaves the set only when its meaning is explained
// AND it is used correctly in a sentence of the person's own.

import { askJson, GeminiError } from './gemini.js';
import { fetchSense } from './oxford.js';

export const LISTS = ['word', 'phrase'];
export const SET_SIZE = 10;
// Each pass of the check can bring in replacements; this stops a run of easy
// words from turning one sitting into fifty.
export const REPLACEMENTS_PER_LIST_PER_DAY = 10;
const OXFORD_FETCHES_PER_REQUEST = 24;
// Passing on first sight means you already knew it. An item learnt here has to be
// passed on this many separate days: about three relearning sessions is where
// the successive-relearning studies stop finding more benefit.
export const RELEARN_PASSES = 3;

// Mostly the learning zone for a B1→B2 learner, one quick easy check, two stretch items.
export const BANDS = [
  { key: 'b2', levels: ['b2'], target: 4 },
  { key: 'b1', levels: ['b1'], target: 3 },
  { key: 'c1', levels: ['c1', 'c2'], target: 2 },
  { key: 'a', levels: ['a1', 'a2'], target: 1 },
];

const VN_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

/** The calendar day in Vietnam, which is when "today's set" turns over. */
export function today(now = new Date()) {
  return new Date(now.getTime() + VN_UTC_OFFSET_MS).toISOString().slice(0, 10);
}

export const bandOf = (level) => BANDS.find((b) => b.levels.includes(level))?.key ?? null;

/** The band furthest below its share of the set, skipping bands with nothing left to draw. */
export function chooseBand(levels, exhausted = new Set()) {
  const have = Object.fromEntries(BANDS.map((b) => [b.key, 0]));
  for (const level of levels) {
    const key = bandOf(level);
    if (key) have[key] += 1;
  }
  const open = BANDS.filter((b) => !exhausted.has(b.key));
  if (!open.length) return null;
  return open.reduce((best, b) => (b.target - have[b.key] > best.target - have[best.key] ? b : best));
}

// --------------------------------------------------------------- context ---

const PLACEHOLDERS = new Set(['sb', 'sth', 'somebody', 'something', 'someone', "sb's", "one's", 'oneself']);
const MIN_STEM = 3;
const MAX_SUFFIX = 4;
const words = (s) => s.toLowerCase().split(/\s+/).filter(Boolean);

/** The part of a list entry that actually appears in a sentence: "a bit of sth" → "a bit of". */
export function coreOf(term) {
  const parts = words(term.replace(/\(.*?\)/g, ' '));
  const isSlot = (w, i) => PLACEHOLDERS.has(w) || (w === 'do' && PLACEHOLDERS.has(parts[i + 1]));
  let start = 0, end = parts.length;
  while (start < end && isSlot(parts[start], start)) start++;
  while (end > start && isSlot(parts[end - 1], end - 1)) end--;
  const core = parts.slice(start, end);
  return core.some((w, i) => isSlot(w, start + i)) ? [core[0]] : core;
}

const stemOf = (w) => (w.length > MIN_STEM + 1 ? w.replace(/(e|y)$/, '') : w);

/** True when `token` is `word` or an inflection of it: abolish → abolished, study → studies. */
function sameWord(token, word) {
  if (token === word) return true;
  if (word.length < MIN_STEM || /[^a-z]/.test(word)) return false;
  const stem = stemOf(word);
  return token.startsWith(stem) && token.length <= word.length + MAX_SUFFIX;
}

/**
 * The first of Oxford's example sentences that contains the entry, split
 * around it so the page can highlight it in whatever form the sentence uses.
 */
export function contextFor(term, examples = []) {
  const core = coreOf(term);
  if (!core.length) return null;
  for (const sentence of examples) {
    const tokens = [...sentence.matchAll(/[A-Za-z][A-Za-z'’-]*/g)];
    for (let i = 0; i + core.length <= tokens.length; i++) {
      const run = tokens.slice(i, i + core.length);
      if (!run.every((t, k) => sameWord(t[0].toLowerCase(), core[k]))) continue;
      const from = run[0].index;
      const to = run.at(-1).index + run.at(-1)[0].length;
      return { before: sentence.slice(0, from), target: sentence.slice(from, to), after: sentence.slice(to) };
    }
  }
  return null;
}

// ------------------------------------------------------------------ store --

const CARD_SQL = `
  SELECT d.entry_id AS id, d.list, d.status, d.added_on, d.tested_on, d.mastered_on, d.attempts, d.passes,
         d.situation, d.sample, d.situation_on, d.last_result,
         e.term, e.pos, e.level, e.path, e.meaning, e.examples, e.ipa, e.vi, e.fetched_at
  FROM daily_card d JOIN oxford_entry e ON e.id = d.entry_id`;

async function activeCards(db, userId) {
  const { results } = await db.prepare(`${CARD_SQL} WHERE d.user_id = ? AND d.status = 'active'
    ORDER BY d.added_on, d.entry_id`).bind(userId).all();
  return results.map((r) => ({ ...r, examples: JSON.parse(r.examples || '[]'),
                               last_result: JSON.parse(r.last_result || 'null') }));
}

async function drawOne(db, userId, list, levels) {
  const marks = levels.map(() => '?').join(', ');
  // Never deal an entry twice, nor a second sense of a term that is already in the set.
  return db.prepare(`
    SELECT id FROM oxford_entry e
    WHERE e.list = ? AND e.level IN (${marks})
      AND NOT EXISTS (SELECT 1 FROM daily_card d WHERE d.user_id = ? AND d.entry_id = e.id)
      AND e.term NOT IN (SELECT x.term FROM daily_card d JOIN oxford_entry x ON x.id = d.entry_id
                         WHERE d.user_id = ? AND d.status = 'active')
    ORDER BY RANDOM() LIMIT 1`).bind(list, ...levels, userId, userId).first('id');
}

/** Top each list back up to ten, within today's allowance of new entries. */
export async function refill(db, userId, day) {
  const cards = await activeCards(db, userId);
  for (const list of LISTS) {
    const levels = cards.filter((c) => c.list === list).map((c) => c.level);
    const masteredToday = await db.prepare(
      "SELECT COUNT(*) AS n FROM daily_card WHERE user_id = ? AND list = ? AND mastered_on = ?",
    ).bind(userId, list, day).first('n');
    if ((masteredToday ?? 0) >= REPLACEMENTS_PER_LIST_PER_DAY) continue;
    const exhausted = new Set();

    while (levels.length < SET_SIZE) {
      const band = chooseBand(levels, exhausted);
      if (!band) break;
      const id = await drawOne(db, userId, list, band.levels);
      if (!id) { exhausted.add(band.key); continue; }
      await db.prepare('INSERT INTO daily_card (user_id, entry_id, list, added_on) VALUES (?, ?, ?, ?)')
        .bind(userId, id, list, day).run();
      const { level } = await db.prepare('SELECT level FROM oxford_entry WHERE id = ?').bind(id).first();
      levels.push(level);
    }
  }
}

// ---------------------------------------------------------------- content --

/** Read Oxford's definition and examples for entries drawn for the first time. */
async function fillFromOxford(db, cards, { fetchImpl }) {
  const missing = cards.filter((c) => !c.fetched_at).slice(0, OXFORD_FETCHES_PER_REQUEST);
  await Promise.all(missing.map(async (card) => {
    const sense = await fetchSense(card.path, { fetchImpl });
    if (!sense) return;               // unreachable: try again on the next visit
    Object.assign(card, { meaning: sense.meaning, examples: sense.examples, ipa: sense.ipa, fetched_at: 'now' });
    await db.prepare(`UPDATE oxford_entry SET meaning = ?, examples = ?, ipa = ?, fetched_at = datetime('now')
                      WHERE id = ?`).bind(sense.meaning, JSON.stringify(sense.examples), sense.ipa, card.id).run();
  }));
}

const SCENE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          vi: { type: 'string' },
          situation: { type: 'string' },
          sample: { type: 'string' },
        },
        required: ['id', 'vi', 'situation', 'sample'],
      },
    },
  },
  required: ['items'],
};

export function scenePrompt(cards) {
  const list = cards.map((c) => ({ id: c.id, term: c.term, part_of_speech: c.pos || 'phrase',
                                   meaning: c.meaning || null }));
  return `You are preparing a speaking-practice test for a Vietnamese adult who works as a
software engineer and is learning English (B1 moving to B2).

For each entry below, write:
- vi: a short Vietnamese gloss of THIS meaning, with full diacritics.
- situation: one or two sentences, in the second person, describing a concrete
  everyday or workplace moment where a fluent speaker would naturally use this
  entry in this meaning. End with what the learner should say or write, e.g.
  "Tell your colleague why you are late." The situation must NOT contain the
  entry or any form of it, and must not hint at its spelling.
- sample: one natural sentence a fluent speaker would say in that situation,
  using the entry in this meaning.

Entries (JSON): ${JSON.stringify(list)}`;
}

// A situation takes the model 5-6 seconds per item, so twenty in one request ran
// past the timeout. Small batches finish, and the page asks for the next one itself.
export const SCENES_PER_REQUEST = 4;

const needsScene = (card, day) => card.tested_on !== day && card.situation_on !== day && !!card.meaning;

/** A fresh situation per item per day, and a Vietnamese gloss the first time. */
async function fillScenes(db, userId, need, day, env) {
  const { data } = await askJson(scenePrompt(need), SCENE_SCHEMA, env);
  const byId = new Map(need.map((c) => [c.id, c]));
  for (const row of data.items || []) {
    const card = byId.get(row.id);
    if (!card || !row.situation) continue;
    Object.assign(card, { situation: row.situation, sample: row.sample, situation_on: day, vi: card.vi || row.vi });
    await db.prepare('UPDATE daily_card SET situation = ?, sample = ?, situation_on = ? WHERE user_id = ? AND entry_id = ?')
      .bind(row.situation, row.sample || null, day, userId, row.id).run();
    if (row.vi) await db.prepare('UPDATE oxford_entry SET vi = COALESCE(vi, ?) WHERE id = ?').bind(row.vi, row.id).run();
  }
}

/**
 * Prepare situations for the next few untested items, those named in `ids`
 * first. Errors are returned, not thrown: the check works without them.
 */
export async function prepareScenes(env, user, ids = [], { now = new Date(), allowModelCall = async () => true } = {}) {
  const day = today(now);
  const cards = (await activeCards(env.DB, user.id)).filter((c) => needsScene(c, day));
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(Number));
  const ordered = [...cards.filter((c) => wanted.has(c.id)), ...cards.filter((c) => !wanted.has(c.id))];
  const batch = ordered.slice(0, SCENES_PER_REQUEST);

  let error = null;
  if (batch.length) {
    if (!(await allowModelCall())) {
      error = 'today\'s limit of model requests is reached';
    } else {
      try {
        await fillScenes(env.DB, user.id, batch, day, env);
      } catch (e) {
        console.error('could not prepare situations', e?.message);
        error = e?.message || 'the language model is unavailable';
      }
    }
  }
  const prepared = batch.filter((c) => c.situation_on === day);
  return {
    cards: prepared.map((c) => publicCard(c, day)),
    remaining: cards.length - prepared.length,
    ...(error ? { error } : {}),
  };
}

function publicCard(card, day) {
  const fresh = card.situation_on === day;
  return {
    id: card.id, list: card.list, term: card.term, pos: card.pos, level: card.level,
    meaning: card.meaning, vi: card.vi, ipa: card.ipa, examples: card.examples,
    url: `https://www.oxfordlearnersdictionaries.com${card.path}`,
    situation: fresh ? card.situation : null,
    sample: fresh ? card.sample : null,
    context: contextFor(card.term, card.examples),
    testedToday: card.tested_on === day,
    attempts: card.attempts,
    passes: card.passes,
    passesNeeded: RELEARN_PASSES,
    addedOn: card.added_on,
    lastResult: card.last_result,
  };
}

async function stats(db, userId, day) {
  const { results } = await db.prepare(`
    SELECT list,
           SUM(status = 'mastered') AS mastered,
           SUM(status = 'mastered' AND mastered_on = ?) AS mastered_today,
           SUM(added_on = ?) AS drawn_today
    FROM daily_card WHERE user_id = ? GROUP BY list`).bind(day, day, userId).all();
  const pool = await db.prepare('SELECT list, COUNT(*) AS n FROM oxford_entry GROUP BY list').all();
  const out = {};
  for (const list of LISTS) {
    const row = results.find((r) => r.list === list) || {};
    out[list] = {
      mastered: row.mastered ?? 0, masteredToday: row.mastered_today ?? 0,
      drawnToday: row.drawn_today ?? 0, replacementsPerDay: REPLACEMENTS_PER_LIST_PER_DAY,
      pool: pool.results.find((r) => r.list === list)?.n ?? 0,
    };
  }
  return out;
}

/** Today's set for one person, refilled and read from Oxford. Situations come separately. */
export async function dailyState(env, user, { now = new Date(), fetchImpl = fetch } = {}) {
  const day = today(now);
  await refill(env.DB, user.id, day);
  const cards = await activeCards(env.DB, user.id);
  await fillFromOxford(env.DB, cards, { fetchImpl });
  return {
    day,
    lists: Object.fromEntries(LISTS.map((list) => [list,
      cards.filter((c) => c.list === list).map((c) => publicCard(c, day))])),
    stats: await stats(env.DB, user.id, day),
    scenesPending: cards.filter((c) => needsScene(c, day)).length,
  };
}

// ---------------------------------------------------------------- marking --

const GRADE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          understood: { type: 'boolean' },
          meaning_ok: { type: 'boolean' },
          grammar_ok: { type: 'boolean' },
          natural_ok: { type: 'boolean' },
          feedback: { type: 'string' },
          corrected: { type: 'string' },
        },
        required: ['id', 'understood', 'meaning_ok', 'grammar_ok', 'natural_ok', 'feedback', 'corrected'],
      },
    },
  },
  required: ['items'],
};

export function gradePrompt(entries) {
  return `You are an English examiner judging whether a B1-B2 learner UNDERSTANDS a word or
phrase and can USE it in real communication. For each answer you get the target entry,
its dictionary meaning, the learner's own explanation of that meaning (English or
Vietnamese), the situation the learner was given, and the sentence they wrote.

- understood: the learner's explanation shows they know this meaning. Any wording,
  a synonym, a Vietnamese translation or a short example all count; it does not need
  to match the dictionary. A different sense of the same word, or something vague
  enough to fit many words, does not: false.

Then judge only how the TARGET is used in the sentence, strictly but fairly:
- meaning_ok: the target is used in the given meaning, in a sentence that could
  belong to this kind of situation. The learner may change the details of the
  scene; that is fine. A sentence that would make sense with almost any word in
  place of the target (e.g. "This word is useful.") does NOT show the meaning: false.
- grammar_ok: the target's own grammar is right - its form, the preposition or
  structure it takes, its collocations, countability. Mistakes elsewhere in the
  sentence (tense of another verb, articles, punctuation) do not count here.
- natural_ok: a fluent speaker could plausibly say this sentence; the register
  suits the situation.

feedback: one or two short sentences in simple English, addressed to the learner
("You..."), naming the most important problem with the explanation or the sentence,
or confirming what was good.
corrected: the learner's sentence with the smallest changes that make it right and
natural, fixing other mistakes too. If it is already right, repeat it unchanged.
When the target is used well, say so in the feedback even if you fixed something else.

If the target is missing from the sentence, all three are false.

Answers (JSON): ${JSON.stringify(entries)}`;
}

const MAX_SENTENCE = 400;
const MAX_EXPLANATION = 300;
const clip = (text, max) => (typeof text === 'string' ? text.trim().slice(0, max) : '');

/**
 * Mark one pass of the check and apply it. A pass is understood AND used well;
 * an item is dropped on a pass at first sight, or after RELEARN_PASSES passes. Nothing is
 * written if the answers cannot be marked, so they can be sent again.
 */
export async function gradeDaily(env, user, answers, { now = new Date(), allowModelCall = async () => true } = {}) {
  const day = today(now);
  const cards = new Map((await activeCards(env.DB, user.id)).map((c) => [c.id, c]));

  const marked = [];
  for (const raw of Array.isArray(answers) ? answers : []) {
    const card = cards.get(Number(raw?.id));
    if (!card || card.tested_on === day) continue;     // not yours, or already counted today
    const explanation = clip(raw.explanation, MAX_EXPLANATION);
    const sentence = clip(raw.sentence, MAX_SENTENCE);
    const skipped = raw.skipped === true || (!explanation && !sentence);
    marked.push({ card, skipped, explanation, sentence });
  }

  const toJudge = marked.filter((m) => !m.skipped);
  const judged = new Map();
  if (toJudge.length) {
    if (!(await allowModelCall())) throw new GeminiError('today\'s limit of marking requests is reached', 429);
    const { data } = await askJson(gradePrompt(toJudge.map(({ card, explanation, sentence }) => ({
      id: card.id, target: card.term, meaning: card.meaning,
      learner_explanation: explanation || '(left blank)',
      situation: card.situation_on === day ? card.situation : 'Use it in a sentence about your own life or work.',
      sentence: sentence || '(left blank)',
    }))), GRADE_SCHEMA, env);
    for (const row of data.items || []) judged.set(row.id, row);
  }

  const results = [];
  for (const { card, skipped, explanation, sentence } of marked) {
    const judgement = judged.get(card.id) || null;
    const passed = !!judgement && judgement.understood && judgement.meaning_ok
      && judgement.grammar_ok && judgement.natural_ok;
    const passes = card.passes + (passed ? 1 : 0);
    const knewIt = passed && card.attempts === 0;
    const mastered = knewIt || passes >= RELEARN_PASSES;
    const result = { skipped, explanation: explanation || null, sentence: sentence || null, judgement,
                     passed, passes, passesNeeded: RELEARN_PASSES, knewIt, mastered };
    await env.DB.prepare(`
      UPDATE daily_card SET tested_on = ?, attempts = attempts + 1, passes = ?, last_result = ?,
             status = ?, mastered_on = ?
      WHERE user_id = ? AND entry_id = ?`).bind(
      day, passes, JSON.stringify(result), mastered ? 'mastered' : 'active', mastered ? day : null,
      user.id, card.id).run();
    results.push({ id: card.id, term: card.term, list: card.list, ...result });
  }
  return results;
}
