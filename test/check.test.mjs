import worker from '../worker/src/index.js';
import { pickItems, pickRetest, pickPractice, levelAfter, fixMatches, permutation, featureOf, answer, nextQuestion,
         markPending, overview, report, RELEARN_PASSES, MAX_RETESTS }
  from '../worker/src/check.js';
import { keepAgreed } from '../worker/src/ielts.js';
import { makeD1, addUser } from './d1.mjs';
import { makeSigner, claimsFor } from './jwt.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x); } };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('== picking the day\'s two questions ==');
{
  const points = [{ key: 'sense:1' }, { key: 'pattern:p' }, { key: 'colloc:c' }];
  const items = [
    { id: 1, point_key: 'sense:1', type: 'meaning_mc' }, { id: 2, point_key: 'sense:1', type: 'sentence' },
    { id: 3, point_key: 'pattern:p', type: 'pattern_mc' }, { id: 4, point_key: 'pattern:p', type: 'rewrite' },
    { id: 5, point_key: 'colloc:c', type: 'pattern_mc' }, { id: 6, point_key: 'colloc:c', type: 'fix_word' },
    { id: 7, point_key: 'sense:1', type: 'meaning_mc' },
  ];
  let { q1, q2 } = pickItems(points, items, []);
  eq('the first question goes to the core meaning', q1.point_key, 'sense:1');
  ok('the second goes to a different point', q2.point_key !== q1.point_key, JSON.stringify(q2));
  eq('  the most important one after it', q2.point_key, 'pattern:p');
  const passedCore = [{ item_id: 1, point_key: 'sense:1', verdict: 'right', at: '2026-10-01' }];
  ({ q1 } = pickItems(points, items, passedCore));
  eq('a passed point gives way to the next', q1.point_key, 'pattern:p');
  const allPassed = ['sense:1', 'pattern:p', 'colloc:c'].map((k, i) => ({ item_id: [1, 3, 5][i], point_key: k,
    verdict: 'right', at: `2026-10-0${i + 1}` }));
  ({ q1 } = pickItems(points, items, allPassed));
  eq('with everything passed, the longest-unseen point comes back', q1.point_key, 'sense:1');
  eq('  in a version not seen before', q1.id, 7);
}

console.log('== small pieces ==');
{
  ok('a fix on the key is right', fixMatches('for', ['for']));
  ok('  capitals and full stops do not matter', fixMatches('For.', ['for']));
  ok('one slip on a longer word is forgiven', fixMatches('necesarily', ['necessarily']));
  ok('  but not on a short one', !fixMatches('fro', ['for']));
  const p = permutation(3, () => 0.5);
  eq('a permutation keeps every option', [...p].sort().join(), '0,1,2');
  eq('collocation questions count towards collocation', featureOf('pattern_mc', 'collocation'), 'collocation');
  eq('pattern questions count towards accuracy', featureOf('pattern_mc', 'pattern'), 'accuracy');
  eq('a rewrite is paraphrase', featureOf('rewrite', 'pattern'), 'paraphrase');
}

// ------------------------------------------------------------------ api ---

const CLIENT_ID = 'cid';
const signer = await makeSigner();
const realFetch = globalThis.fetch;
let markOk = () => true;
let modelCalls = [];
const reply = (obj) => ({ ok: true, json: async () => ({
  steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(obj) }] }] }) });
