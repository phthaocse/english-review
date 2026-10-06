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

// A small stand-in for the Worker: three words, each walked through q1 → q2 → done.
await B.addInitScript(`
  sessionStorage.setItem('knowledge/idtoken', ${JSON.stringify(token)});
  window.__calls = [];
  const W = [
    { id: 1, term: 'convince', pos: 'verb', level: 'b2', ready: true, stage: 'q1',
      q1: { id: 11, type: 'meaning_mc', stem: 'She convinced me to stay.',
            options: ['make someone agree by giving reasons', 'shout at someone', 'pay someone'] },
      q2: { id: 12, type: 'sentence', stem: 'Your friend wants to quit her course.', instruction: 'Write one sentence with convince.' } },
    { id: 2, term: 'cheap', pos: 'adjective', level: 'a2', ready: true, stage: 'q1',
      q1: { id: 21, type: 'pattern_mc', options: ['It is cheap to buy.', 'It is cheap for buy.', 'It is cheap buying.'] },
      q2: { id: 22, type: 'fix_word', stem: 'The bus is cheap than the train.' } },
    { id: 3, term: 'aim', pos: 'verb', level: 'b1', ready: false, stage: 'q1',
      q1: { id: 31, type: 'meaning_mc', stem: 'We aim to finish by May.', options: ['plan', 'forget', 'refuse'] },
      q2: null },
  ];
  const S = { pending: 0, tested: new Set(), done: 0 };
  const card = (w) => ({ id: w.id, level: w.level, ready: w.ready, passes: 0, passesNeeded: 3,
    ...(S.tested.has(w.id) ? { term: w.term, pos: w.pos, ipa: '/x/', senses: [{ def: 'the meaning of ' + w.term, cefr: w.level, example: 'An example.' }],
      checklist: [{ key: 'sense:1', kind: 'sense', label: 'the meaning of ' + w.term, passed: false },
                  { key: 'pattern:p', kind: 'pattern', label: w.term + ' somebody to do something', passed: false }],
      today: w.feedback ? [{ verdict: 'wrong', answer: 'I convinced to her.', feedback: w.feedback, corrected: 'I convinced her.' }] : [] } : {}) });
  const overview = () => ({
    day: '2026-10-06', words: W.map(card), left: W.filter((w) => w.ready && w.stage !== 'done').length,
    waiting: W.filter((w) => !w.ready).length, pendingMarks: S.pending,
    totals: { active: 3, mastered: 4, known: 2, learnt: 1, self: 1, masteredToday: 0, of: 1000 },
    byLevel: { a1: 3, b2: 1 }, features: { meaning: { right: 3, n: 4 } },
    ielts: { state: 'due', everyDays: 3 },
  });
  const reveal = (w) => ({ correct: w.q1.options ? w.q1.options[0] : 'than', meaning: 'the meaning of ' + w.term,
                           oxford: ['Oxford says ' + w.term + '.'] });
  const realFetch = window.fetch;
  window.fetch = async (url, init = {}) => {
    const href = String(url && url.url ? url.url : url);
    if (!href.includes('workers.dev')) return realFetch(url, init);
    const body = init.body ? JSON.parse(init.body) : null;
    const path = new URL(href).pathname;
    window.__calls.push({ path, method: init.method || 'GET', body });
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
    const word = (id) => W.find((w) => w.id === Number(id));

    if (path === '/api/check') return reply(overview());
    if (path === '/api/check/prepare') {
      if (localStorage.getItem('slow-prepare')) await new Promise((r) => setTimeout(r, 3000));
      const w = W.find((x) => !x.ready);
      if (w) w.ready = true;
      return reply({ prepared: w ? { entry_id: w.id, verified: 4 } : null });
    }
    if (path === '/api/check/next') {
      const ready = W.filter((w) => w.ready);
      const w = ready.find((x) => x.stage !== 'done');
      const progress = { done: ready.filter((x) => x.stage === 'done').length, total: ready.length, waiting: W.length - ready.length };
      if (!w) return reply({ done: true, progress });
      const slot = w.stage === 'q1' ? 1 : 2;
      const item = slot === 1 ? w.q1 : w.q2;
      return reply({ word: { id: w.id, term: w.term, pos: w.pos, level: w.level }, slot,
        item: { stem: null, instruction: null, options: null, ...item },
        offers: { selfKnown: slot === 1 && w.level === 'a2' && !S.tested.has(w.id) }, progress });
    }
    if (path === '/api/check/answer') {
      const w = word(body.entry_id);
      const close = () => { w.stage = 'done'; S.tested.add(w.id); };
      if (body.selfKnown) { close(); return reply({ verdict: 'self', done: true, mastered: true, how: 'self', undoable: true }); }
      if (body.skipped) {
        const slot = w.stage === 'q1' ? 1 : 2;
        close();
        return reply({ verdict: 'skipped', done: true, passed: false, mastered: false, passes: 0, passesNeeded: 3,
                       ...reveal(w), undoable: slot === 1 });
      }
      if (body.choice != null) {
        if (body.choice === 0) {
          if (w.q2) { w.stage = 'q2'; return reply({ verdict: 'right', done: false }); }
          close(); return reply({ verdict: 'right', done: true, passed: true, mastered: true, how: 'known', passes: 1, passesNeeded: 3 });
        }
        close();
        return reply({ verdict: 'wrong', done: true, passed: false, mastered: false, passes: 0, passesNeeded: 3, ...reveal(w) });
      }
      close();
      S.pending++;
      return reply({ verdict: 'pending', done: true });
    }
    if (path === '/api/check/undo') { word(body.entry_id).stage = 'q1'; S.tested.delete(Number(body.entry_id)); return reply({ undone: true }); }
    if (path === '/api/check/report') {
      const w = W.find((x) => x.q1.id === body.item_id);
      w.q1 = { ...w.q1, id: w.q1.id + 100, stem: 'A better question.' };
      return reply({ reported: true });
    }
    if (path === '/api/check/mark') {
      if (window.__markFail) return reply({ error: 'the language model is busy right now' }, 503);
      S.pending = 0;
      word(1).feedback = 'You need "convince somebody", without "to".';
      return reply({ results: [{ entry_id: 1, term: 'convince', type: 'sentence', answer: 'I convinced to her.',
        verdict: 'wrong', feedback: word(1).feedback, corrected: 'I convinced her.', mastered: false }], ...overview() });
    }
    if (path === '/api/ielts/new') {
      return reply({ task: { id: 7, title: 'Cheaper buses', passage: 'The city made buses cheaper last year.',
        questions: [{ kind: 'mc', text: 'The city wanted to', options: ['save money', 'convince people to take buses', 'build roads', 'close schools'] },
                    { kind: 'tfng', text: 'Bus fares were raised.', options: ['TRUE', 'FALSE', 'NOT GIVEN'] }] } });
    }
    if (path === '/api/ielts/answer') {
      return reply({ score: 1, of: 2, results: [
        { given: body.answers[0], answer: 'B', right: body.answers[0] === 'B', explanation: 'The first line.' },
        { given: body.answers[1], answer: 'FALSE', right: body.answers[1] === 'FALSE', explanation: 'Fares went down.' }] });
    }
    return reply({ error: 'unexpected' }, 404);
  };
`);

