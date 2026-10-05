import worker from '../worker/src/index.js';
import { dailyState, gradeDaily, RELEARN_PASSES } from '../worker/src/daily.js';
import { chooseBand, coreOf, contextFor, today, bandOf, SET_SIZE,
         REPLACEMENTS_PER_LIST_PER_DAY, SCENES_PER_REQUEST } from '../worker/src/daily.js';
import { parseSense } from '../worker/src/oxford.js';
import { makeSigner, claimsFor } from './jwt.mjs';
import { makeD1, addUser } from './d1.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x); } };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('== the draw leans on B1-B2 ==');
{
  eq('an empty set starts in B2', chooseBand([]).key, 'b2');
  eq('four B2 in hand, B1 is next', chooseBand(['b2', 'b2', 'b2', 'b2']).key, 'b1');
  const full = ['b2', 'b2', 'b2', 'b2', 'b1', 'b1', 'b1', 'c1', 'c1'];
  eq('only the easy slot left', chooseBand(full).key, 'a');
  eq('a1 and a2 share one band', bandOf('a2'), 'a');
  eq('a band with nothing left is skipped', chooseBand([], new Set(['b2'])).key, 'b1');
  eq('every band empty draws nothing', chooseBand([], new Set(['a', 'b1', 'b2', 'c1'])), null);
}

console.log('== the item in context ==');
{
  const c = contextFor('abolish', ['This tax should be abolished.']);
  eq('finds the form the sentence uses', c.target, 'abolished');
  eq('  splitting around it', c.before + '|' + c.after, 'This tax should be |.');
  eq('a phrase is found whole', contextFor('a great deal', ['We don\'t see them a great deal these days.']).target, 'a great deal');
  eq('placeholders are not part of what is found', coreOf('a bit of sth').join(' '), 'a bit of');
  eq('  "do sth" is a slot too', coreOf('able to do sth').join(' '), 'able to');
  eq('no example containing it → no context', contextFor('abolish', ['Nothing here.']), null);
  eq('a short word does not match a longer one', contextFor('go', ['They gossip a lot.']), null);
}

console.log('== the day turns over in Vietnam ==');
{
  eq('18:00 UTC is already tomorrow in Hanoi', today(new Date('2026-10-01T18:00:00Z')), '2026-10-02');
  eq('16:59 UTC is still today', today(new Date('2026-10-01T16:59:00Z')), '2026-10-01');
}

console.log('== reading the sense a link points at ==');
{
  const html = '<span class="phon">/bɪt/</span>'
    + '<li class="sense" id="bit_sng_1"><span class="def">rather; to some extent</span><ul class="examples">'
    + '<li><span class="x">These trousers are <span class="cl">a bit</span> tight.</span></li></ul></li>'
    + '<li class="sense" id="bit_sng_2"><span class="def">a small piece</span><ul class="examples">'
    + '<li><span class="x">a bit of paper</span></li></ul></li>';
  const s = parseSense(html, 'bit_sng_1');
  eq('the anchored definition', s.meaning, 'rather; to some extent');
  eq('  only its own examples', s.examples.length, 1);
  eq('  with inner markup stripped', s.examples[0], 'These trousers are a bit tight.');
  eq('no anchor reads the first sense', parseSense(html).meaning, 'rather; to some extent');
}

// ------------------------------------------------------------------ api ---

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const signer = await makeSigner();
const realFetch = globalThis.fetch;
let geminiHandler;
let geminiCalls = [];
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.includes('googleapis.com/oauth2')) return signer.jwksFetch()();
  if (href.includes('generativelanguage')) {
    const prompt = JSON.parse(init.body).input[0].text;
    geminiCalls.push(prompt);
    return geminiHandler(prompt);
  }
  if (href.includes('oxfordlearnersdictionaries')) {
    const term = decodeURIComponent(href.split('/').pop().split('#')[0]);
    return { ok: true, status: 200, text: async () =>
      `<span class="phon">/x/</span><li class="sense"><span class="def">meaning of ${term}</span>`
      + `<ul><li><span class="x">I said ${term} today.</span></li></ul></li>` };
  }
  return realFetch(url, init);
};

const reply = (obj) => ({ ok: true, json: async () => ({
  steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(obj) }] }] }) });