globalThis.fetch = async (url, init) => {
  if (String(url).includes('googleapis.com/oauth2')) return signer.jwksFetch()();
  const prompt = JSON.parse(init.body).input[0].text;
  modelCalls.push(prompt);
  const refs = [...prompt.matchAll(/"ref":(\d+)/g)].map((m) => Number(m[1]));
  if (prompt.includes('IELTS examiner judging')) {
    return reply({ items: refs.map((ref) => ({ ref, ok: markOk(ref), feedback: markOk(ref) ? 'Good.' : 'Wrong preposition.', corrected: 'Fixed.' })) });
  }
  if (prompt.includes('You write vocabulary test questions')) {
    const id = JSON.parse(prompt.split('Words (JSON): ')[1])[0].word_id;
    return reply({ items: [{ word_id: id, point_key: 'sense:1', type: 'meaning_mc', stem: 'S.', options: ['a', 'b', 'c'],
      answer_index: 0, wrong_word: null, accepted_fixes: null, instruction: null, model_answers: null }] });
  }
  if (prompt.includes('You are checking English test questions')) {
    return reply({ items: [{ ref: 0, answer_index: 0, ambiguous: false, note: 'ok' }] });
  }
  if (prompt.includes('Write a short IELTS Academic Reading')) {
    return reply({ title: 'Remote work', passage: 'A plain passage.', questions: [
      { kind: 'mc', text: 'The plan was', options: ['a', 'b', 'c', 'd'], answer: 'A', explanation: 'line 1' },
      { kind: 'mc', text: 'The offices are', options: ['a', 'b', 'c', 'd'], answer: 'b', explanation: 'line 2' },
      { kind: 'tfng', text: 'Staff felt miserable.', options: null, answer: 'TRUE', explanation: 'line 3' },
      { kind: 'tfng', text: 'It failed.', options: null, answer: 'FALSE', explanation: 'line 4' },
    ] });
  }
  if (prompt.includes('Answer these IELTS reading questions')) {
    return reply({ answers: [{ ref: 0, answer: 'A', ambiguous: false }, { ref: 1, answer: 'B', ambiguous: false },
                             { ref: 2, answer: 'TRUE', ambiguous: false }, { ref: 3, answer: 'NOT GIVEN', ambiguous: false }] });
  }
  return { ok: false, status: 500, text: async () => 'unexpected' };
};

const LEVELS = ['a1', 'b1', 'b2', 'c1'];
function makeEnv(count = 12) {
  const DB = makeD1();
  addUser(DB, 'me@x.com', { role: 'owner' });
  const raw = DB._raw;
  for (let i = 1; i <= count; i++) {
    const level = LEVELS[i % LEVELS.length];
    raw.prepare("INSERT INTO oxford_entry (id, list, term, pos, level, path) VALUES (?, 'word', ?, 'verb', ?, ?)")
      .run(i, `word${i}`, level, `/w/${i}`);
    raw.prepare("INSERT INTO study_word (entry_id, collection, position) VALUES (?, 'core-1000', ?)").run(i, i);
    const points = [{ key: 'sense:1', kind: 'sense', def: `meaning ${i}`, examples: ['Oxford ex.'] },
                    { key: 'pattern:p', kind: 'pattern', pattern: 'p', def: 'd', examples: [] }];
    raw.prepare('INSERT INTO word_profile (entry_id, profile, points, parser_version) VALUES (?, ?, ?, 2)')
      .run(i, JSON.stringify({ ipa: '/x/', senses: [{ def: `meaning ${i}`, examples: [] }], idioms: [] }), JSON.stringify(points));
    if (i === count) continue;          // the last word has no questions yet
    const add = (point, type, body, key) => raw.prepare(`INSERT INTO quiz_item (entry_id, point_key, type, body, answer, status)
      VALUES (?, ?, ?, ?, ?, 'verified')`).run(i, point, type, JSON.stringify(body), JSON.stringify(key));
    add('sense:1', 'meaning_mc', { stem: `Use word${i}.`, options: ['right one', 'wrong one', 'other one'] }, { index: 0 });
    add('pattern:p', i % 2 ? 'fix_word' : 'rewrite', i % 2 ? { stem: 'They rely of it.' } : { stem: 'Plain.', instruction: 'Rewrite.' },
        i % 2 ? { wrong_word: 'of', fixes: ['on'] } : { model_answers: ['Good.'] });
    add('pattern:p', 'pattern_mc', { options: ['ok sentence', 'bad one', 'bad two'] }, { index: 0 });
  }
  return { DB, GEMINI_API_KEY: 'k', GOOGLE_CLIENT_ID: CLIENT_ID, ALLOWED_ORIGINS: 'https://x' };
}
async function call(env, method, path, body) {
  const headers = { Origin: 'https://x', Authorization: `Bearer ${await signer.sign(claimsFor('me@x.com', CLIENT_ID))}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`https://api.test${path}`, { method, headers,
    body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: await res.json() };
}
const rightChoice = (q) => q.item.options.indexOf(q.item.options.find((o) => o === 'right one' || o === 'ok sentence'));
const wrongChoice = (q) => q.item.options.findIndex((o) => o !== 'right one' && o !== 'ok sentence');

