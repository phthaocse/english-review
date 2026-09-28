// Drives the Cards screen: a term alone, then everything behind one tap.
import { launch } from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:8731';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x); } };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const B = await launch();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = `${b64({ alg: 'RS256' })}.${b64({
  email: 'thaop@ghn.vn', name: 'Thao', exp: Math.floor(Date.now() / 1000) + 7200, sub: '1',
})}.sig`;
await B.addInitScript(`
  sessionStorage.setItem('knowledge/idtoken', ${JSON.stringify(token)});
  const real = window.fetch;
  window.fetch = async (u, i = {}) => String(u).includes('workers.dev')
    ? new Response(JSON.stringify({ items: [], logs: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : real(u, i);
`);
await B.goto(`${BASE}/#/cards`);

console.log('== the front shows the word and nothing else ==');
let s = await B.evaluate(`
  const m = await import('./app.js');
  return { term: document.querySelector('.flash-term')?.textContent,
           kind: document.querySelector('.flash-kind')?.textContent,
           back: !!document.querySelector('.flash-back'),
           hint: document.querySelector('.flash-hint')?.textContent,
           count: document.querySelector('.deck-count')?.textContent,
           tab: document.querySelector('.tabs [data-tab=cards]')?.getAttribute('aria-current'),
           meaning: document.body.innerText.includes(m.state.byId.get(
             document.querySelector('.flash-term').textContent)?.meaning || '\\u0000') };
`);
ok('a card is shown', !!s.term, s.term);
ok('its kind is labelled', /\w/.test(s.kind || ''), s.kind);
ok('the back is hidden', !s.back);
ok('it says what to do', /tap to show/i.test(s.hint || ''), s.hint);
ok('the position is shown', /1 of \d+/.test(s.count || ''), s.count);
eq('the tab is marked current', s.tab, 'page');
ok('the meaning is not on the page yet', !s.meaning);

console.log('== one tap shows the meaning ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  const term = document.querySelector('.flash-term').textContent;
  document.querySelector('#flashcard').click();
  await new Promise(r => setTimeout(r, 120));
  const item = m.state.byId.get(term);
  return { sameTerm: document.querySelector('.flash-term')?.textContent === term,
           back: !!document.querySelector('.flash-back'),
           meaning: (document.querySelector('.flash-meaning')?.textContent || '').trim(),
           expected: (item.meaning || '').trim(),
           vi: (document.querySelector('.flash-vi')?.textContent || '').trim(),
           expectedVi: (item.vi || '').trim(),
           examples: document.querySelectorAll('.flash-examples li').length,
           hint: !!document.querySelector('.flash-hint'),
           next: document.querySelector('#deck-next')?.textContent };
`);
ok('the same card is still shown', s.sameTerm);
ok('the back is revealed', s.back);
ok('the meaning matches the note', !s.expected || s.meaning === s.expected, `${s.meaning} vs ${s.expected}`);
ok('the Vietnamese comes with it', !s.expectedVi || s.vi === s.expectedVi, `${s.vi} vs ${s.expectedVi}`);
ok('the hint is gone once open', !s.hint);
ok('the button now moves on', /next/i.test(s.next || ''), s.next);

console.log('== moving through the deck ==');
s = await B.evaluate(`
  const first = document.querySelector('.flash-term').textContent;
  document.querySelector('#deck-next').click();
  await new Promise(r => setTimeout(r, 120));
  const second = document.querySelector('.flash-term').textContent;
  const closedAgain = !document.querySelector('.flash-back');
  const count = document.querySelector('.deck-count').textContent;
  document.querySelector('#deck-prev').click();
  await new Promise(r => setTimeout(r, 120));
  return { first, second, closedAgain, count,
           backToFirst: document.querySelector('.flash-term').textContent === first,
           stillHidden: !document.querySelector('.flash-back') };
`);
ok('next shows a different card', s.first !== s.second, `${s.first} → ${s.second}`);
ok('the new card starts face down', s.closedAgain);
ok('the counter moves', /2 of/.test(s.count), s.count);
ok('back returns to the previous card', s.backToFirst);
ok('and it is face down again, not remembered as open', s.stillHidden);

console.log('== the keyboard drives it too ==');
s = await B.evaluate(`
  const term = document.querySelector('.flash-term').textContent;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  const opened = !!document.querySelector('.flash-back');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await new Promise(r => setTimeout(r, 120));
  return { opened, moved: document.querySelector('.flash-term').textContent !== term };
`);
ok('space flips the card', s.opened);
ok('the right arrow moves on', s.moved);

console.log('== a skim changes nothing ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  const before = JSON.stringify(m.state.progress);
  for (let i = 0; i < 4; i++) {
    document.querySelector('#flashcard').click();
    await new Promise(r => setTimeout(r, 60));
  }
  return { same: JSON.stringify(m.state.progress) === before,
           stored: localStorage.getItem('english-review/progress') };
`);
ok('flipping does not touch the schedule', s.same);

console.log('== the group chips narrow the deck ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  document.querySelector('[data-scope=pron]').click();
  await new Promise(r => setTimeout(r, 150));
  const term = document.querySelector('.flash-term')?.textContent;
  return { type: m.state.byId.get(term)?.type,
           count: document.querySelector('.deck-count')?.textContent };
`);
eq('choosing pronunciation shows a pronunciation card', s.type, 'pronunciation-rule');
ok('and the deck restarts', /^1 of/.test(s.count || ''), s.count);

console.log('== the deck is the whole group, not a sample ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  localStorage.removeItem('english-review/deck');
  m.state.deck = null; m.state.filter = 'all';
  location.hash = '#/cards'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 200));
  return { total: m.state.items.length, deck: m.state.deck.ids.length,
           unique: new Set(m.state.deck.ids).size,
           count: document.querySelector('.deck-count')?.textContent.replace(/\\s+/g, ' ').trim(),
           bar: !!document.querySelector('.deck-bar i') };
`);
eq('every item is in the deck', s.deck, s.total);
eq('  each one once', s.unique, s.total);
ok('  and the count says so', s.count.startsWith(`1 of ${s.total}`), s.count);
ok('  with a bar showing how far through you are', s.bar);

console.log('== it remembers where you stopped ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  for (let i = 0; i < 3; i++) {
    document.querySelector('#flashcard').click();   // show
    await new Promise(r => setTimeout(r, 60));
    document.querySelector('#deck-next').click();   // move on
    await new Promise(r => setTimeout(r, 60));
  }
  const term = document.querySelector('.flash-term').textContent;
  const stored = JSON.parse(localStorage.getItem('english-review/deck'));

  // Leave the section and come back, as if it were tomorrow morning.
  m.state.deck = null;
  location.hash = '#/lookup'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 150));
  location.hash = '#/cards'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 200));
  return { savedIndex: stored.all.index, term,
           resumedTerm: document.querySelector('.flash-term').textContent,
           count: document.querySelector('.deck-count').textContent.trim().split(' ')[0],
           faceDown: !document.querySelector('.flash-back') };
