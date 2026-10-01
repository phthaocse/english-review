import worker from '../worker/src/index.js';
import { chooseBand, coreOf, makeGap, hintFor, today, bandOf, SET_SIZE,
         REPLACEMENTS_PER_LIST_PER_DAY } from '../worker/src/daily.js';
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

console.log('== the gap ==');
{
  const g = makeGap('abolish', ['This tax should be abolished.']);
  eq('takes the form the sentence uses', g.answer, 'abolished');
  eq('  and blanks it', g.sentence, 'This tax should be ____.');
  eq('  hinting first letters only', g.hint, 'a········');

  const p = makeGap('a great deal', ['We don\'t see them a great deal these days.']);
  eq('a phrase is gapped whole', p.answer, 'a great deal');
  eq('placeholders are not part of what is typed', coreOf('a bit of sth').join(' '), 'a bit of');
  eq('  "do sth" is a slot too', coreOf('able to do sth').join(' '), 'able to');
  eq('no example containing it → no context gap', makeGap('abolish', ['Nothing here.']), null);
  eq('a short word does not match a longer one', makeGap('go', ['They gossip a lot.']), null);
  eq('hint for two words', hintFor('a bit'), 'a b··');
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
const grades = (prompt) => reply({ items: idsIn(prompt).map((id) => {
  const good = verdictFor(id);
  return { id, meaning_ok: good, grammar_ok: good, natural_ok: true,
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
  eq('the gap comes from Oxford\'s example', card.recall.sentence, 'I said ____ today.');
  eq('  and the answer is hidden behind it', card.recall.answer, card.term);
  ok('a situation is ready', /^Situation \d+/.test(card.situation), card.situation);
  eq('one request prepared all twenty', geminiCalls.length, 1);
  ok('the situation prompt forbids naming the word', /must NOT contain the\s+entry/.test(geminiCalls[0]));

  const again = await call(env, 'GET', '/api/daily');
  eq('coming back keeps the same set',
     again.body.lists.word.map((c) => c.id).join(), r.body.lists.word.map((c) => c.id).join());
  eq('  and spends no further request', geminiCalls.length, 1);
}

console.log('== marking ==');
{
  const env = makeEnv();
  const { body: state } = await call(env, 'GET', '/api/daily');
  const [a, b, c] = state.lists.word;
  verdictFor = (id) => id === a.id;
  geminiCalls = [];

  const r = await call(env, 'POST', '/api/daily/grade', { answers: [
    { id: a.id, verdict: 'exact', typed: a.recall.answer, sentence: `I used ${a.term} well.` },
    { id: b.id, verdict: 'exact', typed: b.recall.answer, sentence: `I used ${b.term} badly.` },
    { id: c.id, verdict: 'skipped', typed: '', sentence: '' },
  ] });
  eq('200', r.status, 200);
  const byId = new Map(r.body.results.map((x) => [x.id, x]));
  eq('recalled and used well → mastered', byId.get(a.id).mastered, true);
  eq('recalled but misused → kept', byId.get(b.id).mastered, false);
  eq('  with the examiner\'s feedback', byId.get(b.id).judgement.feedback, 'Wrong preposition.');
  eq('not recalled → kept, never sent to the examiner', byId.get(c.id).judgement, null);
  ok('only recalled answers were judged',
     idsIn(geminiCalls[0]).length === 2, JSON.stringify(idsIn(geminiCalls[0])));

  const words = r.body.state.lists.word;
  eq('the mastered word left the set', words.some((w) => w.id === a.id), false);
  eq('  and a new one took its place', words.length, SET_SIZE);
  eq('the kept ones are marked as done for today', words.find((w) => w.id === b.id).testedToday, true);

  const twice = await call(env, 'POST', '/api/daily/grade', { answers: [
    { id: b.id, verdict: 'exact', typed: 'x', sentence: 'again' }] });
  eq('a second try on the same day does not count', twice.body.results.length, 0);

  const stranger = await call(env, 'POST', '/api/daily/grade', { answers: [
    { id: 99999, verdict: 'exact', typed: 'x', sentence: 'y' }] });
  eq('an entry not in your set is ignored', stranger.body.results.length, 0);
}

console.log('== a failed marking writes nothing ==');
{
  const env = makeEnv();
  const { body: state } = await call(env, 'GET', '/api/daily');
  const a = state.lists.word[0];
  geminiHandler = async () => ({ ok: false, status: 503, text: async () => 'busy' });
  const r = await call(env, 'POST', '/api/daily/grade', { answers: [
    { id: a.id, verdict: 'exact', typed: 'x', sentence: 'A sentence.' }] });
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
      id: w.id, verdict: 'exact', typed: w.recall.answer, sentence: 'ok' })) });
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
  env.DB._raw.prepare("INSERT INTO usage_counter (user_id, day, kind, count) VALUES (1, ?, 'gemini_daily', 30)")
    .run(new Date().toISOString().slice(0, 10));
  geminiCalls = [];
  const r = await call(env, 'GET', '/api/daily');
  eq('the set is still served', r.body.lists.word.length, SET_SIZE);
  eq('  without asking the model', geminiCalls.length, 0);
  ok('  and says why there are no situations', /limit/.test(r.body.warning || ''), r.body.warning);
}

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
