import { parseProfile, pointsFrom, mergePhrasal, CHECKLIST_SIZE } from '../worker/src/profile.js';
import { shapeItem, applyVerdicts, buildBank, verifyPrompt, writePrompt, fillNext, bankStats } from '../worker/src/bank.js';
import worker from '../worker/src/index.js';
import { makeD1, addUser } from './d1.mjs';
import { makeSigner, claimsFor } from './jwt.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x); } };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// Oxford's markup, reduced to what the parser reads. Not Oxford's text.
const sense = (cefr, def, examples, head = '') =>
  `<li class="sense" sensenum="1" ${cefr ? `cefr="${cefr}"` : ''} id="x"><span class="sensetop"></span>${head}`
  + `<span class="def" htag="span">${def}</span><ul class="examples">`
  + examples.map(([cf, x]) => `<li class="">${cf ? `<span class="cf">${cf}</span> ` : ''}<span class="x">${x}</span></li>`).join('')
  + '</ul><div class="collapse"><span class="unbox" unbox="extra_examples"><ul class="examples">'
  + '<li><span class="unx">An extra example.</span></li></ul></span></div></li>';
const page = `<h1 class="headword">plan</h1><span class="pos">verb</span><span class="phon">/plæn/</span>
  <ol class="senses_multiple">
  ${sense('b1', 'to decide what to do', [
    [null, 'We <span class="cl">planned carefully</span> for weeks.'],
    ['plan to do something', 'They plan to move.'],
    ['plan on doing something', 'I plan on staying.'],
  ], '<span class="grammar">[intransitive]</span>')}
  ${sense('c1', 'to design something', [[null, 'She planned the garden.']], '<span class="labels">(formal)</span>')}
  ${sense(null, 'to arrange a rare thing', [])}
  </ol><div class="idioms"><span class="idm-g"><span class="idm">plan ahead</span>
  <ol><li class="sense"><span class="def">to think about the future</span></li></ol></span></div>`;

console.log('== the profile ==');
{
  const p = parseProfile(page);
  eq('headword', p.headword, 'plan');
  eq('part of speech', p.pos, 'verb');
  eq('idiom senses are not main senses', p.senses.length, 3);
  eq('  the idiom is kept apart', p.idioms[0]?.phrase, 'plan ahead');
  eq('sense level', p.senses[0].cefr, 'b1');
  eq('grammar label', p.senses[0].grammar, '[intransitive]');
  eq('style label', p.senses[1].labels, '(formal)');
  eq('patterns are read from their examples', p.senses[0].examples[1].pattern, 'plan to do something');
  eq('bold collocations are read', p.senses[0].examples[0].highlights[0], 'planned carefully');
  ok('extra examples are not the entry\'s own', !JSON.stringify(p).includes('An extra example'));
  eq('a page with no senses gives nothing', parseProfile('<html>nothing</html>'), null);
}

console.log('== the checklist ==');
{
  const keys = pointsFrom(parseProfile(page)).map((x) => x.key);
  eq('the core meaning comes first', keys[0], 'sense:1');
  eq('  then its patterns', keys.slice(1, 3).join(' | '), 'pattern:plan to do something | pattern:plan on doing something');
  eq('  then its collocations', keys[3], 'colloc:planned carefully');
  eq('  then other levelled meanings', keys[4], 'sense:2');
  ok('meanings with no level and idioms come last', keys.indexOf('sense:3') > keys.indexOf('sense:2')
     && keys.at(-1) === 'idiom:plan ahead', keys.join(' | '));
  ok('mastery counts the first eight', CHECKLIST_SIZE === 8);
}