`);
eq('the place is written down', s.savedIndex, 3);
eq('  and picked up on return', s.resumedTerm, s.term);
eq('  at the same number', s.count, '4');
ok('  face down, ready to be recalled', s.faceDown);

console.log('== each group keeps its own place ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  document.querySelector('[data-scope=pron]').click();
  await new Promise(r => setTimeout(r, 150));
  document.querySelector('#flashcard').click();
  await new Promise(r => setTimeout(r, 60));
  document.querySelector('#deck-next').click();
  await new Promise(r => setTimeout(r, 120));
  const pronAt = m.state.deck.index;
  document.querySelector('[data-scope=all]').click();
  await new Promise(r => setTimeout(r, 150));
  const allAt = m.state.deck.index;
  const stored = JSON.parse(localStorage.getItem('english-review/deck'));
  return { pronAt, allAt, groups: Object.keys(stored).sort() };
`);
eq('pronunciation kept its own position', s.pronAt, 1);
eq('and everything kept the earlier one', s.allAt, 3);
ok('both are stored side by side', s.groups.includes('all') && s.groups.includes('pron'), s.groups.join(','));

console.log('== a deck built before new words still works ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  const ids = m.state.items.map(i => i.id);
  // Yesterday's deck: missing the two newest words, and parked on one of them.
  localStorage.setItem('english-review/deck', JSON.stringify({
    all: { ids: ids.slice(0, -2), index: 5 } }));
  const parked = ids[5];
  m.state.deck = null; m.state.filter = 'all';
  location.hash = '#/cards'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 200));
  return { size: m.state.deck.ids.length, total: ids.length,
           onParked: document.querySelector('.flash-term').textContent === m.state.byId.get(parked).term };
`);
eq('the deck is rebuilt to include them', s.size, s.total);
ok('  without losing the card you were on', s.onParked);

console.log('== the end of the deck offers the real thing ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  m.state.deck = { ...m.state.deck, index: m.state.deck.ids.length };   // past the last card
  location.hash = '#/cards';
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 200));
  return { text: document.body.innerText,
           again: !!document.querySelector('#deck-again'),
           practise: !!document.querySelector('a[href="#/review"]') };
`);
ok('it offers another deck', s.again);
ok('and points at Practise for the graded version', s.practise);
ok('saying plainly that seeing is not knowing', /not the same as being able to use it/i.test(s.text), '');

const appErrors = B.consoleErrors.filter((e) => !/GSI_LOGGER|FedCM|client ID/.test(e));
ok('no application errors', appErrors.length === 0, appErrors.slice(0, 3).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
B.close();
process.exit(fail ? 1 : 0);
