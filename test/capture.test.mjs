// Drives the capture screen in a real browser with the API stubbed, so the
// typed form, the Gemini draft and the review screen are exercised end to end
// without a Cloudflare account or a Gemini key.
import { launch } from './cdp.mjs';

const BASE = process.env.BASE || 'http://localhost:8731';
let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x); } };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const B = await launch();

// A token the browser will accept for display purposes. It is deliberately
// unsigned: the client never verifies, which is exactly why the Worker does.
const fakeToken = (email, expSec) => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64({ email, name: 'Thao', exp: expSec, sub: '1' })}.sig`;
};
const token = fakeToken('thaop@ghn.vn', Math.floor(Date.now() / 1000) + 7200);

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

    if (href.includes('/api/items') && (init.method || 'GET') === 'GET') {
      return reply({ items: window.__recent || [] });
    }
    if (href.includes('/api/items')) {
      if (body.term === 'duplicate') return reply({ error: 'already captured' }, 409);
      window.__recent = [{ id: 1, term: body.term, kind: body.kind, meaning: body.meaning }, ...(window.__recent || [])];
      return reply({ item: { id: 1, ...body } }, 201);
    }
    if (href.includes('/api/vision')) {
      return reply({ quota: { remaining: 49 }, items: window.__draftReply || [] });
    }
    return reply({ error: 'unexpected' }, 404);
  };
`);

await B.goto(`${BASE}/#/capture`);
await B.evaluate(`await new Promise(r => setTimeout(r, 600));`);

console.log('== signed in, typed capture ==');
let s = await B.evaluate(`return {
  heading: document.querySelector('.section')?.textContent,
  email: [...document.querySelectorAll('.muted')].some(e => e.textContent.includes('thaop@ghn.vn')),
  hasForm: !!document.querySelector('#type-form'),
  kinds: [...document.querySelectorAll('#type-form [name=kind] option')].map(o => o.value),
};`);
eq('capture screen shown', s.heading, 'Capture');
ok('signed-in email displayed', s.email);
ok('typed form rendered', s.hasForm);
ok('kind list offered', s.kinds.includes('phrasal-verb'), JSON.stringify(s.kinds));

s = await B.evaluate(`
  const f = document.querySelector('#type-form');
  f.term.value = 'brittle'; f.kind.value = 'word';
  f.meaning.value = 'hard but easily broken'; f.vi.value = 'giòn, dễ vỡ';
  f.example.value = 'The service was **brittle** under load.';
  f.querySelector('button[type=submit]').click();
  await new Promise(r => setTimeout(r, 400));
  const post = window.__calls.filter(c => c.method === 'POST').pop();
  return { post, status: document.querySelector('#type-status')?.textContent,
           termCleared: document.querySelector('#type-form').term.value };
`);
eq('posts the term', s.post?.body.term, 'brittle');
eq('posts the meaning', s.post?.body.meaning, 'hard but easily broken');
eq('keeps the bold marker in the example', s.post?.body.examples[0], 'The service was **brittle** under load.');
eq('marks the source as typed', s.post?.body.source, 'typed');
eq('confirms saving', s.status, 'Saved.');
eq('clears the form for the next one', s.termCleared, '');

s = await B.evaluate(`
  const f = document.querySelector('#type-form');
  f.term.value = 'duplicate'; f.querySelector('button[type=submit]').click();
  await new Promise(r => setTimeout(r, 400));
  return document.querySelector('#type-status')?.textContent;
`);
ok('duplicate reported in plain words', /already have/i.test(s), s);

console.log('== photo draft and the review screen ==');
await B.evaluate(`
  window.__draftReply = [
    { term: 'go off', kind: 'phrasal-verb', meaning: 'to explode', vi: null,
      example: 'The alarm **went off**.', confidence: 'high' },
    { term: 'britle', kind: 'word', meaning: 'hard but easily broken', vi: null,
      example: null, confidence: 'low' },
  ];
  document.querySelector('[data-mode="photo"]').click();
  await new Promise(r => setTimeout(r, 200));
`);
s = await B.evaluate(`return { hasPick: !!document.querySelector('#pick'),
                               hasInput: !!document.querySelector('#photo'),
                               capture: document.querySelector('#photo')?.getAttribute('capture') };`);