console.log('== entries that live in idioms and phrasal verbs ==');
{
  // "sake", "about (adj)": no meanings of their own, only idioms.
  const idiomOnly = `<h1 class="headword">sake</h1><span class="pos">noun</span><div class="idioms">
    <span class="idm-g"><span class="idm" cefr="b2">for the sake of something</span>
    <ol><li class="sense" fkcefr="b2"><span class="def">in order to help</span><ul class="examples">
    <li><span class="x">They stayed together for the sake of the children.</span></li></ul></li></ol></span></div>`;
  const p = parseProfile(idiomOnly);
  ok('an entry made of idioms is not thrown away', p !== null);
  const pts = pointsFrom(p);
  eq('  its first idiom becomes the core point', pts[0].key, 'idiom:for the sake of something');
  eq('  with its level and an example', `${pts[0].cefr}|${pts[0].examples.length}`, 'b2|1');

  // "rely": only links to "rely on" / "rely upon".
  const linksOnly = `<h1 class="headword">rely</h1><span class="pos">verb</span><ul class="pvrefs">
    <li><a class="Ref" href="https://x/definition/english/rely-on#relyon2_e" title="rely on definition">rely on</a></li>
    <li><a class="Ref" href="https://x/definition/english/rely-upon#relyupon2_e" title="rely upon definition">rely upon</a></li></ul>`;
  const r = parseProfile(linksOnly);
  eq('phrasal-verb links are read', r.phrasalVerbs.map((v) => v.phrase).join(','), 'rely on,rely upon');
  eq('  without the anchor', r.phrasalVerbs[0].url, 'https://x/definition/english/rely-on');
  const merged = mergePhrasal(r, [
    { phrase: 'rely on', profile: parseProfile(page) },
    { phrase: 'rely upon', profile: parseProfile(page) },
  ]);
  eq('their meanings become the entry\'s', merged.senses.length, 3);
  eq('  "upon" duplicates are left out', new Set(merged.senses.map((x) => x.phrase)).size, 1);
  eq('an entry with meanings is left as it is', mergePhrasal(parseProfile(page), []).senses.length, 3);
}

console.log('== shaping what the writer returns ==');
{
  const terms = new Map([[7, 'plan']]);
  const mc = { word_id: 7, point_key: 'sense:1', type: 'meaning_mc', stem: 'We plan to go.', options: ['a', 'b', 'c'], answer_index: 2 };
  const shaped = shapeItem(mc, terms);
  eq('a good question is kept', shaped.answer.index, 2);
  ok('  its key is held apart from what is shown', !('answer_index' in shaped));
  eq('two options is not a question', shapeItem({ ...mc, options: ['a', 'b'] }, terms), null);
  eq('a key past the end is dropped', shapeItem({ ...mc, answer_index: 3 }, terms), null);
  eq('duplicate options are dropped', shapeItem({ ...mc, options: ['a', 'A', 'c'] }, terms), null);
  eq('an unknown word is dropped', shapeItem({ ...mc, word_id: 9 }, terms), null);

  const fix = { word_id: 7, point_key: 'colloc:x', type: 'fix_word', stem: 'We planned careful for weeks.',
                wrong_word: 'careful', accepted_fixes: ['carefully'] };
  eq('a fix-the-word question keeps its fixes', shapeItem(fix, terms).answer.fixes[0], 'carefully');
  eq('the wrong word must be in the sentence', shapeItem({ ...fix, wrong_word: 'badly' }, terms), null);
  eq('an open question needs a model answer', shapeItem({ word_id: 7, point_key: 'p', type: 'rewrite',
     stem: 's', instruction: 'i', model_answers: [] }, terms), null);
}