const wait = (ms = 300) => B.evaluate(`await new Promise(r => setTimeout(r, ${ms}));`);
const calls = (path) => B.evaluate(`return window.__calls.filter(c => c.path === ${JSON.stringify(path)});`);
await B.goto(`${BASE}/#/today`);
await wait(800);

console.log('== the overview hides what is untested ==');
let s = await B.evaluate(`return {
  heading: document.querySelector('.section')?.textContent,
  tab: document.querySelector('.tabs a[aria-current]')?.dataset.tab,
  leaked: ['convince', 'cheap', 'aim'].some(t => document.querySelector('#view').textContent.includes(t)),
  hidden: [...document.querySelectorAll('.result-term')].filter(e => /Hidden/.test(e.textContent)).length,
  start: document.querySelector('#start')?.textContent,
  ielts: !!document.querySelector('#ielts-new'),
  progress: document.querySelector('#view').textContent.includes('Precise meaning'),
};`);
eq('Today screen', s.heading, 'Today');
eq('its tab is current', s.tab, 'today');
eq('no term is shown before the check', s.leaked, false);
eq('each word is listed as hidden', s.hidden, 3);
eq('the word without questions was prepared in the background', (await calls('/api/check/prepare')).length, 1);
ok('  and joins the count', /3 words/.test(s.start || ''), s.start);
eq('an IELTS task is offered when due', s.ielts, true);
eq('accuracy is shown by IELTS feature', s.progress, true);

