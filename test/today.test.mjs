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

// A small stand-in for the Worker: three words, each walked through q1 → q2 → done,
// then a retest for each word that was missed.
await B.addInitScript(`
  sessionStorage.setItem('knowledge/idtoken', ${JSON.stringify(token)});
  window.__calls = [];
  const OXFORD = 'https://www.oxfordlearnersdictionaries.com/definition/english/';
  const W = [
    { id: 1, term: 'convince', pos: 'verb', level: 'b2', ready: true, stage: 'q1', lv: 0,
      q1: { id: 11, type: 'meaning_mc', stem: 'She convinced me to stay.',
            options: ['make someone agree by giving reasons', 'shout at someone', 'pay someone'] },
      q2: { id: 12, type: 'sentence', stem: 'Your friend wants to quit her course.', instruction: 'Write one sentence with convince.' },
      re: { id: 13, type: 'pattern_mc', options: ['She convinced him to stay.', 'She convinced him stay.', 'She convinced to him stay.'] } },
    { id: 2, term: 'cheap', pos: 'adjective', level: 'a2', ready: true, stage: 'q1', lv: 0,
      q1: { id: 21, type: 'pattern_mc', options: ['It is cheap to buy.', 'It is cheap for buy.', 'It is cheap buying.'] },
      q2: { id: 22, type: 'sentence', stem: 'A friend asks about bus fares.', instruction: 'Write one sentence with cheap.' },
      re: { id: 23, type: 'fix_word', stem: 'It is cheap for buy.', wrong: 'for' } },
    { id: 3, term: 'aim', pos: 'verb', level: 'b1', ready: false, stage: 'q1', lv: 0,
      q1: { id: 31, type: 'meaning_mc', stem: 'We aim to finish by May.', options: ['plan', 'forget', 'refuse'] },
      q2: null,
      re: { id: 33, type: 'meaning_mc', stem: 'They aim to win.', options: ['try', 'fear', 'stop'] } },
  ];
  const S = { pending: 0, tested: new Set() };
  window.__W = W;
  const retestable = (w) => w.stage === 'done' && w.missed && !w.retested;
  const card = (w) => ({ id: w.id, level: w.level, ready: w.ready, stage: w.lv, passes: 0, passesNeeded: 3,
    retest: retestable(w),
    ...(S.tested.has(w.id) ? { term: w.term, pos: w.pos, ipa: '/x/', url: OXFORD + w.term,
      senses: [{ def: 'the meaning of ' + w.term, cefr: w.level, example: 'An example.' }],
      checklist: [{ key: 'sense:1', kind: 'sense', label: 'the meaning of ' + w.term, state: w.missed ? 'missed' : 'right',
                    practised: !!w.practised },
                  { key: 'pattern:p', kind: 'pattern', label: w.term + ' somebody to do something', state: null }],
      today: w.feedback ? [{ verdict: 'wrong', answer: 'I convinced to her.', feedback: w.feedback, corrected: 'I convinced her.' }] : [] } : {}) });
  const overview = () => ({
    day: '2026-10-06', words: W.map(card), left: W.filter((w) => w.ready && w.stage !== 'done').length,
    waiting: W.filter((w) => !w.ready).length, pendingMarks: S.pending, retestLeft: W.filter(retestable).length,
    stages: { new: W.filter((w) => w.lv === 0).length, recognise: W.filter((w) => w.lv === 1).length, canUse: 0, secure: 4 },
    totals: { active: 3, mastered: 4, known: 2, learnt: 1, self: 1, masteredToday: 0, of: 1000 },
    byLevel: { a1: 3, b2: 1 }, features: { meaning: { right: 3, n: 4 } },
    ielts: { state: 'due', everyDays: 3 },
  });
  const reveal = (item, w) => ({ correct: item.options ? item.options[0] : 'to', meaning: 'the meaning of ' + w.term,
                                 oxford: ['Oxford says ' + w.term + '.'] });
  const asked = (w, item, slot, retest) => ({ word: { id: w.id, term: w.term, pos: w.pos, level: w.level, url: OXFORD + w.term },
    slot, retest, item: { stem: null, instruction: null, options: null, wrong: null, ...item },
    offers: { selfKnown: !retest && slot === 1 && w.level === 'a2' && !S.tested.has(w.id) } });
  const realFetch = window.fetch;
  window.fetch = async (url, init = {}) => {
    const href = String(url && url.url ? url.url : url);
    if (!href.includes('workers.dev')) return realFetch(url, init);
    const body = init.body ? JSON.parse(init.body) : null;
    const path = new URL(href).pathname;
    window.__calls.push({ path, method: init.method || 'GET', body, search: new URL(href).search });
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
      const only = word(new URL(href).searchParams.get('word'));
      if (only) {
        const progress = { done: 0, total: 1, waiting: 0 };
        if (only.stage === 'done') return reply({ ...asked(only, only.re, 1, true), progress });
        const slot = only.stage === 'q1' ? 1 : 2;
        return reply({ ...asked(only, slot === 1 ? only.q1 : only.q2, slot, false), progress });
      }
      const ready = W.filter((w) => w.ready);
      const w = ready.find((x) => x.stage !== 'done');
      if (w) {
        const progress = { done: ready.filter((x) => x.stage === 'done').length, total: ready.length, waiting: W.length - ready.length };
        const slot = w.stage === 'q1' ? 1 : 2;
        return reply({ ...asked(w, slot === 1 ? w.q1 : w.q2, slot, false), progress });
      }
      const missed = W.filter((x) => x.missed);
      const r = !S.pending && W.find(retestable);
      if (!r) return reply({ done: true, progress: { done: ready.length, total: ready.length, waiting: 0 } });
      return reply({ ...asked(r, r.re, 1, true), progress: { done: missed.filter((x) => x.retested).length, total: missed.length } });
    }
    if (path === '/api/check/answer') {
      const w = word(body.entry_id);
      if (w.stage === 'done') {
        const right = body.choice === 0 || body.text === 'to';
        Object.assign(w, { retested: true, practised: right });
        return reply({ verdict: body.skipped ? 'skipped' : right ? 'right' : 'wrong', retest: true, done: true, triesLeft: 0,
                       ...(right ? {} : reveal(w.re, w)) });
      }
      const close = (lv) => { w.stage = 'done'; S.tested.add(w.id); const before = w.lv; w.lv = lv; return { level: lv, levelBefore: before }; };
      if (body.selfKnown) return reply({ verdict: 'self', done: true, mastered: true, how: 'self', undoable: true, ...close(3) });
      if (body.skipped) {
        const slot = w.stage === 'q1' ? 1 : 2;
        w.missed = true;
        return reply({ verdict: 'skipped', done: true, passed: false, mastered: false, passes: 0, passesNeeded: 3,
                       ...reveal(w.q1, w), undoable: slot === 1, ...close(0) });
      }
      if (body.choice != null) {
        if (body.choice === 0) {
          if (w.q2) { w.stage = 'q2'; return reply({ verdict: 'right', done: false }); }
          return reply({ verdict: 'right', done: true, passed: true, mastered: true, how: 'known', passes: 1, passesNeeded: 3, ...close(3) });
        }
        w.missed = true;
        return reply({ verdict: 'wrong', done: true, passed: false, mastered: false, passes: 0, passesNeeded: 3,
                       ...reveal(w.q1, w), ...close(0) });
      }
      w.stage = 'done';
      S.tested.add(w.id);
      S.pending++;
      return reply({ verdict: 'pending', done: true });
    }
    if (path === '/api/check/undo') {
      const w = word(body.entry_id);
      Object.assign(w, { stage: 'q1', lv: 0, missed: false });
      S.tested.delete(w.id);
      return reply({ undone: true });
    }
    if (path === '/api/check/report') {
      const w = W.find((x) => x.q1.id === body.item_id);
      w.q1 = { ...w.q1, id: w.q1.id + 100, stem: 'A better question.' };
      return reply({ reported: true });
    }
    if (path === '/api/check/mark') {
      if (window.__markFail) return reply({ error: 'the language model is busy right now' }, 503);
      S.pending = 0;
      Object.assign(word(1), { feedback: 'You need "convince somebody", without "to".', missed: true, lv: 1 });
      return reply({ results: [{ entry_id: 1, term: 'convince', type: 'sentence', answer: 'I convinced to her.',
        verdict: 'wrong', feedback: word(1).feedback, corrected: 'I convinced her.', mastered: false, level: 1, levelBefore: 0 }],
        ...overview() });
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
  newPills: [...document.querySelectorAll('.result .pill')].filter(e => e.textContent === '○○○ New').length,
  start: document.querySelector('#start')?.textContent,
  summary: document.querySelector('.card.block .prompt')?.textContent,
  ielts: !!document.querySelector('#ielts-new'),
  levels: [...document.querySelectorAll('.card.block')].find(c => /Your level/.test(c.textContent))?.textContent || '',
  points: /points/.test(document.querySelector('#view').textContent),
  retestButtons: document.querySelectorAll('[data-retest]').length,
};`);
eq('Today screen', s.heading, 'Today');
eq('its tab is current', s.tab, 'today');
eq('no term is shown before the check', s.leaked, false);
eq('each word is listed as hidden', s.hidden, 3);
eq('  each at level New', s.newPills, 3);
eq('the word without questions was prepared in the background', (await calls('/api/check/prepare')).length, 1);
ok('  and joins the count', /3 words/.test(s.start || ''), s.start);
eq('one line says what is left', s.summary, '3 to check');
eq('an IELTS task is offered when due', s.ielts, true);
ok('the levels are counted', /Secure\s*4\s*of 1000/.test(s.levels) && /New\s*3/.test(s.levels), s.levels);
eq('no "points" jargon', s.points, false);
eq('a word not seen yet has no Retest button', s.retestButtons, 0);