console.log('== the blind check ==');
{
  const items = [
    { type: 'meaning_mc', stem: 's', options: ['a', 'b', 'c'], answer: { index: 1 }, target: 'plan' },
    { type: 'meaning_mc', stem: 's', options: ['a', 'b', 'c'], answer: { index: 1 }, target: 'plan' },
    { type: 'pattern_mc', options: ['a', 'b', 'c'], answer: { index: 0 }, target: 'plan' },
    { type: 'fix_word', stem: 'x', answer: { wrong_word: 'to', fixes: ['for'] }, target: 'plan' },
  ];
  ok('the checker never sees a key', !/"answer"|"index"/.test(verifyPrompt(items)), verifyPrompt(items));
  const out = applyVerdicts(items, [
    { ref: 0, answer_index: 1, ambiguous: false, note: 'ok' },
    { ref: 1, answer_index: 2, ambiguous: false, note: 'c fits better' },
    { ref: 2, answer_index: 0, ambiguous: true, note: 'b also works' },
    { ref: 3, wrong_word: 'to', fixes: ['for', 'towards'], ambiguous: false, note: 'ok' },
  ]);
  eq('agreement verifies', out[0].status, 'verified');
  eq('disagreement rejects', out[1].status, 'rejected');
  eq('a second acceptable answer rejects', out[2].status, 'rejected');
  eq('a fix the checker agrees on verifies', out[3].status, 'verified');
  ok('  and a fix the writer missed is accepted too', out[3].answer.fixes.includes('towards'), JSON.stringify(out[3].answer));
  eq('no verdict leaves it unchecked, not rejected', applyVerdicts([items[0]], [])[0].status, 'draft');
  const wider = applyVerdicts([items[3]], [{ ref: 0, wrong_word: 'to convincing', fixes: ['to convince', 'for'],
                                             ambiguous: false, note: 'ok' }])[0];
  eq('a checker naming a wider span of the same mistake agrees', wider.status, 'verified');
}

console.log('== building a bank ==');
{
  const realFetch = globalThis.fetch;
  const calls = [];
  const reply = (obj) => ({ ok: true, json: async () => ({
    steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(obj) }] }] }) });
  globalThis.fetch = async (_url, init) => {
    const prompt = JSON.parse(init.body).input[0].text;
    calls.push(prompt);
    if (prompt.includes('You write vocabulary test questions')) {
      return reply({ items: [
        { word_id: 7, point_key: 'sense:1', type: 'meaning_mc', stem: 'We plan.', options: ['a', 'b', 'c'], answer_index: 0 },
        { word_id: 7, point_key: 'sense:1', type: 'sentence', stem: 'You are at work.', instruction: 'Answer using plan.', model_answers: ['I plan to.'] },
        { word_id: 7, point_key: 'sense:1', type: 'meaning_mc', stem: 'bad', options: ['a'], answer_index: 0 },
      ] });
    }
    return reply({ items: [{ ref: 0, answer_index: 0, ambiguous: false, note: 'ok' }] });
  };
  const words = [{ id: 7, term: 'plan', pos: 'verb', points: pointsFrom(parseProfile(page)) }];
  const bank = await buildBank(words, { GEMINI_API_KEY: 'k' });
  globalThis.fetch = realFetch;
  eq('two requests: write, then check', calls.length, 2);
  ok('the writer is told not to reuse Oxford examples', /never copy or lightly edit the Oxford examples/.test(calls[0]));
  ok('the writer gets only the first eight points', JSON.parse(calls[0].split('Words (JSON): ')[1])[0].points.length <= CHECKLIST_SIZE);
  eq('a malformed question is dropped', bank.dropped, 1);
  eq('the keyed question passed the check', bank.items.find((i) => i.type === 'meaning_mc').status, 'verified');
  eq('the open question waits for marking', bank.items.find((i) => i.type === 'sentence').status, 'verified');
  const tiny = [{ id: 8, term: 'glove', pos: 'noun', points: [{ key: 'sense:1', kind: 'sense', def: 'd', examples: [] }] }];
  eq('a one-point word asks for two versions of each question', JSON.parse(writePrompt(tiny).split('Words (JSON): ')[1])[0].points[0].write.length, 4);
  ok('writer prompt lists every type it may use', ['meaning_mc', 'pattern_mc', 'fix_word', 'rewrite', 'sentence']
     .every((t) => writePrompt(words).includes(t)));
}

