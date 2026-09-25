// The phone layout is the primary one, so it gets assertions rather than a
// glance at a screenshot.
import { launch } from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:8731';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x); } };

const B = await launch();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = `${b64({ alg: 'RS256' })}.${b64({
  email: 'thaop@ghn.vn', exp: Math.floor(Date.now() / 1000) + 7200, sub: '1' })}.sig`;
await B.addInitScript(`
  sessionStorage.setItem('knowledge/idtoken', ${JSON.stringify(token)});
  const real = window.fetch;
  window.fetch = async (u, i = {}) => String(u).includes('workers.dev')
    ? new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : real(u, i);
`);

await B.goto(`${BASE}/#/lookup`);
await B.setViewport(390, 844, { mobile: true });
await B.evaluate('await new Promise(r => setTimeout(r, 600));');

const m = await B.evaluate(`
  const rect = (s) => { const e = document.querySelector(s); if (!e) return null;
    const b = e.getBoundingClientRect();
    return { top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height) }; };
  const tabs = document.querySelector('.tabs');
  return {
    mobileCSS: matchMedia('(max-width: 700px)').matches,
    viewportHeight: innerHeight,
    header: rect('.topbar'),
    tabs: rect('.tabs'),
    tabPosition: getComputedStyle(tabs).position,
    tabHeight: Math.round(document.querySelector('.tabs a').getBoundingClientRect().height),
    searchFontSize: parseInt(getComputedStyle(document.querySelector('.search')).fontSize, 10),
    firstCardTop: rect('.result')?.top,
    emailHiddenButPresent: (() => {
      const e = document.querySelector('#account-bar span.muted');
      return !!e && getComputedStyle(e).display === 'none';
    })(),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
  };
`);

ok('mobile stylesheet applies', m.mobileCSS);
ok('header fits one row', m.header.height <= 70, `${m.header.height}px`);
// backdrop-filter on an ancestor would anchor a fixed child to the header
// instead of the viewport, which is exactly how this broke once.
ok('tab bar is pinned to the bottom of the viewport',
   m.tabPosition === 'fixed' && Math.abs(m.tabs.bottom - m.viewportHeight) <= 1,
   JSON.stringify({ pos: m.tabPosition, bottom: m.tabs.bottom, vh: m.viewportHeight }));
ok('tab targets are thumb-sized', m.tabHeight >= 44, `${m.tabHeight}px`);
ok('inputs are 16px so iOS does not zoom on focus', m.searchFontSize >= 16, `${m.searchFontSize}px`);
ok('content starts within the first third of the screen', m.firstCardTop < 320, `${m.firstCardTop}px`);
ok('the address is hidden but still in the DOM', m.emailHiddenButPresent);
ok('no horizontal scrolling', !m.horizontalOverflow);

// The last card must not be trapped under the fixed bar.
const clear = await B.evaluate(`
  window.scrollTo(0, document.body.scrollHeight);
  await new Promise(r => setTimeout(r, 350));
  const cards = [...document.querySelectorAll('.result')];
  const last = cards[cards.length - 1].getBoundingClientRect();
  const bar = document.querySelector('.tabs').getBoundingClientRect();
  return { lastBottom: Math.round(last.bottom), barTop: Math.round(bar.top) };
`);
ok('the last card clears the tab bar', clear.lastBottom <= clear.barTop, JSON.stringify(clear));

// The gate has no tab bar, so it keeps its title.
await B.evaluate(`
  document.querySelector('#global-signout').click();
  await new Promise(r => setTimeout(r, 400));
`);
const gate = await B.evaluate(`
  const h = document.querySelector('.gate h2.section');
  return { hasGate: !!document.querySelector('.gate'),
           titleVisible: h ? getComputedStyle(h).display !== 'none' : false,
           tabsHidden: getComputedStyle(document.querySelector('.tabs')).display === 'none' };
`);
ok('gate shown after signing out', gate.hasGate);
ok('gate keeps its title', gate.titleVisible);
ok('gate hides the tab bar', gate.tabsHidden);

console.log(`\n${pass} passed, ${fail} failed`);
B.close();
process.exit(fail ? 1 : 0);
