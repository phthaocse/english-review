// A short IELTS-format reading task over recent words, every few days. The
// passage is plain; the right answers paraphrase it using the learner's words,
// which is how IELTS Reading tests vocabulary.

import { askJson, GeminiError } from './gemini.js';
import { today } from './daily.js';

export const EVERY_DAYS = 3;
const WORDS_PER_TASK = 5;
const MIN_WORDS = 4;
const MIN_QUESTIONS = 3;
const TFNG = ['TRUE', 'FALSE', 'NOT GIVEN'];

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    passage: { type: 'string' },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['mc', 'tfng'] },
          text: { type: 'string' },
          options: { type: 'array', items: { type: 'string' }, nullable: true },
          answer: { type: 'string' },
          explanation: { type: 'string' },
        },
        required: ['kind', 'text', 'options', 'answer', 'explanation'],
      },
    },
  },
  required: ['title', 'passage', 'questions'],
};

export function taskPrompt(words) {
  return `Write a short IELTS Academic Reading practice task for a B1-B2 learner.

1. passage: about 120-150 words on an IELTS topic (work, technology, education,
   environment, health, cities), in plain B1 English. Do NOT use the target words
   in the passage itself.
2. Exactly 4 questions in real IELTS formats, each built so that answering it needs
   one of the target words (listed with the meaning to test):
   - 2 of kind "mc": text = a sentence stem, options = 4 endings A-D, answer = the
     letter. The correct ending paraphrases the passage using a target word; the
     others are plausible but contradicted by, or absent from, the passage.
   - 2 of kind "tfng": text = a statement using a target word, options = null,
     answer = TRUE, FALSE or NOT GIVEN as the passage decides.
   explanation: one sentence pointing to the part of the passage that decides it.
Use each target word at most once across the questions.

Target words (JSON): ${JSON.stringify(words)}`;
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ref: { type: 'integer' }, answer: { type: 'string' }, ambiguous: { type: 'boolean' } },
        required: ['ref', 'answer', 'ambiguous'],
      },
    },
  },
  required: ['answers'],
};

/** The checker reads the passage and answers the questions without the key. */
export function verifyTaskPrompt(passage, questions) {
  return `Answer these IELTS reading questions from the passage only, as a careful examiner.
For "mc" give the letter A-D; for "tfng" give TRUE, FALSE or NOT GIVEN. Set ambiguous =
true if more than one answer could be defended from the passage.

Passage: ${passage}

Questions (JSON): ${JSON.stringify(questions.map((q, ref) => ({ ref, kind: q.kind, text: q.text, options: q.options })))}`;
}

const letterOk = (a) => /^[A-D]$/.test(a);

/** Keep only well-formed questions the blind checker answered the same way, unambiguously. */
export function keepAgreed(questions, answers) {
  const byRef = new Map(answers.map((a) => [a.ref, a]));
  return questions.filter((q, ref) => {
    const a = byRef.get(ref);
    const key = String(q.answer).trim().toUpperCase();
    const shapeOk = q.kind === 'mc' ? Array.isArray(q.options) && q.options.length === 4 && letterOk(key)
      : TFNG.includes(key);
    return shapeOk && a && !a.ambiguous && String(a.answer).trim().toUpperCase() === key;
  });
}

async function lastTask(db, userId) {
  return db.prepare('SELECT * FROM ielts_task WHERE user_id = ? ORDER BY id DESC LIMIT 1').bind(userId).first();
}

const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** Whether a task is waiting, due, or not yet. */
export async function ieltsStatus(env, user, { now = new Date() } = {}) {
  const day = today(now);
  const last = await lastTask(env.DB, user.id);
  if (last?.status === 'ready') return { state: 'ready', task: publicTask(last) };
  const dealt = await env.DB.prepare('SELECT COUNT(*) AS n FROM word_state WHERE user_id = ?').bind(user.id).first('n');
  const due = dealt >= MIN_WORDS && (!last || daysBetween(last.created_on, day) >= EVERY_DAYS);
  return { state: due ? 'due' : 'later', nextOn: last ? last.created_on : null, everyDays: EVERY_DAYS };
}

function publicTask(row) {
  return { id: row.id, title: row.title, passage: row.passage, questions: JSON.parse(row.questions),
           createdOn: row.created_on };
}

/** Write and check a task over the most recently dealt words. Two model requests. */
export async function createTask(env, user, { now = new Date() } = {}) {
  const status = await ieltsStatus(env, user, { now });
  if (status.state === 'ready') return status.task;
  if (status.state !== 'due') throw new GeminiError('no IELTS task is due yet', 409);

  const { results } = await env.DB.prepare(`
    SELECT w.entry_id, e.term, e.pos, p.points FROM word_state w JOIN oxford_entry e ON e.id = w.entry_id
    JOIN word_profile p ON p.entry_id = w.entry_id WHERE w.user_id = ?
    ORDER BY w.tested_on IS NULL, w.tested_on DESC, w.dealt_on DESC LIMIT ?`).bind(user.id, WORDS_PER_TASK).all();
  const words = results.map((r) => ({ word: r.term, part_of_speech: r.pos,
                                      meaning: JSON.parse(r.points)[0]?.def || null }));

  const { data } = await askJson(taskPrompt(words), TASK_SCHEMA, env);
  const questions = (data.questions || []).map((q) => ({ ...q, answer: String(q.answer).trim().toUpperCase() }));
  const check = await askJson(verifyTaskPrompt(data.passage, questions), VERIFY_SCHEMA, env);
  const kept = keepAgreed(questions, check.data.answers || []);
  if (kept.length < MIN_QUESTIONS) throw new GeminiError('the task did not pass its check - try again', 502);

  const shown = kept.map((q) => ({ kind: q.kind, text: q.text, options: q.kind === 'mc' ? q.options : TFNG }));
  const keys = kept.map((q) => ({ answer: q.answer, explanation: q.explanation }));
  const row = await env.DB.prepare(`INSERT INTO ielts_task (user_id, created_on, entry_ids, title, passage, questions, keys)
                                     VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .bind(user.id, today(now), JSON.stringify(results.map((r) => r.entry_id)), data.title || null, data.passage,
          JSON.stringify(shown), JSON.stringify(keys)).first();
  return publicTask(row);
}

/** Mark a task; the keys and explanations are sent only now. */
export async function answerTask(env, user, body) {
  const row = await env.DB.prepare("SELECT * FROM ielts_task WHERE id = ? AND user_id = ? AND status = 'ready'")
    .bind(Number(body?.id), user.id).first();
  if (!row) throw new GeminiError('no open task with that id', 404);
  const keys = JSON.parse(row.keys);
  const given = Array.isArray(body.answers) ? body.answers.map((a) => String(a ?? '').trim().toUpperCase()) : [];
  const results = keys.map((k, i) => ({ given: given[i] || null, answer: k.answer, right: given[i] === k.answer,
                                        explanation: k.explanation }));
  const score = results.filter((r) => r.right).length;
  await env.DB.prepare("UPDATE ielts_task SET answers = ?, score = ?, status = 'done' WHERE id = ?")
    .bind(JSON.stringify(given), score, row.id).run();
  return { score, of: keys.length, results };
}