const idsIn = (prompt) => [...prompt.matchAll(/"id":(\d+)/g)].map((m) => Number(m[1]));
const scenes = (prompt) => reply({ items: idsIn(prompt).map((id) => ({
  id, vi: 'nghĩa', situation: `Situation ${id}. Tell your colleague.`, sample: `Sample ${id}.` })) });
let verdictFor = () => true;
let understoodFor = null;      // when set, understanding is judged apart from use
const grades = (prompt) => reply({ items: idsIn(prompt).map((id) => {
  const good = verdictFor(id);
  return { id, understood: understoodFor ? understoodFor(id) : good, meaning_ok: good, grammar_ok: good, natural_ok: true,
           feedback: good ? 'Good.' : 'Wrong preposition.', corrected: 'Fixed.' };
}) });
geminiHandler = (prompt) => (prompt.includes('examiner') ? grades(prompt) : scenes(prompt));

const LEVELS = ['a1', 'a2', 'b1', 'b2', 'c1'];
function makeEnv({ perLevel = 8 } = {}) {
  const DB = makeD1();
  addUser(DB, 'thaop@ghn.vn', { role: 'owner' });
  const insert = DB._raw.prepare('INSERT INTO oxford_entry (list, term, pos, level, path) VALUES (?, ?, ?, ?, ?)');
  for (const list of ['word', 'phrase']) {
    for (const level of LEVELS) {
      for (let i = 0; i < perLevel; i++) {
        const term = `${list}${level.replace(/\d/, (d) => 'xyz'[d])}${'q'.repeat(i + 1)}`;
        insert.run(list, term, list === 'word' ? 'noun' : null, level, `/definition/english/${term}`);
      }
    }
  }
  return { DB, GOOGLE_CLIENT_ID: CLIENT_ID, ALLOWED_ORIGINS: 'https://phthaocse.github.io', GEMINI_API_KEY: 'k' };
}

