// The question bank: two questions per checklist point, written from the Oxford
// profile and checked by a second, blind pass before anyone sees them.

import { askJson } from './gemini.js';
import { CHECKLIST_SIZE } from './profile.js';

// Per point: a quick check for the first question of the day, a short
// production for the second. Each is a separate version the retests can rotate through.
const PLAN = {
  sense: ['meaning_mc', 'sentence'],
  idiom: ['meaning_mc', 'sentence'],
  pattern: ['pattern_mc', 'rewrite'],
  collocation: ['pattern_mc', 'fix_word'],
};
export const KEYED_TYPES = new Set(['meaning_mc', 'pattern_mc', 'fix_word']);
const OPTION_COUNT = 3;
// A word is tested about eight times; one with a short checklist needs a second
// version of each question so the retests do not run out of new ones.
const SHORT_CHECKLIST = 4;

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          word_id: { type: 'integer' },
          point_key: { type: 'string' },
          type: { type: 'string', enum: Object.values(PLAN).flat() },
          stem: { type: 'string', nullable: true },
          options: { type: 'array', items: { type: 'string' }, nullable: true },
          answer_index: { type: 'integer', nullable: true },
          wrong_word: { type: 'string', nullable: true },
          accepted_fixes: { type: 'array', items: { type: 'string' }, nullable: true },
          instruction: { type: 'string', nullable: true },
          model_answers: { type: 'array', items: { type: 'string' }, nullable: true },
        },
        // All required, null where a field does not apply: with only the ids required the
        // model sometimes returned bare stems with no options or key.
        required: ['word_id', 'point_key', 'type', 'stem', 'options', 'answer_index', 'wrong_word',
                   'accepted_fixes', 'instruction', 'model_answers'],
      },
    },
  },
  required: ['items'],
};

/** What the writer needs per word: its checklist, with Oxford's examples as reference only. */
export function bankRequest(words) {
  return words.map(({ id, term, pos, points }) => ({
    word_id: id, word: term, part_of_speech: pos,
    points: points.slice(0, CHECKLIST_SIZE).map((p) => ({
      point_key: p.key, kind: p.kind,
      write: points.length < SHORT_CHECKLIST ? [...PLAN[p.kind], ...PLAN[p.kind]] : PLAN[p.kind],
      meaning: p.def, ...(p.pattern ? { pattern: p.pattern } : {}),
      ...(p.collocation ? { collocation: p.collocation } : {}), ...(p.phrase ? { idiom: p.phrase } : {}),
      ...(p.labels ? { labels: p.labels } : {}), ...(p.grammar ? { grammar: p.grammar } : {}),
      oxford_examples: p.examples,
    })),
  }));
}

export const expectedCount = (words) =>
  bankRequest(words).reduce((n, w) => n + w.points.reduce((m, p) => m + p.write.length, 0), 0);

export function writePrompt(words) {
  return `You write vocabulary test questions for a Vietnamese adult learning English (B1 moving
to B2) who works as a software engineer and is preparing for IELTS.

For every point of every word below, write exactly the question types listed in "write",
one per entry (a type listed twice means two different versions, on different topics). Every question tests THAT point only (that meaning, that pattern, that
collocation), in a NEW sentence: never copy or lightly edit the Oxford examples, which
are there so you know the point, not to be reused. Mix everyday, workplace and
IELTS-style topics (education, technology, environment, health, work, cities).
Keep everything except the target at B1 level, so only the target is being tested.

Types and the fields each one uses:
- meaning_mc: stem = one sentence using the word in this meaning; options = ${OPTION_COUNT}
  short meanings; answer_index = the correct one (0-based). The wrong options are
  other meanings of the same word or meanings a learner might confuse with it - each
  must be clearly wrong IN THIS SENTENCE.
- pattern_mc: options = ${OPTION_COUNT} complete sentences, exactly one correct; answer_index.
  The two wrong sentences contain the mistakes learners really make with this pattern
  or collocation: wrong preposition, wrong verb form after it (to do / doing / do),
  "make somebody to do", wrong word order, wrong countability. Only the target part differs.
- fix_word: stem = one sentence with exactly ONE wrong word inside the collocation or
  pattern; wrong_word = that word as written; accepted_fixes = every word that would
  make the sentence correct and natural (usually one).
- rewrite: stem = a plain B1 sentence that does not use the target; instruction =
  "Rewrite using <the pattern>, keeping the meaning."; model_answers = 1-3 correct rewrites.
- sentence: stem = a one-line situation in the second person, ending with what to say
  (the situation only - the instruction goes in its own field, not repeated here);
  instruction = "Answer in one sentence using <word or phrase>."; model_answers = 1-2
  natural answers. The situation must call for THIS meaning and must not contain the target.

Multiple-choice rules: exactly one option can be right; options of similar length and
style; no "all/none of the above"; vary which position is correct.

Every item has every field; use null for the fields its type does not use.
Return exactly ${expectedCount(words)} items: one per type in each point's "write" list.

Words (JSON): ${JSON.stringify(bankRequest(words))}`;
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: { type: 'integer' },
          answer_index: { type: 'integer', nullable: true },
          wrong_word: { type: 'string', nullable: true },
          fixes: { type: 'array', items: { type: 'string' }, nullable: true },
          ambiguous: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['ref', 'ambiguous', 'note'],
      },
    },
  },
  required: ['items'],
};