console.log('== a right check goes straight to the second question ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 120));
  q('#start').click(); await tick();
  const first = { mode: q('.quiz-mode')?.textContent, stem: q('.prompt')?.textContent,
                  options: document.querySelectorAll('[data-choice]').length, known: !!q('#known'),
                  count: q('.quizcount')?.textContent };
  document.querySelector('[data-choice="0"]').click(); await tick();
  const second = { mode: q('.quiz-mode')?.textContent, box: !!q('textarea#typed'),
                   instruction: q('.prompt-sub')?.textContent };
  q('#submit').click(); await tick();
  const emptyKept = !!q('textarea#typed');
  q('#typed').value = 'I convinced to her.';
  q('#submit').click(); await tick();
  return { first, second, emptyKept, head: q('.verdict-head')?.textContent,
           oxford: q('.quiz-mode a')?.getAttribute('href') };`);
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
eq('the answer screen links to the Oxford entry', s.oxford, 'https://www.oxfordlearnersdictionaries.com/definition/english/convince');
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
ok('  leaves the list', /leaves your list/.test(s.body), s.body);
ok('  and shows the level going to Secure', /New\s*→\s*●●● Secure/.test(s.body), s.body);
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
ok('  and the level, unchanged', /New\s*\(no change\)/.test(s.body), s.body);
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

console.log('== marking, then retests ==');
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
  return { screen, failed, view: q('#view').textContent, summary: q('.card.block .prompt')?.textContent,
           retest: q('#retest')?.textContent, cards: document.querySelectorAll('details.result').length };`);