async function call(env, method, path, body) {
  const headers = { Origin: 'https://phthaocse.github.io',
                    Authorization: `Bearer ${await signer.sign(claimsFor('thaop@ghn.vn', CLIENT_ID))}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`https://api.test${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: await res.json() };
}

const countBy = (cards) => cards.reduce((m, c) => ({ ...m, [bandOf(c.level)]: (m[bandOf(c.level)] || 0) + 1 }), {});

console.log('== today\'s set ==');
{
  const env = makeEnv();
  geminiCalls = [];
  const r = await call(env, 'GET', '/api/daily');
  eq('200', r.status, 200);
  eq('ten words', r.body.lists.word.length, SET_SIZE);
  eq('ten phrases', r.body.lists.phrase.length, SET_SIZE);
  const bands = countBy(r.body.lists.word);
  ok('weighted 1 easy / 3 B1 / 4 B2 / 2 C1',
     bands.a === 1 && bands.b1 === 3 && bands.b2 === 4 && bands.c1 === 2, JSON.stringify(bands));
  const card = r.body.lists.word[0];
  eq('the meaning is Oxford\'s', card.meaning, `meaning of ${card.term}`);
  eq('the context is Oxford\'s example', card.context.before + card.context.target + card.context.after, `I said ${card.term} today.`);
  eq('the set comes back without waiting for the model', geminiCalls.length, 0);
  eq('  saying how many situations are still to come', r.body.scenesPending, 20);

  const wanted = r.body.lists.phrase[2].id;
  let s = await call(env, 'POST', '/api/daily/scenes', { ids: [wanted] });
  eq('situations come a few at a time', s.body.cards.length, SCENES_PER_REQUEST);
  ok('  the item you asked for first', s.body.cards.some((c) => c.id === wanted), JSON.stringify(s.body.cards.map((c) => c.id)));
  ok('  each with its situation', /^Situation \d+/.test(s.body.cards[0].situation), s.body.cards[0].situation);
  eq('  and the count goes down', s.body.remaining, 20 - SCENES_PER_REQUEST);
  ok('the prompt forbids naming the word', /must NOT contain the\s+entry/.test(geminiCalls[0]));
  while (s.body.remaining > 0) s = await call(env, 'POST', '/api/daily/scenes', {});
  eq('twenty items take five requests', geminiCalls.length, 20 / SCENES_PER_REQUEST);
  s = await call(env, 'POST', '/api/daily/scenes', {});
  eq('with none left, asking again costs nothing', geminiCalls.length, 20 / SCENES_PER_REQUEST);

  const again = await call(env, 'GET', '/api/daily');
  eq('coming back keeps the same set',
     again.body.lists.word.map((c) => c.id).join(), r.body.lists.word.map((c) => c.id).join());
  eq('  and spends no further request', geminiCalls.length, 20 / SCENES_PER_REQUEST);
  ok('  with the situations kept', again.body.lists.word.every((c) => c.situation), '');
}

console.log('== marking ==');
{
  const env = makeEnv();
  const { body: state } = await call(env, 'GET', '/api/daily');
  const [a, b, c] = state.lists.word;
  verdictFor = (id) => id === a.id;
  geminiCalls = [];

  const r = await call(env, 'POST', '/api/daily/grade', { answers: [
    { id: a.id, explanation: 'to end officially', sentence: `I used ${a.term} well.` },
    { id: b.id, explanation: 'something else', sentence: `I used ${b.term} badly.` },
    { id: c.id, skipped: true },
  ] });
  eq('200', r.status, 200);
  const byId = new Map(r.body.results.map((x) => [x.id, x]));
  eq('understood and used well → mastered', byId.get(a.id).mastered, true);
  eq('  on first sight, so you already knew it', byId.get(a.id).knewIt, true);
  eq('not understood or misused → kept', byId.get(b.id).mastered, false);
  eq('  with the examiner\'s feedback', byId.get(b.id).judgement.feedback, 'Wrong preposition.');
  eq('"I don\'t know it" → kept, never sent to the examiner', byId.get(c.id).judgement, null);
  eq('  and recorded as new to you', byId.get(c.id).skipped, true);
  ok('the examiner sees your explanation', geminiCalls[0].includes('"learner_explanation":"to end officially"'), '');
  ok('only answered items were judged',
     idsIn(geminiCalls[0]).length === 2, JSON.stringify(idsIn(geminiCalls[0])));

  const words = r.body.state.lists.word;
  eq('the mastered word left the set', words.some((w) => w.id === a.id), false);
  eq('  and a new one took its place', words.length, SET_SIZE);
  eq('the kept ones are marked as done for today', words.find((w) => w.id === b.id).testedToday, true);

  const twice = await call(env, 'POST', '/api/daily/grade', { answers: [
    { id: b.id, explanation: 'x', sentence: 'again' }] });
  eq('a second try on the same day does not count', twice.body.results.length, 0);

  const stranger = await call(env, 'POST', '/api/daily/grade', { answers: [
    { id: 99999, explanation: 'x', sentence: 'y' }] });
  eq('an entry not in your set is ignored', stranger.body.results.length, 0);
}

console.log('== an item learnt here needs three separate days ==');
{
  const env = makeEnv();
  const user = { id: 1 };
  const dayAt = (n) => new Date(Date.UTC(2026, 9, 1 + n, 3));   // 10:00 in Hanoi, day n
  const first = (await dailyState(env, user, { now: dayAt(0) })).lists.word[0];
  const answer = [{ id: first.id, explanation: 'x', sentence: 'y' }];
  const statusOn = async (n, good) => {
    verdictFor = () => good;
    return (await gradeDaily(env, user, answer, { now: dayAt(n) }))[0];
  };
  let r = await statusOn(0, false);
  eq('day 1: failed, so it is being learnt', r.mastered, false);
  r = await statusOn(1, true);
  eq('day 2: a pass is not enough', r.mastered, false);
  eq('  it counts as 1 of 3', `${r.passes}/${r.passesNeeded}`, `1/${RELEARN_PASSES}`);
  r = await statusOn(2, false);
  eq('day 3: a slip keeps it', r.mastered, false);
  eq('  without wiping the passes', r.passes, 1);
  r = await statusOn(3, true);
  eq('day 4: second pass', r.passes, 2);
  r = await statusOn(4, true);
  eq('day 5: third pass drops it', r.mastered, true);
  eq('  and says it was learnt, not already known', r.knewIt, false);
}

console.log('== shortcuts for items you already know ==');
{
  const env = makeEnv();
  const { body: state } = await call(env, 'GET', '/api/daily');
  const easy = state.lists.word.find((c) => ['a1', 'a2'].includes(c.level));
  const hard = state.lists.word.filter((c) => ['b2', 'c1'].includes(c.level));
  geminiCalls = [];
  let r = await call(env, 'POST', '/api/daily/grade', { answers: [
    { id: easy.id, selfKnown: true },
    { id: hard[0].id, selfKnown: true },
  ] });
  const byId = new Map(r.body.results.map((x) => [x.id, x]));
  eq('an A1-A2 item marked as known is dropped', byId.get(easy.id).mastered, true);
  eq('  recorded as your own call', byId.get(easy.id).selfKnown, true);
  eq('  without asking the model', geminiCalls.length, 0);
  eq('a B2-C1 item cannot be dropped on your word', byId.get(hard[0].id).mastered, false);
  eq('  it counts as not answered', byId.get(hard[0].id).skipped, true);
  eq('the overview counts it apart', r.body.state.stats.word.selfMarked, 1);

  verdictFor = () => false;                 // the sentence would fail
  understoodFor = (id) => id === hard[1].id;
  r = await call(env, 'POST', '/api/daily/grade', { answers: [
    { id: hard[1].id, fastCheck: true, explanation: 'right meaning', sentence: 'ignored' },
    { id: hard[2].id, fastCheck: true, explanation: 'wrong meaning' },
  ] });
  const fast = new Map(r.body.results.map((x) => [x.id, x]));
  eq('a fast check with the right meaning drops it', fast.get(hard[1].id).mastered, true);
  eq('  the sentence is neither sent nor kept', fast.get(hard[1].id).sentence, null);
  ok('  the examiner is told no sentence was asked', geminiCalls[0].includes('(not asked)'), '');
  eq('a fast check with the wrong meaning keeps it', fast.get(hard[2].id).mastered, false);
  understoodFor = null;
  verdictFor = () => true;

  // Day 2: the item you got wrong is no longer "first sight".
  const user = { id: 1 };
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
  const again = await gradeDaily(env, user, [{ id: hard[2].id, fastCheck: true, explanation: 'x', sentence: 'y' }],
                                 { now: tomorrow });
  eq('after a miss, the fast check is not honoured', again[0].fastCheck, false);
}

console.log('== a failed marking writes nothing ==');
{
  const env = makeEnv();
  const { body: state } = await call(env, 'GET', '/api/daily');
  const a = state.lists.word[0];
  geminiHandler = async () => ({ ok: false, status: 503, text: async () => 'busy' });
  const r = await call(env, 'POST', '/api/daily/grade', { answers: [
    { id: a.id, explanation: 'x', sentence: 'A sentence.' }] });
  eq('the outage is reported', r.status, 503);
  geminiHandler = (prompt) => (prompt.includes('examiner') ? grades(prompt) : scenes(prompt));
  const after = await call(env, 'GET', '/api/daily');
  eq('  and the item can still be tested today',
     after.body.lists.word.find((w) => w.id === a.id).testedToday, false);
}

console.log('== replacements are capped per day ==');
{
  const env = makeEnv({ perLevel: 12 });
  verdictFor = () => true;
  let mastered = 0;
  for (let round = 0; round < 3; round++) {
    const { body } = await call(env, 'GET', '/api/daily');
    const fresh = body.lists.word.filter((w) => !w.testedToday);
    const r = await call(env, 'POST', '/api/daily/grade', { answers: fresh.map((w) => ({
      id: w.id, explanation: 'means x', sentence: 'ok' })) });
    mastered += r.body.results.filter((x) => x.mastered).length;
  }
  const { body } = await call(env, 'GET', '/api/daily');
  eq(`no refills after ${REPLACEMENTS_PER_LIST_PER_DAY} mastered today`, body.stats.word.masteredToday, mastered);
  ok('  so the set shrinks until tomorrow', body.lists.word.length < SET_SIZE, String(body.lists.word.length));
}

console.log('== a thin band borrows from the others ==');
{
  const env = makeEnv({ perLevel: 1 });
  const { body } = await call(env, 'GET', '/api/daily');
  eq('five levels of one entry each still fill five slots', body.lists.word.length, 5);
}

console.log('== the model quota ==');
{
  const env = makeEnv();
  env.DB._raw.prepare("INSERT INTO usage_counter (user_id, day, kind, count) VALUES (1, ?, 'gemini_daily', 40)")
    .run(new Date().toISOString().slice(0, 10));
  geminiCalls = [];
  const r = await call(env, 'GET', '/api/daily');
  eq('the set is still served', r.body.lists.word.length, SET_SIZE);
  const s = await call(env, 'POST', '/api/daily/scenes', {});
  eq('  situations are not asked for', geminiCalls.length, 0);
  ok('  and the reason is given', /limit/.test(s.body.error || ''), s.body.error);
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