console.log('== the overview ==');
{
  const env = makeEnv();
  const r = await call(env, 'GET', '/api/check');
  eq('200', r.status, 200);
  eq('ten words are dealt', r.body.words.length, 10);
  ok('untested words stay hidden', r.body.words.every((w) => !w.term), JSON.stringify(r.body.words[0]));
  eq('the totals know the set size', r.body.totals.of, 12);
  eq('no IELTS task before any word is checked... but four are dealt, so one is due', r.body.ielts.state, 'due');
}

console.log('== a word you already knew ==');
{
  const env = makeEnv();
  let q = (await call(env, 'GET', '/api/check/next')).body;
  eq('the first question is the quick check', q.slot, 1);
  ok('  the key is not sent', !JSON.stringify(q).includes('"index"') && !JSON.stringify(q).includes('fixes'), JSON.stringify(q));
  const word = q.word.id;
  let a = (await call(env, 'POST', '/api/check/answer', { entry_id: word, choice: rightChoice(q), ms: 3000 })).body;
  eq('a right check goes on to the second question', a.verdict, 'right');
  eq('  the word is not finished', a.done, false);
  q = (await call(env, 'GET', '/api/check/next')).body;
  eq('the second question is on the same word', q.word.id, word);
  eq('  slot 2', q.slot, 2);
  ok('  on a different point', q.item.type !== 'meaning_mc', q.item.type);
  if (q.item.type === 'fix_word') {
    a = (await call(env, 'POST', '/api/check/answer', { entry_id: word, text: 'on' })).body;
    eq('a fix on the key is marked at once', a.verdict, 'right');
    eq('both right on first sight: you knew it', a.how, 'known');
    eq('  and it is dropped', a.mastered, true);
    const after = (await call(env, 'GET', '/api/check')).body;
    eq('  and replaced', after.words.length, 10);
  }
}

console.log('== a missed check stops the word ==');
{
  const env = makeEnv();
  const q = (await call(env, 'GET', '/api/check/next')).body;
  const a = (await call(env, 'POST', '/api/check/answer', { entry_id: q.word.id, choice: wrongChoice(q) })).body;
  eq('a wrong check ends the word for today', a.done, true);
  eq('  shows the right answer', a.correct, 'right one');
  eq('  and Oxford\'s meaning', a.meaning, `meaning ${q.word.id}`);
  const next = (await call(env, 'GET', '/api/check/next')).body;
  ok('the next question is another word', next.word.id !== q.word.id);
  const ov = (await call(env, 'GET', '/api/check')).body;
  const card = ov.words.find((w) => w.id === q.word.id);
  eq('the missed word is now shown', card.term, `word${q.word.id}`);
  eq('  with its checklist', card.checklist.length, 2);
}

console.log('== sentences are marked together ==');
{
  const env = makeEnv();
  // Word 2 has a rewrite as its second question.
  let q;
  for (;;) {
    q = (await call(env, 'GET', '/api/check/next')).body;
    if (q.word.id === 2) break;
    await call(env, 'POST', '/api/check/answer', { entry_id: q.word.id, choice: wrongChoice(q) });
  }
  await call(env, 'POST', '/api/check/answer', { entry_id: 2, choice: rightChoice(q) });
  q = (await call(env, 'GET', '/api/check/next')).body;
  eq('word 2 asks for a rewrite', q.item.type, 'rewrite');
  const a = (await call(env, 'POST', '/api/check/answer', { entry_id: 2, text: 'My rewrite.' })).body;
  eq('it waits for marking', a.verdict, 'pending');
  let ov = (await call(env, 'GET', '/api/check')).body;
  eq('  and is counted as waiting, not as still to do', ov.pendingMarks, 1);
  modelCalls = [];
  markOk = () => true;
  const m = (await call(env, 'POST', '/api/check/mark')).body;
  eq('one request marks it', modelCalls.length, 1);
  eq('  right', m.results[0].verdict, 'right');
  eq('  and the word was known', m.results[0].how, 'known');
}

