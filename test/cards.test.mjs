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
           count: document.querySelector('.deck-line p')?.textContent,
           tab: document.querySelector('.tabs [data-tab=cards]')?.getAttribute('aria-current'),
           meaning: document.body.innerText.includes(m.state.byId.get(
             document.querySelector('.flash-term').textContent)?.meaning || '\\u0000') };
`);
ok('a card is shown', !!s.term, s.term);
ok('its kind is labelled', /\w/.test(s.kind || ''), s.kind);
ok('the back is hidden', !s.back);
ok('it says what to do', /tap to show/i.test(s.hint || ''), s.hint);
ok('the position is shown', /· \d+ of \d+$/.test(s.count || ''), s.count);
eq('the tab is marked current', s.tab, 'page');
ok('the meaning is not on the page yet', !s.meaning);

console.log('== one tap shows the meaning ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  const term = document.querySelector('.flash-term').textContent;
  document.querySelector('#flashcard').click();
  await new Promise(r => setTimeout(r, 120));
  const item = m.state.byId.get(m.state.deck.ids[m.state.deck.index]);
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
  const countBefore = document.querySelector('.deck-line p').textContent.replace(/\s+/g, ' ').trim();
  document.querySelector('#deck-next').click();
  await new Promise(r => setTimeout(r, 120));
  const second = document.querySelector('.flash-term').textContent;
  const closedAgain = !document.querySelector('.flash-back');
  const count = document.querySelector('.deck-line p').textContent.replace(/\s+/g, ' ').trim();
  document.querySelector('#deck-prev').click();
  await new Promise(r => setTimeout(r, 120));
  return { first, second, closedAgain, count, countBefore,
           backToFirst: document.querySelector('.flash-term').textContent === first,
           stillHidden: !document.querySelector('.flash-back') };
`);
ok('next shows a different card', s.first !== s.second, `${s.first} → ${s.second}`);
ok('the new card starts face down', s.closedAgain);
ok('the counter moves', s.count !== s.countBefore, `${s.countBefore} -> ${s.count}`);
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

console.log('== the picker narrows the deck ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  document.querySelector('#deck-switch').click();
  await new Promise(r => setTimeout(r, 100));
  const pick = document.querySelector('#deck-set');
  pick.value = 'pron';
  pick.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 150));
  const term = document.querySelector('.flash-term')?.textContent;
  return { type: m.state.byId.get(m.state.deck.ids[m.state.deck.index])?.type,
           rules: m.state.items.filter((i) => i.type === 'pronunciation-rule').length,
           count: document.querySelector('.deck-line p')?.textContent.replace(/\s+/g, ' ').trim() };
`);
eq('choosing pronunciation shows a pronunciation card', s.type, 'pronunciation-rule');
// Counted from the data: the vault grows, and a fixed number broke when a rule was added.
ok('and it is dealt from that set', new RegExp(`Pronunciation · \\d+ of ${s.rules}$`).test((s.count || '').trim()), s.count);

console.log('== the deck is the whole group, not a sample ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  localStorage.removeItem('english-review/deck');
  m.state.deck = null; m.state.deckSet = 'all';
  location.hash = '#/cards'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 200));
  return { total: m.state.items.length, deck: m.state.deck.ids.length,
           unique: new Set(m.state.deck.ids).size,
           count: document.querySelector('.deck-line p')?.textContent.replace(/\\s+/g, ' ').trim(),
           sub: document.querySelector('.deck-sub')?.textContent.replace(/\\s+/g, ' ').trim(),
           bar: !!document.querySelector('.deck-bar') };
`);
eq('every item is in the deck', s.deck, s.total);
eq('  each one once', s.unique, s.total);
ok('  and one line says where you are', new RegExp(`· \\d+ of ${s.total}$`).test(s.count), s.count);
ok('  with a bar-free, single number', !/today|in this set/.test(s.count), s.count);
ok('  and no second counter competing with it', !s.bar, 'a progress meter is still there');