eq('the last word leads to marking', s.screen, '1 answer to mark.');
ok('a failed marking keeps the answers', /answers are kept/.test(s.failed), s.failed);
ok('the results name what to fix', s.view.includes('without "to"') && s.view.includes('I convinced her.'), '');
ok('  and the level it leaves the word at', /New\s*→\s*●○○ Recognise/.test(s.view), '');
eq('then the missed words are offered for a retest', s.summary, '3 to retest');
ok('  with a button', /Retest · 3 words/.test(s.retest || ''), s.retest);
eq('each tested word has a learning card', s.cards, 3);

s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 150));
  q('#retest').click(); await tick();
  const first = { mode: q('.quiz-mode')?.textContent, count: q('.quizcount')?.textContent, skip: q('#skip')?.textContent };
  document.querySelector('[data-choice="0"]').click(); await tick();
  const right = { head: q('.verdict-head')?.textContent, body: q('.verdict-body')?.textContent };
  q('#next').click(); await tick();
  const fix = { wrong: q('.wrongword')?.textContent, sub: q('.prompt-sub')?.textContent };
  q('#typed').value = 'of';
  q('#submit').click(); await tick();
  const missed = { head: q('.verdict-head')?.textContent, solution: q('.solution')?.textContent };
  q('#next').click(); await tick();
  q('#skip').click(); await tick();
  q('#next').click(); await tick();
  return { first, right, fix, missed, summary: q('.card.block .prompt')?.textContent,
           practised: q('#view').textContent.includes('practised today ✓'),
           level: [...document.querySelectorAll('details.result summary')].map(e => e.textContent).find(t => t.includes('convince')) || '',
           link: [...document.querySelectorAll('details.result a')].map(a => a.href)[0] };`);
ok('a retest says it is practice', /Retest · practice/.test(s.first.mode) && /convince/.test(s.first.mode), s.first.mode);
eq('  counted through the missed words', s.first.count, '1 / 3');
eq('  with "I can\'t" to give up', s.first.skip, 'I can\'t');
eq('a right retest is practice', s.right.head, 'Right — practised ✓');
ok('  and does not move the level', /level moves on tomorrow/.test(s.right.body), s.right.body);
eq('fix-the-word underlines the wrong word', s.fix.wrong, 'for');
eq('  and says so', s.fix.sub, 'The underlined word is wrong. Type the word that should replace it.');
eq('a missed retest says it comes back tomorrow', s.missed.head, 'Not yet — it comes back tomorrow');
eq('  with the answer', s.missed.solution, 'to');
eq('after the retests the day is done', s.summary, 'Done for today.');
eq('the practised point is shown on its card', s.practised, true);
ok('each word shows its level and next step', /●○○ Recognise/.test(s.level) && /Next: use it yourself/.test(s.level), s.level);
eq('a tested word links to its Oxford entry', s.link, 'https://www.oxfordlearnersdictionaries.com/definition/english/convince');

console.log('== every word you have seen has its own Retest ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 150));
  const nexts = () => window.__calls.filter(c => c.path === '/api/check/next');
  const buttons = [...document.querySelectorAll('details.result [data-retest]')].map(b => b.dataset.retest);
  const label = document.querySelector('[data-retest="2"]')?.textContent;
  document.querySelector('[data-retest="2"]').click(); await tick();
  const first = { mode: q('.quiz-mode')?.textContent, count: q('.quizcount')?.textContent, asked: nexts().at(-1)?.search };
  q('#typed').value = 'to';
  q('#submit').click(); await tick();
  const head = q('.verdict-head')?.textContent;
  const before = nexts().length;
  q('#next').click(); await tick();
  const back = { heading: q('.section')?.textContent, summary: q('.card.block .prompt')?.textContent,
                 asked: nexts().length - before };
  document.querySelector('[data-retest="2"]').click(); await tick();
  const again = q('.quiz-mode')?.textContent;
  q('#pause').click(); await tick();
  return { buttons, label, first, head, back, again };`);