console.log('== shortcuts and their undo ==');
{
  const env = makeEnv();
  let q = (await call(env, 'GET', '/api/check/next')).body;
  const first = q.word.id;
  let a = (await call(env, 'POST', '/api/check/answer', { entry_id: first, skipped: true })).body;
  eq('"I don\'t know it" ends the word', a.verdict, 'skipped');
  eq('  and can be taken back', a.undoable, true);
  await call(env, 'POST', '/api/check/undo', { entry_id: first });
  q = (await call(env, 'GET', '/api/check/next')).body;
  eq('after undo the same word is asked again', q.word.id, first);
  eq('  from its first question', q.slot, 1);

  const ov = (await call(env, 'GET', '/api/check')).body;
  // Find an A1 word: offered the one-tap drop.
  let tries = 0;
  while (!q.offers.selfKnown && tries++ < 12) {
    await call(env, 'POST', '/api/check/answer', { entry_id: q.word.id, choice: wrongChoice(q) });
    q = (await call(env, 'GET', '/api/check/next')).body;
  }
  eq('an A1 word on first sight offers "I know this well"', q.word.level, 'a1');
  a = (await call(env, 'POST', '/api/check/answer', { entry_id: q.word.id, selfKnown: true })).body;
  eq('  one tap drops it', a.how, 'self');
  await call(env, 'POST', '/api/check/undo', { entry_id: q.word.id });
  const again = (await call(env, 'GET', '/api/check')).body;
  ok('  undo brings it back into play', again.words.some((w) => w.id === q.word.id), JSON.stringify(ov.totals));

  const b2 = again.words.find((w) => w.level === 'b2');
  const refused = await call(env, 'POST', '/api/check/answer', { entry_id: b2.id, selfKnown: true });
  ok('a B2 word cannot be dropped on your word', refused.status === 400 || refused.status === 409, String(refused.status));
}

console.log('== reporting a bad question ==');
{
  const env = makeEnv();
  const q = (await call(env, 'GET', '/api/check/next')).body;
  await call(env, 'POST', '/api/check/report', { item_id: q.item.id, note: 'two options fit' });
  const status = env.DB._raw.prepare('SELECT status FROM quiz_item WHERE id = ?').get(q.item.id).status;
  eq('the question leaves the bank', status, 'rejected');
  const next = (await call(env, 'GET', '/api/check/next')).body;
  eq('the same word is asked again', next.word.id, q.word.id);
  ok('  with a different question', next.item.id !== q.item.id, `${next.item.id} vs ${q.item.id}`);
  const unseen = env.DB._raw.prepare(`SELECT id FROM quiz_item WHERE status = 'verified' AND entry_id != ?
                                      ORDER BY id DESC LIMIT 1`).get(q.word.id).id;
  const refused = await call(env, 'POST', '/api/check/report', { item_id: unseen });
  eq('a question not given to you today cannot be reported', refused.status, 409);
  eq('  and stays in the bank', env.DB._raw.prepare('SELECT status FROM quiz_item WHERE id = ?').get(unseen).status,
     'verified');
}