console.log('== arriving deals a card at random ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  const landed = [];
  for (let i = 0; i < 12; i++) {
    location.hash = '#/lookup'; window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 60));
    location.hash = '#/cards'; window.dispatchEvent(new HashChangeEvent('hashchange'));
    await new Promise(r => setTimeout(r, 80));
    landed.push(m.state.deck.index);
  }
  return { landed, distinct: new Set(landed).size, faceDown: !document.querySelector('.flash-back') };
`);
ok('twelve arrivals are not the same card', s.distinct > 6, `only ${s.distinct} distinct: ${s.landed}`);
ok('  and each one starts face down', s.faceDown);

console.log('== walking on from there still follows the order ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  const start = m.state.deck.index;
  const order = m.state.deck.ids;
  document.querySelector('#flashcard').click();
  await new Promise(r => setTimeout(r, 60));
  document.querySelector('#deck-next').click();
  await new Promise(r => setTimeout(r, 120));
  return { moved: m.state.deck.index === start + 1,
           term: document.querySelector('.flash-term').textContent,
           expected: m.state.byId.get(order[start + 1])?.term };
`);
ok('next is the next card in the shuffle, not another random one', s.moved);
eq('  and it is the one the order says', s.term, s.expected);

console.log('== each set keeps its own order ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  document.querySelector('#deck-switch').click();
  await new Promise(r => setTimeout(r, 100));
  const pick = document.querySelector('#deck-set');
  pick.value = 'pron'; pick.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 150));
  const pronOrder = m.state.deck.ids.join(',');

  document.querySelector('#deck-switch').click();
  await new Promise(r => setTimeout(r, 100));
  document.querySelector('#deck-set').value = 'all';
  document.querySelector('#deck-set').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 150));
  const allOrder = m.state.deck.ids.join(',');

  document.querySelector('#deck-switch').click();
  await new Promise(r => setTimeout(r, 100));
  document.querySelector('#deck-set').value = 'pron';
  document.querySelector('#deck-set').dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 150));

  const stored = JSON.parse(localStorage.getItem('english-review/deck'));
  return { sameOrder: m.state.deck.ids.join(',') === pronOrder,
           differentSets: pronOrder !== allOrder,
           groups: Object.keys(stored).sort() };
`);
ok('coming back to a set does not reshuffle it', s.sameOrder);
ok('  and the sets are genuinely different', s.differentSets);
ok('both are stored side by side', s.groups.includes('all') && s.groups.includes('pron'), s.groups.join(','));

console.log('== a deck built before new words still works ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  const ids = m.state.items.map(i => i.id);
  // Yesterday's deck: missing the two newest words, and parked on one of them.
  localStorage.setItem('english-review/deck', JSON.stringify({
    all: { ids: ids.slice(0, -2), index: 5 } }));
  const parked = ids[5];
  m.state.deck = null; m.state.deckSet = 'all';
  location.hash = '#/cards'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 200));
  return { size: m.state.deck.ids.length, total: ids.length, parked,
           showing: document.querySelector('.flash-term')?.textContent,
           known: m.state.deck.ids.every(id => !!m.state.byId.get(id)) };
`);
eq('the deck is rebuilt to include them', s.size, s.total);
ok('  every card in it still resolves', s.known);
ok('  and one of them is on screen', !!s.showing, s.showing);

console.log('== a session is a set you can pick ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  document.querySelector('#deck-switch').click();
  await new Promise(r => setTimeout(r, 100));
  const pick = document.querySelector('#deck-set');
  const options = [...pick.options].map(o => ({ value: o.value, label: o.textContent }));
  const session = options.find(o => o.value.startsWith('session:'));
  // Read the groups while the picker is open: choosing a set closes it.
  const groups = [...pick.querySelectorAll('optgroup')].map(g => g.label);
  pick.value = session.value;
  pick.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 200));
  const wanted = session.value.slice('session:'.length);
  return { session, groups,
           deck: m.state.deck.ids.length,
           allFromThatSession: m.state.deck.ids.every(id => m.state.byId.get(id).session === wanted),
           expected: m.state.items.filter(i => i.session === wanted).length,
           count: document.querySelector('.deck-line p').textContent.trim() };