/** The checker sees the questions only - never the keys - so its answers are independent. */
export function verifyPrompt(items) {
  const blind = items.map((it, ref) => ({
    ref, type: it.type, target: it.target,
    ...(it.type === 'fix_word' ? { sentence: it.stem } : { stem: it.stem || null, options: it.options }),
  }));
  return `You are checking English test questions written for B1-B2 learners. Answer each one
yourself, as a careful native-speaker teacher would.

- For multiple choice (meaning_mc, pattern_mc): give answer_index (0-based) of the one
  correct option. Set ambiguous = true if more than one option is acceptable, if none is,
  or if a native speaker could reasonably argue for another option.
- For fix_word: the sentence should contain exactly one wrong word. Give wrong_word and
  fixes (every word that would make it correct and natural). Set ambiguous = true if the
  sentence is already acceptable, has more than one error, or the error is not clear.
note: one short sentence explaining any problem, or "ok".

Questions (JSON): ${JSON.stringify(blind)}`;
}

const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/[.,!?;:]+$/, '');
// "to convincing" and "convincing" name the same mistake; one containing the other is agreement.
const overlaps = (a, b) => !!a && !!b && (` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `));

/** Drop anything malformed; split what the learner sees from the key the Worker keeps. */
export function shapeItem(raw, termById) {
  const target = termById.get(raw.word_id);
  if (!target || !raw.point_key) return null;
  const options = Array.isArray(raw.options) ? raw.options.map((o) => String(o).trim()).filter(Boolean) : [];
  const answers = Array.isArray(raw.model_answers) ? raw.model_answers.filter(Boolean) : [];
  const base = { entry_id: raw.word_id, point_key: raw.point_key, type: raw.type, target };

  switch (raw.type) {
    case 'meaning_mc':
    case 'pattern_mc': {
      const okIndex = Number.isInteger(raw.answer_index) && raw.answer_index >= 0 && raw.answer_index < options.length;
      if (options.length !== OPTION_COUNT || !okIndex || new Set(options.map(norm)).size !== OPTION_COUNT) return null;
      if (raw.type === 'meaning_mc' && !raw.stem) return null;
      return { ...base, stem: raw.stem || null, options, answer: { index: raw.answer_index } };
    }
    case 'fix_word': {
      const fixes = (raw.accepted_fixes || []).map(norm).filter(Boolean);
      const wrong = norm(raw.wrong_word);
      if (!raw.stem || !wrong || !fixes.length) return null;
      if (!new RegExp(`\\b${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(raw.stem)) return null;
      return { ...base, stem: raw.stem, answer: { wrong_word: wrong, fixes } };
    }
    case 'rewrite':
    case 'sentence':
      if (!raw.stem || !raw.instruction || !answers.length) return null;
      return { ...base, stem: raw.stem, instruction: raw.instruction, answer: { model_answers: answers } };
    default:
      return null;
  }
}

/** Compare the blind answers with the keys: agreement verifies, anything else rejects. */
export function applyVerdicts(items, verdicts) {
  const byRef = new Map(verdicts.map((v) => [v.ref, v]));
  return items.map((it, ref) => {
    if (!KEYED_TYPES.has(it.type)) return { ...it, status: 'verified', verify_note: 'open answer, marked when answered' };
    const v = byRef.get(ref);
    // Skipped is not judged: it stays unchecked, is never shown, and is checked again later.
    if (!v) return { ...it, status: 'draft', verify_note: 'checker gave no answer' };
    if (v.ambiguous) return { ...it, status: 'rejected', verify_note: `ambiguous: ${v.note}` };
    const agrees = it.type === 'fix_word'
      ? overlaps(norm(v.wrong_word), it.answer.wrong_word)
        && (v.fixes || []).map(norm).some((f) => it.answer.fixes.some((k) => overlaps(f, k)))
      : v.answer_index === it.answer.index;
    if (!agrees) return { ...it, status: 'rejected', verify_note: `checker disagreed: ${v.note}` };
    // The checker may know a fix the writer missed; keep it, so a right answer is never marked wrong.
    const fixes = it.type === 'fix_word' ? [...new Set([...it.answer.fixes, ...(v.fixes || []).map(norm)])] : null;
    return { ...it, ...(fixes ? { answer: { ...it.answer, fixes } } : {}), status: 'verified', verify_note: v.note };
  });
}

/** Write and check the questions for a few words. Two model requests, whatever the count. */
export async function buildBank(words, env) {
  const termById = new Map(words.map((w) => [w.id, w.term]));
  const written = await askJson(writePrompt(words), ITEM_SCHEMA, env);
  const raws = written.data.items || [];
  const items = raws.map((r) => shapeItem(r, termById)).filter(Boolean);
  const malformed = raws.filter((r) => !shapeItem(r, termById));
  const keyed = items.filter((it) => KEYED_TYPES.has(it.type));
  const checked = keyed.length ? await askJson(verifyPrompt(keyed), VERIFY_SCHEMA, env) : { data: { items: [] } };
  const verdicts = applyVerdicts(keyed, checked.data.items || []);
  const open = applyVerdicts(items.filter((it) => !KEYED_TYPES.has(it.type)), []);
  return { items: [...verdicts, ...open], model: written.model, dropped: malformed.length, malformed };
}

/** Store a built bank; keys go in `answer`, which the page never receives. */
export async function saveBank(db, items, model) {
  for (const it of items) {
    const body = { stem: it.stem, ...(it.options ? { options: it.options } : {}),
                   ...(it.instruction ? { instruction: it.instruction } : {}) };
    await db.prepare(`INSERT INTO quiz_item (entry_id, point_key, type, body, answer, status, verify_note, model)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(it.entry_id, it.point_key, it.type, JSON.stringify(body), JSON.stringify(it.answer),
            it.status, it.verify_note || null, model || null).run();
  }
}

/**
 * Build the bank for the next words in deal order that have none yet. Each word
 * costs two model requests, so the night's run stops at the first refusal rather
 * than spending the day's quota on retries.
 */
export async function fillNext(env, { limit = 1, collection = 'core-1000' } = {}) {
  const { results } = await env.DB.prepare(`
    SELECT s.entry_id AS id, e.term, e.pos, p.points
    FROM study_word s JOIN oxford_entry e ON e.id = s.entry_id JOIN word_profile p ON p.entry_id = s.entry_id
    WHERE s.collection = ? AND NOT EXISTS (SELECT 1 FROM quiz_item q WHERE q.entry_id = s.entry_id)
    ORDER BY s.position LIMIT ?`).bind(collection, limit).all();

  const built = [];
  for (const row of results) {
    const word = { id: row.id, term: row.term, pos: row.pos, points: JSON.parse(row.points) };
    const bank = await buildBank([word], env);
    await saveBank(env.DB, bank.items, bank.model);
    built.push({ term: row.term, verified: bank.items.filter((i) => i.status === 'verified').length,
                 rejected: bank.items.filter((i) => i.status === 'rejected').length });
  }
  return built;
}

/** Build the bank for one word, when a dealt word has none yet. */
export async function buildFor(env, entryId) {
  const row = await env.DB.prepare(`
    SELECT e.id, e.term, e.pos, p.points FROM oxford_entry e JOIN word_profile p ON p.entry_id = e.id
    WHERE e.id = ?`).bind(entryId).first();
  if (!row) return null;
  const bank = await buildBank([{ id: row.id, term: row.term, pos: row.pos, points: JSON.parse(row.points) }], env);
  await saveBank(env.DB, bank.items, bank.model);
  return { term: row.term, verified: bank.items.filter((i) => i.status === 'verified').length };
}

export async function bankStats(db, collection = 'core-1000') {
  const row = await db.prepare(`
    SELECT COUNT(*) AS words,
           SUM(EXISTS (SELECT 1 FROM word_profile p WHERE p.entry_id = s.entry_id)) AS profiled,
           SUM(EXISTS (SELECT 1 FROM quiz_item q WHERE q.entry_id = s.entry_id)) AS with_questions
    FROM study_word s WHERE s.collection = ?`).bind(collection).first();
  const { results } = await db.prepare(`
    SELECT q.status, COUNT(*) AS n FROM quiz_item q JOIN study_word s ON s.entry_id = q.entry_id
    WHERE s.collection = ? GROUP BY q.status`).bind(collection).all();
  return { ...row, questions: Object.fromEntries(results.map((r) => [r.status, r.n])) };
}