console.log('== a word learnt here needs three separate days ==');
{
  const env = makeEnv();
  const user = { id: 1, email: 'me@x.com' };
  const dayAt = (n) => new Date(Date.UTC(2026, 9, 10 + n, 3));
  const play = async (n, right) => {
    const q = await nextQuestion(env, user, { now: dayAt(n) });
    const id = q.word.id;
    let a = await answer(env, user, { entry_id: id, choice: right ? rightChoice(q) : wrongChoice(q) }, { now: dayAt(n) });
    if (!a.done) {
      const q2 = await nextQuestion(env, user, { now: dayAt(n) });
      a = await answer(env, user, { entry_id: id, text: q2.item.type === 'fix_word' ? 'on' : 'My answer.' }, { now: dayAt(n) });
      if (a.verdict === 'pending') a = (await markPending(env, user, { now: dayAt(n) }))[0];
    }
    return { id, ...a };
  };
  const day0 = await play(0, false);
  eq('day 1 missed', day0.mastered, false);
  let r;
  for (let n = 1; n <= RELEARN_PASSES; n++) {
    r = await play(n, true);
    eq(`  day ${n + 1} is the same word`, r.id, day0.id);
    if (n < RELEARN_PASSES) eq(`  pass ${n} keeps it`, r.mastered, false);
  }
  eq(`the pass on day ${RELEARN_PASSES + 1} drops it as learnt`, r.how, 'learnt');
}