console.log('== filling the bank in deal order ==');
{
  const DB = makeD1();
  addUser(DB, 'owner@x.com', { role: 'owner' });
  addUser(DB, 'member@x.com', { role: 'member' });
  const profile = parseProfile(page);
  for (const [id, term, position] of [[1, 'plan', 1], [2, 'later', 0]]) {
    DB._raw.prepare("INSERT INTO oxford_entry (id, list, term, pos, level, path) VALUES (?, 'word', ?, 'verb', 'b1', ?)")
      .run(id, term, `/definition/english/${term}`);
    DB._raw.prepare("INSERT INTO study_word (entry_id, collection, position) VALUES (?, 'core-1000', ?)").run(id, position);
    DB._raw.prepare('INSERT INTO word_profile (entry_id, profile, points, parser_version) VALUES (?, ?, ?, 1)')
      .run(id, JSON.stringify(profile), JSON.stringify(pointsFrom(profile)));
  }
  const signer = await makeSigner();
  const realFetch = globalThis.fetch;
  const reply = (obj) => ({ ok: true, json: async () => ({
    steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(obj) }] }] }) });
  let asked = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('googleapis.com/oauth2')) return signer.jwksFetch()();
    const prompt = JSON.parse(init.body).input[0].text;
    if (prompt.includes('You write vocabulary test questions')) {
      const id = JSON.parse(prompt.split('Words (JSON): ')[1])[0].word_id;
      asked.push(id);
      return reply({ items: [{ word_id: id, point_key: 'sense:1', type: 'meaning_mc', stem: 'S.', options: ['a', 'b', 'c'], answer_index: 1 }] });
    }
    return reply({ items: [{ ref: 0, answer_index: 1, ambiguous: false, note: 'ok' }] });
  };
  const env = { DB, GEMINI_API_KEY: 'k', GOOGLE_CLIENT_ID: 'cid', ALLOWED_ORIGINS: 'https://x' };

  const first = await fillNext(env, { limit: 1 });
  eq('the first word in deal order goes first', asked[0], 2);
  eq('  its questions are saved', first[0].verified, 1);
  const saved = DB._raw.prepare('SELECT body, answer, status FROM quiz_item WHERE entry_id = 2').get();
  ok('the key is stored apart from what is shown', !saved.body.includes('index') && JSON.parse(saved.answer).index === 1, JSON.stringify(saved));
  await fillNext(env, { limit: 5 });
  eq('a word that has questions is not built again', asked.join(','), '2,1');
  const stats = await bankStats(DB);
  eq('stats count words with questions', stats.with_questions, 2);
  eq('  and verified questions', stats.questions.verified, 2);

  const call = async (email, method, path) => {
    const res = await worker.fetch(new Request(`https://api.test${path}`, { method, headers: {
      Origin: 'https://x', Authorization: `Bearer ${await signer.sign(claimsFor(email, 'cid'))}` } }), env);
    return { status: res.status, body: await res.json() };
  };
  eq('a member cannot spend quota on filling', (await call('member@x.com', 'POST', '/api/bank/fill')).status, 403);
  eq('the owner can', (await call('owner@x.com', 'POST', '/api/bank/fill')).status, 200);
  eq('anyone signed in can read the stats', (await call('member@x.com', 'GET', '/api/bank')).body.words, 2);

  asked = [];
  DB._raw.exec('DELETE FROM quiz_item');
  await worker.scheduled({}, { ...env, NIGHTLY_FILL: '2' });
  eq('the nightly run fills the configured number', asked.length, 2);
  globalThis.fetch = async () => ({ ok: false, status: 429, text: async () => 'quota' });
  DB._raw.exec('DELETE FROM quiz_item');
  let threw = false;
  try { await worker.scheduled({}, env); } catch { threw = true; }
  eq('a refused night ends quietly', threw, false);
  globalThis.fetch = realFetch;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
