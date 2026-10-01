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
  recall: { kind: 'context', sentence: 'They ____ it.', answer: term, hint: term[0] + '·'.repeat(term.length - 1) },
  testedToday: false, attempts: 0, addedOn: '2026-10-01', lastResult: null, ...extra,
});
const state = {
  day: '2026-10-01',
  lists: { word: [card(1, 'word', 'abolish')], phrase: [card(2, 'phrase', 'a bit')] },
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
        lastResult: { recall: { verdict: 'exact' }, sentence: 'bad one',
                      judgement: { feedback: 'Wrong object.', corrected: 'Good one.' } } };
      return reply({
        results: [
          { id: 1, term: 'abolish', list: 'word', mastered: false, recall: { verdict: 'exact' },
            judgement: { feedback: 'Wrong object.', corrected: 'Good one.' } },
          { id: 2, term: 'a bit', list: 'phrase', mastered: false, recall: { verdict: 'skipped' }, judgement: null },
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
  const before = { prompt: document.querySelector('.prompt')?.textContent,
                   leaked: document.querySelector('.quiz').textContent.includes('abolish') };
  document.querySelector('#typed').value = 'abolish';
  document.querySelector('#check').click();
  await new Promise(r => setTimeout(r, 100));
  const verdict = document.querySelector('.verdict-head')?.textContent;
  document.querySelector('#next').click();
  await new Promise(r => setTimeout(r, 100));
  return { ...before, verdict, use: document.querySelector('.prompt-serif')?.textContent,
           situation: [...document.querySelectorAll('.prompt')].map(p => p.textContent).join('|') };`);
ok('recall shows the gapped sentence', /They\s*\?\s*it\./.test(s.prompt || ''), s.prompt);
eq('  without the answer', s.leaked, false);
eq('a right answer is marked right', s.verdict, 'Right');
eq('step 2 reveals the term', s.use, 'abolish');
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

console.log('== "I don\'t know" and marking ==');
s = await B.evaluate(`
  document.querySelector('#dunno').click();
  await new Promise(r => setTimeout(r, 100));
  const head = document.querySelector('.verdict-head')?.textContent;
  document.querySelector('#next').click();
  await new Promise(r => setTimeout(r, 100));
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
eq('skipping says so', s.head, 'New to you');
ok('a failed marking keeps the answers', /answers are kept/.test(s.failed), s.failed);
eq('both answers were sent', s.answers?.length, 2);
ok('  the recalled one with its sentence',
   s.answers?.some((a) => a.id === 1 && a.verdict === 'exact' && a.sentence === 'bad one'), JSON.stringify(s.answers));
ok('  the skipped one without', s.answers?.some((a) => a.id === 2 && a.verdict === 'skipped'), JSON.stringify(s.answers));
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
  document.querySelector('#typed').value = 'abolish';
  document.querySelector('#check').click();
  await new Promise(r => setTimeout(r, 50));
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