console.log('== levels and retests ==');
{
  ok('a pass on both questions means "can use"', levelAfter(1, { r1: 'right', r2: 'right' }) === 2);
  ok('  a right check alone means "recognise", even from "can use"', levelAfter(2, { r1: 'right', r2: 'wrong' }) === 1);
  ok('  a missed check drops one step', levelAfter(2, { r1: 'wrong' }) === 1 && levelAfter(0, { r1: 'skipped' }) === 0);
  const items = [{ id: 1, point_key: 'p', type: 'fix_word' }, { id: 2, point_key: 'p', type: 'pattern_mc' },
                 { id: 3, point_key: 'p', type: 'rewrite' }, { id: 4, point_key: 'q', type: 'fix_word' }];
  eq('a retest prefers another question of the same kind', pickRetest(items, items[0], new Set([1])).id, 3);
  eq('  then any other on the same point', pickRetest(items, items[0], new Set([1, 3])).id, 2);
  eq('  then the missed one again', pickRetest(items, items[0], new Set([1, 2, 3])).id, 1);

  const env = makeEnv(5);
  const user = { id: 1, email: 'me@x.com' };
  const at = (n) => new Date(Date.UTC(2026, 9, 20 + n, 3));
  const stage = (id) => env.DB._raw.prepare('SELECT level FROM word_state WHERE entry_id = ?').get(id).level;
  const next = () => nextQuestion(env, user, { now: at(0) });
  const reply = (q, body) => answer(env, user, { entry_id: q.word.id, ...body }, { now: at(0) });

  let q = await next();
  eq('the word links to its Oxford entry', q.word.url, `https://www.oxfordlearnersdictionaries.com/w/${q.word.id}`);
  await reply(q, { choice: rightChoice(q) });
  q = await next();
  eq('fix-the-word names the wrong word', q.item.wrong, 'of');
  let a = await reply(q, { text: 'on' });
  eq('a word known on first sight is secure', a.level, 3);
  eq('  coming from new', a.levelBefore, 0);

  q = await next();
  const two = q.word.id;
  await reply(q, { choice: rightChoice(q) });
  q = await next();
  await reply(q, { text: 'My answer.' });
  q = await next();
  const three = q.word.id;
  await reply(q, { choice: rightChoice(q) });
  q = await next();
  eq('  (a typed fix that is not on the key waits for marking)', (await reply(q, { text: 'xx' })).verdict, 'pending');
  q = await next();
  const four = q.word.id;
  a = await reply(q, { choice: wrongChoice(q) });
  eq('a missed check keeps a new word at new', a.level, 0);
  eq('retests wait until the sentences are marked', (await next()).done, true);

  markOk = () => false;
  modelCalls = [];
  const marked = await markPending(env, user, { now: at(0) });
  ok('the marker is told which word a fix replaces', modelCalls.some((p) => p.includes('"replaces":"of"')), modelCalls[0]?.slice(-300));
  eq('a right check with a missed sentence means "recognise"', marked.find((m) => m.entry_id === two).level, 1);

  q = await next();
  eq('then the missed words come back as retests', q.retest, true);
  eq('  starting with the first', q.word.id, two);
  eq('  asking about the missed point in another way', q.item.type, 'pattern_mc');
  a = await reply(q, { choice: rightChoice(q) });
  ok('  a right retest is practice', a.retest && a.verdict === 'right', JSON.stringify(a));
  eq('  and does not move the level', stage(two), 1);

  q = await next();
  eq('the next missed word', q.word.id, three);
  a = await reply(q, { choice: wrongChoice(q) });
  eq('a missed retest shows the answer', a.correct, 'ok sentence');
  eq('  and allows one more try', a.triesLeft, MAX_RETESTS - 1);
  q = await next();
  eq('which comes straight back', q.word.id, three);
  eq('  as the question first missed, all others used', q.item.type, 'fix_word');
  eq('  and is right', (await reply(q, { text: 'on' })).verdict, 'right');

  q = await next();
  eq('a missed check is retested', q.word.id, four);
  await reply(q, { choice: wrongChoice(q) });
  q = await next();
  a = await reply(q, { skipped: true });
  eq('two retests at most', a.triesLeft, 0);
  eq('then the day is done', (await next()).done, true);
  eq('retests never move the level', stage(four), 0);
  const undone = await call(env, 'POST', '/api/check/undo', { entry_id: four });
  eq('a retest cannot be undone', undone.status, 409);

  const view = await overview(env, user, { now: at(0) });
  eq('nothing is left to retest', view.retestLeft, 0);
  eq('the levels are counted', JSON.stringify(view.stages), JSON.stringify({ new: 2, recognise: 2, canUse: 0, secure: 1 }));
  const card = view.words.find((w) => w.id === two);
  const point = card.checklist.find((c) => c.key === 'pattern:p');
  eq('the missed point shows as missed', point.state, 'missed');
  eq('  and as practised today', point.practised, true);
  eq('the card links to Oxford', card.url, `https://www.oxfordlearnersdictionaries.com/w/${two}`);
  eq('IELTS accuracy counts first tries only', Object.values(view.features).reduce((n, f) => n + f.n, 0), 7);

  markOk = () => true;
  const day = (n) => ({ next: () => nextQuestion(env, user, { now: at(n) }),
                        reply: (q, body) => answer(env, user, { entry_id: q.word.id, ...body }, { now: at(n) }) });
  let d = day(1);
  q = await d.next();
  eq('the next day starts with the same word', q.word.id, two);
  await d.reply(q, { choice: rightChoice(q) });
  q = await d.next();
  await d.reply(q, { text: 'Good.' });
  const day1 = (await markPending(env, user, { now: at(1) })).find((m) => m.entry_id === two);
  eq('using it on a later day means "can use"', day1.level, 2);
  eq('  day 1 of 3', day1.passes, 1);
  d = day(2);
  q = await d.next();
  a = await d.reply(q, { choice: wrongChoice(q) });
  eq('a miss on a later day drops one step', a.level, 1);
}

console.log('== a miss on a point that left the checklist ==');
{
  const env = makeEnv(2);
  let q = (await call(env, 'GET', '/api/check/next')).body;
  await call(env, 'POST', '/api/check/answer', { entry_id: q.word.id, choice: wrongChoice(q) });
  env.DB._raw.prepare('UPDATE word_profile SET points = ? WHERE entry_id = ?')
    .run(JSON.stringify([{ key: 'pattern:p', kind: 'pattern', pattern: 'p', def: 'd', examples: [] }]), q.word.id);
  eq('is not retested', (await call(env, 'GET', '/api/check')).body.retestLeft, 0);
  eq('  and the day is done', (await call(env, 'GET', '/api/check/next')).body.done, true);
}