`);
ok('sessions are offered as sets', !!s.session, JSON.stringify(s.groups));
ok('  grouped under a heading', s.groups.includes('Sessions') && s.groups.includes('Kind'),
   `saw: ${s.groups.join(',') || 'none'}`);
ok('  and dated in plain words', /\d+ \w+ · /.test(s.session.label), s.session.label);
ok('  with a count', /\(\d+\)$/.test(s.session.label.trim()), s.session.label);
eq('picking one deals only that session', s.deck, s.expected);
ok('  every card belongs to it', s.allFromThatSession);
ok('  and it opens somewhere inside it', new RegExp(`· \\d+ of ${s.expected}$`).test(s.count), s.count);

console.log('== the whole set can be listed and picked from ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  document.querySelector('#deck-list').click();
  await new Promise(r => setTimeout(r, 200));
  const rows = [...document.querySelectorAll('.card-row')];
  return { rows: rows.length, deck: m.state.deck.ids.length,
           card: !!document.querySelector('#flashcard'),
           first: rows[0]?.textContent.replace(/\\s+/g, ' ').trim(),
           firstTerm: m.state.byId.get(m.state.deck.ids[0])?.term,
           meanings: rows.some(r => {
             const item = m.state.byId.get(m.state.deck.ids[rows.indexOf(r)]);
             return item?.meaning && r.textContent.includes(item.meaning);
           }) };
`);
eq('every card in the set is listed', s.rows, s.deck);
ok('  the card screen steps aside', !s.card);
ok('  each row leads with the term', (s.first || '').startsWith(s.firstTerm), s.first);
ok('  and gives no meaning away - the point is to recall it', !s.meanings);

s = await B.evaluate(`
  const m = await import('./app.js');
  const rows = [...document.querySelectorAll('.card-row')];
  const wanted = m.state.byId.get(m.state.deck.ids[7]).term;
  rows[7].click();
  await new Promise(r => setTimeout(r, 200));
  return { term: document.querySelector('.flash-term')?.textContent, wanted,
           index: m.state.deck.index, list: !!document.querySelector('.card-row') };
`);
eq('tapping a row opens that card', s.term, s.wanted);
eq('  at its place in the set', s.index, 7);
ok('  and closes the list', !s.list);

console.log('== walking off the end offers the real thing ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  document.querySelector('#deck-list').click();
  await new Promise(r => setTimeout(r, 200));
  const rows = [...document.querySelectorAll('.card-row')];
  rows[rows.length - 1].click();                 // the last card in the set
  await new Promise(r => setTimeout(r, 150));
  document.querySelector('#flashcard').click();  // show it
  await new Promise(r => setTimeout(r, 80));
  document.querySelector('#deck-next').click();  // and step past it
  await new Promise(r => setTimeout(r, 200));
  return { text: document.body.innerText,
           again: !!document.querySelector('#deck-again'),
           practise: !!document.querySelector('a[href="#/review"]'),
           card: !!document.querySelector('#flashcard') };
`);
ok('stepping past the last card ends the set', !s.card);
ok('  it offers another pass', s.again);
ok('  and points at Practise for the graded version', s.practise);
ok('  saying plainly that seeing is not knowing', /not the same as being able to use it/i.test(s.text), '');

console.log('== the note remembers which card sent you ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  location.hash = '#/cards'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const from = { index: m.state.deck.index, id: m.state.deck.ids[m.state.deck.index] };
  document.querySelector('#deck-note').click();
  await new Promise(r => setTimeout(r, 80));
  const link = document.querySelector('.backlink');
  const note = { label: link?.textContent.trim(), href: link?.getAttribute('href'),
                 term: document.querySelector('.item-term')?.textContent };
  link.click();
  await new Promise(r => setTimeout(r, 120));
  return { from, note, landedOn: m.state.deck.index,
           sameCard: m.state.deck.ids[m.state.deck.index] === from.id,
           faceDown: !document.querySelector('.flash-back'),
           term: document.querySelector('.flash-term')?.textContent };
`);
eq('the note opened is the card you were on', s.note.term, s.term);
eq('  its back link points at the cards, not look up', s.note.href, '#/cards');
ok('  and says so', /back to the card/i.test(s.note.label || ''), s.note.label);
ok('going back lands on the same card, not a new random one', s.sameCard,
   `left ${s.from.index}, came back to ${s.landedOn}`);
