// Drives the Today screen in a real browser with the API stubbed: hidden items,
// the two steps, the draft surviving a reload, and the marking round trip.
import { launch } from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:8731';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x); } };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const B = await launch();
const fakeToken = (email, expSec) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ email, name: 'Thao', exp: expSec, sub: '1' })}.sig`;
};
const token = fakeToken('thaop@ghn.vn', Math.floor(Date.now() / 1000) + 7200);

const card = (id, list, term, extra = {}) => ({
  id, list, term, pos: list === 'word' ? 'verb' : null, level: 'b2',
  meaning: `the meaning of item ${id}`, vi: 'nghĩa', ipa: '/x/', examples: [`They ${term} it.`],
  url: `https://www.oxfordlearnersdictionaries.com/definition/english/${term}`,
  situation: `Your team asks about ${id}. Answer them.`, sample: `A sample with ${term}.`,
  context: { before: 'They ', target: term, after: ' it.' },
  testedToday: false, attempts: 0, addedOn: '2026-10-01', lastResult: null, ...extra,
});
const state = {
  day: '2026-10-01',
  lists: { word: [card(1, 'word', 'abolish')], phrase: [card(2, 'phrase', 'a bit', { level: 'a2' })] },
  stats: { word: { mastered: 3, masteredToday: 0, pool: 5975 }, phrase: { mastered: 1, masteredToday: 0, pool: 750 } },
};

await B.addInitScript(`
  sessionStorage.setItem('knowledge/idtoken', ${JSON.stringify(token)});
  window.__calls = [];
  const realFetch = window.fetch;
  window.fetch = async (url, init = {}) => {
    const href = String(url && url.url ? url.url : url);
    if (!href.includes('workers.dev')) return realFetch(url, init);
    const body = init.body ? JSON.parse(init.body) : null;
    window.__calls.push({ href, method: init.method || 'GET', body });
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
    const state = ${JSON.stringify(state)};
    if (localStorage.getItem('slow-scenes')) {
      const bare = (c) => ({ ...c, situation: null, sample: null });
      if (href.endsWith('/api/daily')) {
        return reply({ ...state, scenesPending: 2,
          lists: { word: state.lists.word.map(bare), phrase: state.lists.phrase.map(bare) } });
      }
      if (href.endsWith('/api/daily/scenes')) {
        await new Promise((r) => setTimeout(r, 2500));
        return reply({ cards: [...state.lists.word, ...state.lists.phrase], remaining: 0 });
      }
    }
    if (href.endsWith('/api/daily')) return reply({ ...state, scenesPending: 0 });
    if (href.endsWith('/api/daily/scenes')) return reply({ cards: [], remaining: 0 });
    if (href.endsWith('/api/daily/grade')) {
      if (window.__gradeFail) return reply({ error: 'the language model is busy right now' }, 503);
      const word = { ...state.lists.word[0], testedToday: true,
        lastResult: { explanation: 'to end', sentence: 'bad one',
                      judgement: { feedback: 'Wrong object.', corrected: 'Good one.' } } };
      return reply({
        results: [
          { id: 1, term: 'abolish', list: 'word', mastered: false, skipped: false, explanation: 'to end',
            judgement: { understood: true, feedback: 'Wrong object.', corrected: 'Good one.' } },
          { id: 2, term: 'a bit', list: 'phrase', mastered: false, skipped: true, judgement: null },
        ],
        state: { ...state, lists: { word: [word], phrase: [{ ...state.lists.phrase[0], testedToday: true }] } },
      });
    }
    return reply({ error: 'unexpected' }, 404);
  };
`);

const wait = (ms = 300) => B.evaluate(`await new Promise(r => setTimeout(r, ${ms}));`);
await B.goto(`${BASE}/#/today`);
await wait(700);

console.log('== the overview hides what is untested ==');
let s = await B.evaluate(`return {
  heading: document.querySelector('.section')?.textContent,
  tab: document.querySelector('.tabs a[aria-current]')?.dataset.tab,
  leaked: document.querySelector('#view').textContent.includes('abolish'),
  start: document.querySelector('#start')?.textContent,
};`);
eq('Today screen', s.heading, 'Today');
eq('its tab is current', s.tab, 'today');
eq('the term is not shown before the check', s.leaked, false);
ok('a start button counts the items', /2 items/.test(s.start || ''), s.start);

console.log('== step 1 then step 2 ==');
s = await B.evaluate(`
  document.querySelector('#start').click();
  await new Promise(r => setTimeout(r, 200));
  const before = { term: document.querySelector('.prompt-serif')?.textContent,
                   context: document.querySelector('.quiz mark')?.textContent,
                   meaningShown: document.querySelector('.quiz').textContent.includes('the meaning of item 1'),
                   fast: !!document.querySelector('#fast'), known: !!document.querySelector('#known') };
  document.querySelector('#next').click();
  await new Promise(r => setTimeout(r, 50));
  const stillHere = !!document.querySelector('#explanation');
  document.querySelector('#explanation').value = 'to end';
  document.querySelector('#next').click();
  await new Promise(r => setTimeout(r, 100));
  return { ...before, stillHere, use: document.querySelector('.prompt-serif')?.textContent,
           situation: [...document.querySelectorAll('.prompt')].map(p => p.textContent).join('|') };`);