console.log('== reporting a retest ==');
{
  const env = makeEnv(2);
  const user = { id: 1, email: 'me@x.com' };
  let q = (await call(env, 'GET', '/api/check/next')).body;
  await call(env, 'POST', '/api/check/answer', { entry_id: q.word.id, choice: wrongChoice(q) });
  q = (await call(env, 'GET', '/api/check/next')).body;
  eq('the retest is served', q.retest, true);
  eq('it can be reported', (await call(env, 'POST', '/api/check/report', { item_id: q.item.id })).status, 200);
  eq('  and the miss it tested no longer asks for one', (await call(env, 'GET', '/api/check')).body.retestLeft, 0);
}

console.log('== picking a practice question ==');
{
  const points = [{ key: 'sense:1' }, { key: 'pattern:p' }];
  const items = [{ id: 1, point_key: 'sense:1', type: 'meaning_mc' }, { id: 2, point_key: 'pattern:p', type: 'pattern_mc' },
                 { id: 3, point_key: 'pattern:p', type: 'fix_word' }, { id: 4, point_key: 'off:list', type: 'meaning_mc' }];
  const seen = (pairs) => pairs.map(([item_id, at]) => ({ item_id, at }));
  eq('practice prefers a question not shown today', pickPractice(points, items, [], new Set([1, 2]))?.id, 3);
  eq('  then one never answered', pickPractice(points, items, seen([[1, '2026-10-01'], [2, '2026-10-02']]),
    new Set([1, 2, 3]))?.id, 3);
  eq('  then the one answered longest ago', pickPractice(points, items,
    seen([[1, '2026-10-03'], [2, '2026-10-01'], [3, '2026-10-02']]), new Set([1, 2, 3]))?.id, 2);
  eq('  and only from the checklist', pickPractice([{ key: 'sense:1' }], [items[3]], [], new Set()), null);
}

console.log('== a word\'s own retest ==');
{
  const env = makeEnv(5);
  const user = { id: 1, email: 'me@x.com' };
  const at = (n) => new Date(Date.UTC(2026, 9, 20 + n, 3));
  const only = (id, n = 0) => nextQuestion(env, user, { now: at(n), only: id });
  const reply = (q, body, n = 0) => answer(env, user, { entry_id: q.word.id, ...body }, { now: at(n) });
  const stage = (id) => env.DB._raw.prepare('SELECT level FROM word_state WHERE entry_id = ?').get(id).level;

  let q = await only(3);
  eq('a word still due today gets its real check, ahead of its turn', q.word.id, 3);
  eq('  not practice', q.retest, false);
  eq('  starting at the quick check', q.slot, 1);
  eq('  counted as one of one', q.progress.total, 1);
  await reply(q, { choice: rightChoice(q) });
  q = await only(3);
  eq('then its second question', [q.word.id, q.slot].join(), '3,2');
  eq('  (a fix not on the key waits for marking)', (await reply(q, { text: 'xx' })).verdict, 'pending');
  eq('a word waiting for marking has nothing to ask', (await only(3)).done, true);
  q = await nextQuestion(env, user, { now: at(0) });
  eq('Start goes on with the others', q.word.id, 1);
  const missedQ1 = q.item.id;
  await reply(q, { choice: wrongChoice(q) });

  markOk = () => false;
  await markPending(env, user, { now: at(0) });
  eq('once marked, the word is at "recognise"', stage(3), 1);

  q = await only(3);
  eq('a word missed today gets its retest first', q.retest, true);
  eq('  on the missed point', q.item.type, 'pattern_mc');
  const first = q.item.id;
  eq('a reload shows the same question', (await only(3)).item.id, first);
  let a = await reply(q, { choice: rightChoice(q) });
  eq('a right answer is practice', [a.verdict, a.retest, a.done].join(), 'right,true,true');
  eq('  and does not move the level', stage(3), 1);

  q = await only(3);
  ok('after that the button keeps giving practice', q.retest && !q.done, JSON.stringify(q));
  ok('  on another question', q.item.id !== first, `${q.item.id}`);
  a = await reply(q, { choice: wrongChoice(q) });
  eq('a missed practice shows the answer', a.correct, 'right one');
  eq('  and leaves the level alone', stage(3), 1);
  q = await only(3);
  const reported = q.item.id;
  eq('a practice question can be reported', (await report(env, user, { item_id: reported }, { now: at(0) })).reported, true);
  ok('  and another takes its place', (await only(3)).item.id !== reported, '');

  q = await only(1);
  eq('a missed check comes back first', [q.retest, q.item.id].join(), `true,${missedQ1}`);
  a = await reply(q, { choice: rightChoice(q) });
  eq('  which passes', a.verdict, 'right');
  q = await only(1);
  ok('then practice', q.retest && q.item.id !== missedQ1, JSON.stringify(q.item));
  await reply(q, { choice: rightChoice(q) });
  q = await only(1);
  eq('a practice sentence can come up', q.item.type, 'fix_word');
  eq('  and waits for marking', (await reply(q, { text: 'xx' })).verdict, 'pending');
  const out = await markPending(env, user, { now: at(0) });
  eq('marking it is practice too', out.find((o) => o.entry_id === 1)?.retest, true);
  eq('  and does not reopen the passed retest', (await overview(env, user, { now: at(0) })).retestLeft, 0);
  eq('practice never moves a level', [stage(1), stage(3)].join(), '0,1');
  const view = await overview(env, user, { now: at(0) });
  eq('IELTS accuracy counts first tries only, less the reported one', Object.values(view.features).reduce((n, f) => n + f.n, 0), 2);

  eq('a word not in play has nothing to ask', (await only(99)).done, true);
  q = await only(3, 1);
  eq('the next day the button starts that day\'s check', [q.retest, q.slot].join(), 'false,1');
  markOk = () => true;

  const fresh = makeEnv(5);
  q = (await call(fresh, 'GET', '/api/check/next?word=4')).body;
  eq('the page asks for one word with ?word=', q.word.id, 4);
}