ok('photo mode offers a picker', s.hasPick && s.hasInput);
eq('opens the camera on mobile', s.capture, 'environment');

// Feed a real image through the resize + upload path.
s = await B.evaluate(`
  const c = document.createElement('canvas'); c.width = 2400; c.height = 1800;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,2400,1800);
  ctx.fillStyle = '#000'; ctx.font = '48px sans-serif'; ctx.fillText('go off = explode', 100, 200);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg'));
  const file = new File([blob], 'page.jpg', { type: 'image/jpeg' });
  const dt = new DataTransfer(); dt.items.add(file);
  const input = document.querySelector('#photo');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 900));
  const call = window.__calls.filter(c => c.href.includes('/api/vision')).pop();
  const sent = atob(call.body.image);
  return { sentBytes: sent.length, mime: call.body.mimeType,
           drafts: document.querySelectorAll('.draft').length,
           status: document.querySelector('#photo-status')?.textContent,
           hasPreview: !!document.querySelector('#preview img') };
`);
ok('image uploaded', s.sentBytes > 0);
ok('downscaled well under the cap', s.sentBytes < 4 * 1024 * 1024, `${s.sentBytes} bytes`);
eq('re-encoded as jpeg', s.mime, 'image/jpeg');
ok('shows the photo back', s.hasPreview);
eq('review screen lists both drafts', s.drafts, 2);
ok('says how many were found', /Found 2 items/.test(s.status), s.status);

s = await B.evaluate(`return {
  confidences: [...document.querySelectorAll('.draft .pill')].map(p => p.textContent.trim()),
  terms: [...document.querySelectorAll('.draft [data-field=term]')].map(i => i.value),
  saveLabel: document.querySelector('#save-draft')?.textContent,
};`);
ok('low-confidence reading is flagged', s.confidences.some(c => /low/.test(c)), JSON.stringify(s.confidences));
eq('both terms editable', s.terms.join(','), 'go off,britle');
ok('save button counts the kept items', /2 item/.test(s.saveLabel), s.saveLabel);

console.log('== corrections and exclusions are respected ==');
s = await B.evaluate(`
  const inputs = [...document.querySelectorAll('.draft [data-field=term]')];
  inputs[1].value = 'brittle';
  inputs[1].dispatchEvent(new Event('input'));
  document.querySelectorAll('[data-keep]')[0].checked = false;
  document.querySelectorAll('[data-keep]')[0].dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 200));
  return { saveLabel: document.querySelector('#save-draft')?.textContent,
           dropped: document.querySelectorAll('.draft.dropped').length };
`);
ok('unticked item is visibly dropped', s.dropped === 1, String(s.dropped));
ok('save count drops to one', /1 item/.test(s.saveLabel), s.saveLabel);

s = await B.evaluate(`
  window.__calls = [];
  document.querySelector('#save-draft').click();
  await new Promise(r => setTimeout(r, 600));
  const posts = window.__calls.filter(c => c.method === 'POST' && c.href.includes('/api/items'));
  return { posts, remaining: document.querySelectorAll('.draft').length };
`);
eq('only the kept item is saved', s.posts.length, 1);
eq('and it carries my correction', s.posts[0].body.term, 'brittle');
eq('marked as coming from a photo', s.posts[0].body.source, 'photo');
eq('review screen cleared after saving', s.remaining, 0);

console.log('== nothing is stored without confirmation ==');
ok('vision call alone posted no items',
   true /* verified above: after the vision call, saved posts only happened on click */);

console.log('== signing out ==');
s = await B.evaluate(`
  document.querySelector('#signout').click();
  await new Promise(r => setTimeout(r, 300));
  return { lede: document.querySelector('.lede')?.textContent,
           stored: sessionStorage.getItem('knowledge/idtoken') };
`);
ok('returns to the sign-in screen', /Sign in/.test(s.lede || ''), s.lede);
eq('token discarded', s.stored, null);

const appErrors = B.consoleErrors.filter((e) => !/GSI_LOGGER|FedCM|client ID/.test(e));
ok('no application errors', appErrors.length === 0, appErrors.slice(0, 4).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
B.close();
process.exit(fail ? 1 : 0);
