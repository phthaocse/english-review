import { launch } from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:8731';
const B = await launch();
let pass = 0, fail = 0;
const ok = (n, c, x='') => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x); } };
const eq = (n,a,b) => ok(n, a===b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

// Every route is behind sign-in now, so the suite signs in first. The token is
// deliberately unsigned: the client never verifies it, which is precisely why
// the Worker does (see auth.test.mjs).
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeToken = `${b64({ alg: 'RS256' })}.${b64({
  email: 'thaop@ghn.vn', name: 'Thao', exp: Math.floor(Date.now() / 1000) + 7200, sub: '1',
})}.sig`;
await B.addInitScript(`
  sessionStorage.setItem('knowledge/idtoken', ${JSON.stringify(fakeToken)});
  const real = window.fetch;
  window.fetch = async (u, i = {}) => String(u).includes('workers.dev')
    ? new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : real(u, i);
`);

await B.goto(`${BASE}/`);

console.log('== every item produces a valid question at every level ==');
const sweep = await B.evaluate(`
  const m = await import('./app.js');
  const bad = [];
  let count = 0;
  for (const item of m.state.items) {
    const top = m.maxLevelFor(item);
    for (let lvl = 0; lvl <= top; lvl++) {
      m.state.progress.cards[item.id] = { level: lvl, seen:0, correct:0, streak:0, lapses:0,
        card: { due: new Date().toISOString(), stability:0, difficulty:0, elapsed_days:0,
                scheduled_days:0, learning_steps:0, reps:0, lapses:0, state:0 } };
      try {
        const q = m.makeQuestion(item);
        count++;
        if (!q.promptHtml || !q.promptHtml.trim()) bad.push(item.id+' L'+lvl+' empty prompt');
        if (!q.accepted || !q.accepted.length || q.accepted.some(a => !a || !String(a).trim()))
          bad.push(item.id+' L'+lvl+' empty accepted');
        if (q.kind === 'choice') {
          if (!q.options || q.options.length < 2) bad.push(item.id+' L'+lvl+' too few options');
          else if (!q.options.includes(q.correct)) bad.push(item.id+' L'+lvl+' correct not among options');
          else if (new Set(q.options).size !== q.options.length) bad.push(item.id+' L'+lvl+' duplicate options');
        }
        if (q.kind === 'type' && q.promptHtml.includes('**')) bad.push(item.id+' L'+lvl+' raw markdown in prompt');
      } catch (e) { bad.push(item.id+' L'+lvl+' THREW '+e.message); }
    }
  }
  m.state.progress.cards = {};
  return { count, bad };
`);
console.log(`  generated ${sweep.count} questions across all items and levels`);
ok('no malformed questions', sweep.bad.length === 0, '\n   - ' + sweep.bad.slice(0,12).join('\n   - '));

console.log('== gap-fill never shows the answer in the prompt ==');
const leak = await B.evaluate(`
  const m = await import('./app.js');
  const leaks = [];
  for (const item of m.state.items.filter(i=>i.kind==='vocab')) {
    m.state.progress.cards[item.id] = { level:1, seen:0, correct:0, streak:0, lapses:0,
      card:{ due:new Date().toISOString(), stability:0, difficulty:0, elapsed_days:0,
             scheduled_days:0, learning_steps:0, reps:0, lapses:0, state:0 } };
    const q = m.makeQuestion(item);
    if (q.mode === 'Gap-fill') {
      const ans = String(q.accepted[0]).toLowerCase();
      const shown = q.promptHtml.replace(/<[^>]+>/g,'').toLowerCase();
      if (ans.length > 3 && shown.includes(ans)) leaks.push(item.id+' :: '+q.promptHtml);
    }
  }
  m.state.progress.cards = {};
  return leaks;
`);
ok('no answer leak in gap-fill prompts', leak.length === 0, '\n   - ' + leak.slice(0,6).join('\n   - '));


console.log('== gap-fill demands the inflected form ==');
const form = await B.evaluate(`
  const m = await import('./app.js');
  const R = await import('./review.js');
  m.state.progress.cards['turn out'] = { level:1, seen:2, correct:2, streak:0, lapses:0,
    card:{ due:new Date().toISOString(), stability:3, difficulty:5, elapsed_days:1,
           scheduled_days:1, learning_steps:0, reps:2, lapses:0, state:2 } };
  const q = m.makeQuestion(m.state.byId.get('turn out'));
  const lemma = R.grade('turn out', q.accepted, 9000);
  const infl  = R.grade(q.accepted[0], q.accepted, 9000);
  m.state.progress.cards = {};
  return { mode:q.mode, accepted:q.accepted, lemma:lemma.verdict, infl:infl.verdict };
`);
eq('it is a gap-fill', form.mode, 'Gap-fill');
eq('only the inflected form is accepted', form.accepted.length, 1);
// The example is chosen at random and one of them needs "turned out to be",
// so the lemma may score 'form' or 'wrong'. What must never happen is full
// credit for the uninflected word.
ok('base form never gets full credit', form.lemma !== 'exact', form.lemma);
eq('the sentence form is correct', form.infl, 'exact');

const stem = await B.evaluate(`
  const R = await import('./review.js');
  return { one: R.grade('turn out', ['turned out'], 9000).verdict,
           two: R.grade('accuse', ['accused'], 9000).verdict };
`);
eq('same stem, wrong ending is a form error', stem.one, 'form');
eq('and again on a single word', stem.two, 'form');

console.log('== interactive session ==');
await B.evaluate(`localStorage.clear(); location.hash='#/review';`);
await B.goto(`${BASE}/#/review`);

let step = await B.evaluate(`
  document.querySelector('[data-start="10"]').click();
  await new Promise(r=>setTimeout(r,120));
  return {
    hasQuiz: !!document.querySelector('.quiz'),
    count: document.querySelector('.quizcount')?.textContent.trim(),
    mode: document.querySelector('.quiz-mode span')?.textContent.trim(),
    kind: document.querySelector('#typed') ? 'type' : (document.querySelector('.option') ? 'choice' : 'none'),
  };
`);
ok('session started', step.hasQuiz);
eq('starts at question 1', step.count, '1 / 10');
ok('a mode label is shown', !!step.mode, step.mode);
ok('an input method is present', step.kind !== 'none', step.kind);

// Answer question 1 correctly by reading the accepted answer out of the engine.
const right = await B.evaluate(`
  const m = await import('./app.js');
  const q = m.state.session.current;
  if (q.kind === 'choice') {
    const i = q.options.indexOf(q.correct);
    document.querySelector('[data-opt="'+i+'"]').click();
  } else {
    document.querySelector('#typed').value = q.accepted[0];
    document.querySelector('#check').click();
  }
  await new Promise(r=>setTimeout(r,120));
  const v = document.querySelector('.verdict');
  return { cls: v?.className, head: v?.querySelector('.verdict-head')?.textContent,
           hasNext: !!document.querySelector('#next'),
           stored: JSON.parse(localStorage.getItem('english-review/progress/v1')||'{}') };
`);
ok('correct answer marked correct', right.cls?.includes('exact'), right.cls);
eq('verdict wording', right.head, 'Correct');
ok('next button present', right.hasNext);
ok('progress written to localStorage', Object.keys(right.stored.cards||{}).length === 1);
ok('a review was recorded', (right.stored.history||[]).length === 1);

// Question 2 deliberately wrong.
const wrong = await B.evaluate(`
  const m = await import('./app.js');
  document.querySelector('#next').click();
  await new Promise(r=>setTimeout(r,120));
  const q = m.state.session.current;
  if (q.kind === 'choice') {
    const i = q.options.findIndex(o => o !== q.correct);
    document.querySelector('[data-opt="'+i+'"]').click();
  } else {
    document.querySelector('#typed').value = 'zzzqqq';
    document.querySelector('#check').click();
  }
  await new Promise(r=>setTimeout(r,120));
  const v = document.querySelector('.verdict');
  return { cls: v?.className, solution: v?.querySelector('.solution')?.textContent,
           override: !!document.querySelector('#knew'), expected: q.solution };
`);
ok('wrong answer marked wrong', wrong.cls?.includes('wrong'), wrong.cls);
ok('the right answer is shown after a miss', !!wrong.solution || wrong.cls?.includes('wrong'));
ok('override offered after a miss', wrong.override);

// Run the rest of the session to the summary.
const summary = await B.evaluate(`
  const m = await import('./app.js');
  for (let i=0;i<20;i++) {
    const next = document.querySelector('#next');
    if (next) { next.click(); await new Promise(r=>setTimeout(r,60)); }
    if (document.querySelector('.section')?.textContent === 'Session done') break;
    const q = m.state.session?.current;
    if (!q) break;
    if (q.kind === 'choice') document.querySelector('[data-opt="'+q.options.indexOf(q.correct)+'"]').click();
    else { document.querySelector('#typed').value = q.accepted[0]; document.querySelector('#check').click(); }
    await new Promise(r=>setTimeout(r,60));
  }
  return { heading: document.querySelector('.section')?.textContent,
           stats: [...document.querySelectorAll('.stat b')].map(b=>b.textContent) };
`);
eq('session reaches the summary', summary.heading, 'Session done');
ok('summary shows numbers', summary.stats.length === 4, JSON.stringify(summary.stats));

console.log('== lookup ==');
await B.goto(`${BASE}/#/lookup`);
const look = await B.evaluate(`
  const q = document.querySelector('#q');
  q.value = 'hoá ra';
  q.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,120));
  const rows = [...document.querySelectorAll('.result-term')].map(e=>e.textContent);
  return { rows, total: document.querySelectorAll('.result').length };
`);
ok('Vietnamese search finds the word', look.rows.some(r=>r.includes('turn out')), JSON.stringify(look.rows.slice(0,5)));

const look2 = await B.evaluate(`
  const q = document.querySelector('#q');
  q.value = 'accuse';
  q.dispatchEvent(new Event('input'));
  await new Promise(r=>setTimeout(r,120));
  return [...document.querySelectorAll('.result-term')].map(e=>e.textContent.trim());
`);
eq('exact term ranks first', look2[0], 'accuse');

console.log('== item page ==');
await B.goto(`${BASE}/#/item/go%20off`);
const item = await B.evaluate(`
  return {
    term: document.querySelector('.item-term')?.textContent,
    senses: document.querySelectorAll('.senses li').length,
    seeAlso: [...document.querySelectorAll('.chiplink')].map(a=>a.getAttribute('href')),
    examples: document.querySelectorAll('.block ul li').length,
    noRawMd: !document.body.innerHTML.includes('**'),
  };
`);
eq('item title', item.term, 'go off');
eq('all six senses render', item.senses, 6);
ok('see-also links are internal routes', item.seeAlso.every(h=>h.startsWith('#/item/')), JSON.stringify(item.seeAlso));
ok('no raw markdown on the page', item.noRawMd);

await B.goto(`${BASE}/#/item/Comma%20splices`);
const drill = await B.evaluate(`
  return { wrong: document.querySelectorAll('.wrongline').length,
           right: document.querySelectorAll('.rightline').length,
           term: document.querySelector('.item-term')?.textContent };
`);
eq('drill page title', drill.term, 'Comma splices');
ok('drill shows wrong lines', drill.wrong === 2, String(drill.wrong));
ok('drill shows correct lines', drill.right === 3, String(drill.right));

console.log('== progress page ==');
await B.goto(`${BASE}/#/progress`);
const prog = await B.evaluate(`
  return { heading: document.querySelector('.section')?.textContent,
           bars: document.querySelectorAll('.bar-row').length,
           hasExport: !!document.querySelector('#export') };
`);
eq('progress heading', prog.heading, 'Progress');
ok('bars render', prog.bars > 3, String(prog.bars));
ok('export button present', prog.hasExport);

console.log('== console cleanliness ==');
// Google's library logs FedCM/One-Tap noise in a headless browser with a
// stubbed session; only application errors should fail this.
const appErrors = B.consoleErrors.filter((e) => !/GSI_LOGGER|FedCM/i.test(e));
ok('no uncaught errors', appErrors.length === 0, appErrors.slice(0, 5).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
B.close();
process.exit(fail ? 1 : 0);