eq('step 1 shows the item itself', s.term, 'abolish');
eq('  highlighted in Oxford\'s sentence', s.context, 'abolish');
eq('  without giving the meaning away', s.meaningShown, false);
eq('a B2 item offers the fast check', s.fast, true);
eq('  but not the one-tap drop', s.known, false);
eq('an empty explanation is not accepted', s.stillHere, true);
eq('step 2 keeps the term', s.use, 'abolish');
ok('  with the situation', s.situation.includes('Your team asks about 1'), s.situation);

console.log('== the draft survives a reload ==');
await B.evaluate(`document.querySelector('#sentence').value = 'bad one'; document.querySelector('#done').click();`);
await B.goto(`${BASE}/?reload=1#/today`);
await wait(700);
s = await B.evaluate(`
  document.querySelector('#start').click();
  await new Promise(r => setTimeout(r, 200));
  return { prompt: document.querySelector('.prompt')?.textContent, count: document.querySelector('.quizcount')?.textContent };`);
eq('it resumes at the second item', s.count, '2 / 2');

console.log('== back ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 60));
  q('#back').click(); await tick();
  const toPrevUse = { count: q('.quizcount').textContent, sentence: q('#sentence')?.value };
  q('#back').click(); await tick();
  const toPrevUnderstand = { explanation: q('#explanation')?.value, disabled: q('#back').disabled };
  q('#next').click(); await tick();
  q('#done').click(); await tick();
  const forwardAgain = q('.quizcount').textContent;
  q('#dunno').click(); await tick();
  const onSubmit = !!q('#mark');
  q('#back').click(); await tick();
  return { toPrevUse, toPrevUnderstand, forwardAgain, onSubmit,
           undone: { count: q('.quizcount')?.textContent, box: q('#explanation')?.value },
           easyOffers: { known: !!q('#known'), fast: !!q('#fast') } };`);
eq('back from step 1 goes to the previous item', s.toPrevUse.count, '1 / 2');
eq('  at its step 2, sentence kept', s.toPrevUse.sentence, 'bad one');
eq('back again reaches its step 1, explanation kept', s.toPrevUnderstand.explanation, 'to end');
eq('  where there is nothing further back', s.toPrevUnderstand.disabled, true);
eq('forward again keeps both answers', s.forwardAgain, '2 / 2');
eq('"I don\'t know it" reaches the marking screen', s.onSubmit, true);
eq('back from there returns to the last item', s.undone.count, '2 / 2');
eq('  with the accidental "I don\'t know it" undone', s.undone.box, '');
eq('an A2 item offers the one-tap drop', s.easyOffers.known, true);
eq('  instead of the fast check', s.easyOffers.fast, false);

console.log('== "I know this well" can be taken back ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 60));
  q('#known').click(); await tick();
  const toMark = q('.prompt-sub')?.textContent;
  q('#back').click(); await tick();
  return { toMark, back: q('.quizcount')?.textContent, offered: !!q('#known') };`);
ok('it needs no marking', /^1 to mark/.test(s.toMark || ''), s.toMark);
eq('Back undoes it', s.back, '2 / 2');
eq('  and offers it again', s.offered, true);

console.log('== "I don\'t know" and marking ==');
s = await B.evaluate(`
  document.querySelector('#dunno').click();
  await new Promise(r => setTimeout(r, 100));
  const head = document.querySelector('#mark') ? 'straight to marking' : 'stuck';
  window.__gradeFail = true;
  document.querySelector('#mark').click();
  await new Promise(r => setTimeout(r, 300));
  const failed = document.querySelector('.verdict.wrong')?.textContent || '';
  window.__gradeFail = false;
  document.querySelector('#mark').click();
  await new Promise(r => setTimeout(r, 300));
  const post = window.__calls.filter(c => c.href.endsWith('/grade')).pop();
  return { head, failed, answers: post?.body?.answers,
           results: document.querySelector('#view').textContent,
           details: document.querySelectorAll('details.result').length };`);
eq('"I don\'t know it" skips step 2', s.head, 'straight to marking');
ok('a failed marking keeps the answers', /answers are kept/.test(s.failed), s.failed);
eq('both answers were sent', s.answers?.length, 2);
ok('  the recalled one with its sentence',
   s.answers?.some((a) => a.id === 1 && a.explanation === 'to end' && a.sentence === 'bad one'), JSON.stringify(s.answers));
ok('  the skipped one marked as skipped', s.answers?.some((a) => a.id === 2 && a.skipped), JSON.stringify(s.answers));
ok('the results name what to fix', s.results.includes('Wrong object.'), '');
eq('each kept item has a learning card', s.details, 2);
ok('  and the check is done for today', s.results.includes('Done for today'), '');

console.log('== step 2 waits for a situation still being prepared ==');
await B.evaluate(`localStorage.clear(); localStorage.setItem('slow-scenes', '1');`);
await B.goto(`${BASE}/?again=1#/today`);
await wait(500);
s = await B.evaluate(`
  document.querySelector('#start').click();
  await new Promise(r => setTimeout(r, 100));
  document.querySelector('#explanation').value = 'to end';
  document.querySelector('#next').click();
  await new Promise(r => setTimeout(r, 50));
  const waiting = !!document.querySelector('[data-waiting]');
  await new Promise(r => setTimeout(r, 3000));
  return { waiting, after: [...document.querySelectorAll('.prompt')].map(p => p.textContent).join('|'),
           box: !!document.querySelector('#sentence') };`);
eq('it shows that the situation is coming', s.waiting, true);
ok('  then the situation itself, without a reload', s.after.includes('Your team asks about 1'), s.after);
eq('  ready for the sentence', s.box, true);
await B.evaluate(`localStorage.clear();`);

await B.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