eq('each word you have seen has a Retest button', s.buttons.join(), '1,2,3');
eq('  labelled Retest', s.label, 'Retest');
ok('it asks about that word only', /Retest · practice/.test(s.first.mode) && /cheap/.test(s.first.mode), s.first.mode);
eq('  by naming it to the Worker', s.first.asked, '?word=2');
eq('  as one question', s.first.count, '1 / 1');
eq('a right answer is practice', s.head, 'Right — practised ✓');
eq('Next goes back to your words', s.back.heading, 'Today');
eq('  without starting another word', s.back.asked, 0);
eq('  and the day stays done', s.back.summary, 'Done for today.');
ok('the button can be pressed again', /Retest · practice/.test(s.again || ''), s.again);

console.log('== a seen word that is due again runs its real check ==');
s = await B.evaluate(`
  const q = (sel) => document.querySelector(sel);
  const tick = () => new Promise(r => setTimeout(r, 150));
  window.__W[0].stage = 'q1';
  document.querySelector('[data-retest="1"]').click(); await tick();
  const first = q('.quiz-mode')?.textContent;
  document.querySelector('[data-choice="0"]').click(); await tick();
  const second = { mode: q('.quiz-mode')?.textContent,
                   asked: window.__calls.filter(c => c.path === '/api/check/next').at(-1)?.search };
  q('#typed').value = 'She convinced me to stay.';
  q('#submit').click(); await tick();
  const head = q('.verdict-head')?.textContent;
  q('#next').click(); await tick();
  return { first, second, head, heading: q('.section')?.textContent, mark: q('#mark')?.textContent };`);
ok('it starts with the quick check', /Quick check/.test(s.first || ''), s.first);
ok('  then asks to use the same word', /Now use it/.test(s.second.mode) && /convince/.test(s.second.mode), s.second.mode);
eq('  still for that word', s.second.asked, '?word=1');
eq('the sentence waits for marking', s.head, 'Saved — marked at the end');
eq('Next goes back to your words', s.heading, 'Today');
eq('  where the answer is ready to mark', s.mark, 'Mark 1 answer');

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