console.log('== a right check goes straight to the second question ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 120));
  q('#start').click(); await tick();
  const first = { mode: q('.quiz-mode')?.textContent, stem: q('.prompt')?.textContent,
                  options: document.querySelectorAll('[data-choice]').length, known: !!q('#known'),
                  termShown: q('.quiz').textContent.includes('convince') && !q('.prompt').textContent.includes('convince') ? 'mode' : 'stem',
                  count: q('.quizcount')?.textContent };
  document.querySelector('[data-choice="0"]').click(); await tick();
  const second = { mode: q('.quiz-mode')?.textContent, box: !!q('textarea#typed'),
                   instruction: q('.prompt-sub')?.textContent };
  q('#submit').click(); await tick();
  const emptyKept = !!q('textarea#typed');
  q('#typed').value = 'I convinced to her.';
  q('#submit').click(); await tick();
  return { first, second, emptyKept, head: q('.verdict-head')?.textContent };`);
ok('the first question is a quick check', /Quick check/.test(s.first.mode), s.first.mode);
eq('  with its sentence', s.first.stem, 'She convinced me to stay.');
eq('  and three options', s.first.options, 3);
eq('  no one-tap drop for a B2 word', s.first.known, false);
eq('  counted as 1 of 3', s.first.count, '1 / 3');
ok('the second asks for production', /Now use it/.test(s.second.mode) && /convince/.test(s.second.mode), s.second.mode);
eq('  in a text box', s.second.box, true);
eq('  with its instruction', s.second.instruction, 'Write one sentence with convince.');
eq('an empty answer is not sent', s.emptyKept, true);
eq('a sentence is saved for marking at the end', s.head, 'Saved — marked at the end');
let sent = (await calls('/api/check/answer')).at(-1).body;
eq('  sent with the word', sent.entry_id, 1);
eq('  and the text', sent.text, 'I convinced to her.');
ok('  and the time taken', typeof sent.ms === 'number' && sent.ms >= 0, JSON.stringify(sent));

console.log('== "I know this well" and its undo ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 120));
  q('#next').click(); await tick();
  const offered = !!q('#known');
  const pattern = q('.prompt-sub')?.textContent;
  q('#known').click(); await tick();
  const head = q('.verdict-head')?.textContent;
  const body = q('.verdict-body')?.textContent;
  q('#undo').click(); await tick();
  return { offered, pattern, head, body, back: q('.quizcount')?.textContent, again: !!q('#known') };`);
eq('an A2 word on first sight offers the one-tap drop', s.offered, true);
eq('a pattern question asks for the correct sentence', s.pattern, 'Choose the correct sentence:');
eq('it is marked as known', s.head, 'Marked as known');
ok('  and dropped', /Dropped and replaced/.test(s.body), s.body);
eq('Undo returns to the same word', s.back, '2 / 3');
eq('  and offers the drop again', s.again, true);
eq('  after telling the Worker', (await calls('/api/check/undo')).at(-1)?.body?.entry_id, 2);

console.log('== "I don\'t know it" shows what to learn ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 120));
  q('#skip').click(); await tick();
  return { head: q('.verdict-head')?.textContent, solution: q('.solution')?.textContent,
           body: q('.verdict-body')?.textContent, undo: !!q('#undo') };`);
eq('it says the word is new', s.head, 'New to you');
eq('  with the right answer', s.solution, 'It is cheap to buy.');
ok('  Oxford\'s meaning and example', /the meaning of cheap/.test(s.body) && /Oxford says cheap/.test(s.body), s.body);
eq('  and can be undone', s.undo, true);

console.log('== reporting a question ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 120));
  q('#next').click(); await tick();
  const before = q('.prompt')?.textContent;
  window.prompt = () => 'two options fit';
  q('#report').click(); await tick();
  return { before, after: q('.prompt')?.textContent };`);