console.log('== preparing a word with no questions ==');
{
  const env = makeEnv(11);                // word 11 is not dealt; word 3 loses its questions
  env.DB._raw.exec('DELETE FROM quiz_item WHERE entry_id = 3');
  const ov = (await call(env, 'GET', '/api/check')).body;
  eq('a word without questions is counted as waiting', ov.waiting, 1);
  modelCalls = [];
  const prepared = await call(env, 'POST', '/api/check/prepare');
  eq('preparing writes questions for it', prepared.body.prepared?.verified, 1);
  eq('  with a write and a check', modelCalls.length, 2);
  eq('  and the word is no longer waiting', (await call(env, 'GET', '/api/check')).body.waiting, 0);
}

console.log('== the IELTS task ==');
{
  const env = makeEnv();
  await call(env, 'GET', '/api/check');
  modelCalls = [];
  const made = await call(env, 'POST', '/api/ielts/new');
  eq('200', made.status, 200);
  eq('two requests: write, then check', modelCalls.length, 2);
  eq('the question the checker answered differently is dropped', made.body.task.questions.length, 3);
  ok('no key or explanation is sent with the task', !JSON.stringify(made.body).includes('explanation')
     && !JSON.stringify(made.body).includes('"answer"'), JSON.stringify(made.body));
  const again = await call(env, 'POST', '/api/ielts/new');
  eq('asking again returns the open task, no new requests', modelCalls.length, 2);
  eq('  the same one', again.body.task.id, made.body.task.id);
  const scored = (await call(env, 'POST', '/api/ielts/answer', { id: made.body.task.id, answers: ['A', 'C', 'TRUE'] })).body;
  eq('it is marked', `${scored.score}/${scored.of}`, '2/3');
  eq('  with the reason for each', scored.results[1].explanation, 'line 2');
  const status = (await call(env, 'GET', '/api/check')).body.ielts.state;
  eq('the next task waits three days', status, 'later');
  eq('a malformed or disputed question is never kept', keepAgreed([{ kind: 'mc', options: ['a'], answer: 'A' }],
     [{ ref: 0, answer: 'A', ambiguous: false }]).length, 0);
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