ok('  and it is face down again, ready to be recalled', s.faceDown);

console.log('== a note reached any other way still goes back to look up ==');
s = await B.evaluate(`
  location.hash = '#/lookup'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const m = await import('./app.js');
  location.hash = '#/item/' + encodeURIComponent(m.state.items[0].id);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  const link = document.querySelector('.backlink');
  return { href: link?.getAttribute('href'), label: link?.textContent.trim() };
`);
eq('  it points back at look up', s.href, '#/lookup');
ok('  and says so', /back to look up/i.test(s.label || ''), s.label);

console.log('== the card carries the pronunciation, on the answer side ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  const withIpa = m.state.items.find((i) => i.ipa);
  m.state.deckSet = 'all';
  m.state.deck = { scope: 'all', ids: [withIpa.id], index: 0, shown: false, passes: 0 };
  location.hash = '#/cards'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  m.state.deck.index = 0; m.state.deck.shown = false;
  const front = { ipa: !!document.querySelector('.flash-ipa') };
  document.querySelector('#flashcard').click();
  await new Promise(r => setTimeout(r, 80));
  return { front, ipa: document.querySelector('.flash-ipa')?.textContent, expected: withIpa.ipa,
           order: [...document.querySelectorAll('.flash-back > *')].map((e) => e.className) };
`);
ok('the front does not give the pronunciation away', !s.front.ipa);
eq('  the back carries it', s.ipa, s.expected);
ok('  above the meaning, where you read it first', s.order[0] === 'flash-ipa', s.order.join(','));

console.log('== a word with a drawing shows it, on the answer side ==');
s = await B.evaluate(`
  const m = await import('./app.js');
  const drawn = Object.keys(m.state.drawings || {}).find((id) => m.state.byId.has(id));
  m.state.deckSet = 'all';
  m.state.deck = { scope: 'all', ids: [drawn], index: 0, shown: false, passes: 0 };
  location.hash = '#/cards'; window.dispatchEvent(new HashChangeEvent('hashchange'));
  await new Promise(r => setTimeout(r, 80));
  m.state.deck.index = 0; m.state.deck.shown = false;
  const hiddenUpFront = !document.querySelector('.flash-image');
  document.querySelector('#flashcard').click();
  await new Promise(r => setTimeout(r, 80));
  const img = document.querySelector('.flash-image');
  let loaded = false;
  if (img) { try { await img.decode(); loaded = img.naturalWidth > 0; } catch {} }
  return { drawn, hiddenUpFront, src: img?.getAttribute('src'), alt: img?.getAttribute('alt'), loaded,
           file: m.state.drawings[drawn].src,
           credit: document.querySelector('.credit')?.textContent?.trim() || null,
           count: Object.keys(m.state.drawings || {}).length };
`);
ok('the drawings index reached the page', s.count > 0, `${s.count} drawings`);
ok('the front does not show the picture', s.hiddenUpFront);
// A filename with spaces has to be encoded in the attribute, so compare encoded.
// The index names the file, because a word is illustrated by a drawing or a photograph.
eq('  the back shows the one the index names', s.src,
   'assets/words/' + encodeURIComponent(s.file));
ok('  the file actually loads', s.loaded, s.src);
ok('  and it carries a description, not the bare term', (s.alt || '').length > (s.drawn || '').length, s.alt);
// A licensed photograph may only be published with its credit shown.
ok('  a photograph shows its credit', !s.file.endsWith('.jpg') || /CC |Public Domain/.test(s.credit || ''),
   `${s.file} -> ${s.credit}`);

const appErrors = B.consoleErrors.filter((e) => !/GSI_LOGGER|FedCM|client ID/.test(e));
ok('no application errors', appErrors.length === 0, appErrors.slice(0, 3).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
B.close();
process.exit(fail ? 1 : 0);