sent = (await calls('/api/check/report')).at(-1)?.body;
eq('the report names the question', sent?.item_id, 31);
eq('  with the note', sent?.note, 'two options fit');
eq('a new question replaces it', s.after, 'A better question.');

console.log('== a wrong check stops the word ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 120));
  document.querySelector('[data-choice="2"]').click(); await tick();
  return { head: q('.verdict-head')?.textContent, solution: q('.solution')?.textContent, undo: !!q('#undo') };`);
eq('it says not quite', s.head, 'Not quite');
eq('  and gives the answer', s.solution, 'plan');
eq('  with nothing to undo', s.undo, false);

console.log('== marking at the end ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 150));
  q('#next').click(); await tick();
  const screen = q('.prompt')?.textContent;
  window.__markFail = true;
  q('#go').click(); await tick();
  const failed = q('.verdict.wrong')?.textContent || '';
  window.__markFail = false;
  q('#go').click(); await tick();
  return { screen, failed, view: q('#view').textContent,
           cards: document.querySelectorAll('details.result').length };`);
eq('the last word leads to marking', s.screen, '1 answer to mark.');
ok('a failed marking keeps the answers', /answers are kept/.test(s.failed), s.failed);
ok('the results name what to fix', s.view.includes('without "to"') && s.view.includes('I convinced her.'), '');
ok('  and the check is done for today', s.view.includes('Done for today'), '');
eq('each tested word has a learning card', s.cards, 3);

console.log('== the IELTS task ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 150));
  q('#ielts-new').click(); await tick();
  const passage = q('.quiz').textContent.includes('made buses cheaper');
  const tfng = [...document.querySelectorAll('[data-q="1"]')].map(b => b.dataset.v).join(',');
  q('[data-q="0"][data-v="B"]').click();
  q('[data-q="1"][data-v="TRUE"]').click();
  const pressed = document.querySelectorAll('[aria-pressed="true"]').length;
  q('#submit').click(); await tick();
  return { passage, tfng, pressed, score: q('.quiz').textContent.includes('1 of 2'),
           right: q('[data-q="0"][data-v="B"]')?.dataset.state,
           wrong: q('[data-q="1"][data-v="TRUE"]')?.dataset.state,
           key: q('[data-q="1"][data-v="FALSE"]')?.dataset.state,
           why: q('.quiz').textContent.includes('Fares went down.') };`);
eq('the passage is shown', s.passage, true);
eq('TRUE/FALSE/NOT GIVEN has its three choices', s.tfng, 'TRUE,FALSE,NOT GIVEN');
eq('one choice per question is held', s.pressed, 2);
eq('the answers were sent by letter and label', JSON.stringify((await calls('/api/ielts/answer')).at(-1)?.body?.answers),
   JSON.stringify(['B', 'TRUE']));
eq('the score is shown', s.score, true);
eq('  a right choice is marked right', s.right, 'right');
eq('  a wrong one wrong', s.wrong, 'wrong');
eq('  with the key shown', s.key, 'right');
eq('  and why', s.why, true);

console.log('== words still waiting for questions ==');
await B.evaluate(`localStorage.setItem('slow-prepare', '1');`);
await B.goto(`${BASE}/?again=1#/today`);   // goto itself waits 1.5 s
s = await B.evaluate(`return document.querySelector('.verdict.typo')?.textContent || '';`);
ok('the page says a word is being written', /waiting for questions/.test(s) && /writing them now/.test(s), s);
await wait(2000);
s = await B.evaluate(`return { note: !!document.querySelector('.verdict.typo'), start: document.querySelector('#start')?.textContent };`);
eq('  the note goes once it is ready', s.note, false);
ok('  without a reload', /3 words/.test(s.start || ''), s.start);
await B.evaluate(`localStorage.clear();`);

await B.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
