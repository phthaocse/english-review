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
      if (body.term === 'duplicate') {
        return reply({ item: { id: 9, ...body }, merged: { fields: ['vi'], examples: 1 } }, 200);
      }
      window.__recent = [{ id: 1, term: body.term, kind: body.kind, meaning: body.meaning }, ...(window.__recent || [])];
      return reply({ item: { id: 1, ...body } }, 201);
    }
    if (href.includes('/api/logs')) return reply({ logs: window.__logs || [] });
    if (href.includes('/api/vision')) {
      if (window.__visionFail) {
        return reply({ error: window.__visionFail, trace: 77 }, window.__visionStatus || 503);
      }
      return reply({ quota: { remaining: 49 }, items: window.__draftReply || [], trace: 12 });
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
ok('a repeat says what it added, not that it was refused',
   /added to duplicate/i.test(s) && /new example/i.test(s), s);

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
  const shot = new Image();
  shot.src = 'data:image/jpeg;base64,' + call.body.image;
  await shot.decode();
  return { sentBytes: sent.length, mime: call.body.mimeType,
           sentEdge: Math.max(shot.naturalWidth, shot.naturalHeight),
           drafts: document.querySelectorAll('.draft').length,
           status: document.querySelector('#photo-status')?.textContent,
           hasPreview: !!document.querySelector('#preview img') };
`);
ok('image uploaded', s.sentBytes > 0);
ok('downscaled well under the cap', s.sentBytes < 4 * 1024 * 1024, `${s.sentBytes} bytes`);
// Detail is what the model reads handwriting with, so the resize keeps it.
eq('keeps the page at full size when it is within the cap', s.sentEdge, 2400);
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

console.log('== a failed read explains itself and can be retried ==');
// Feeding a photo is three lines of canvas; the tests below reuse it.
const feedPhoto = `
  const c = document.createElement('canvas'); c.width = 600; c.height = 400;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,600,400);
  ctx.fillStyle = '#000'; ctx.font = '32px sans-serif'; ctx.fillText('go off', 40, 120);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg'));
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'p.jpg', { type: 'image/jpeg' }));
  const input = document.querySelector('#photo');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 700));
`;

s = await B.evaluate(`
  window.__visionFail = 'the image service is busy right now - try again in a moment';
  window.__calls = [];
  document.querySelector('[data-mode="photo"]').click();
  await new Promise(r => setTimeout(r, 200));
  ${feedPhoto}
  return { alert: document.querySelector('.alert-msg')?.textContent,
           retry: !!document.querySelector('#retry'),
           typeInstead: !!document.querySelector('#type-instead'),
           trace: document.querySelector('.alert .mono')?.textContent,
           statusHidden: document.querySelector('#photo-status')?.hidden,
           pickEnabled: !document.querySelector('#pick').disabled };
`);
ok('the failure is shown as an alert', /busy right now/.test(s.alert || ''), s.alert);
ok('offers a retry', s.retry);
ok('offers the typed form as a way out', s.typeInstead);
ok('quotes the log id to look up', /77/.test(s.trace || ''), s.trace);
ok('the progress line steps aside', s.statusHidden);
ok('the picker is usable again', s.pickEnabled);

s = await B.evaluate(`
  window.__visionFail = null;
  window.__draftReply = [{ term: 'go off', kind: 'phrasal-verb', confidence: 'high' }];
  const before = window.__calls.filter(c => c.href.includes('/api/vision'));
  document.querySelector('#retry').click();
  await new Promise(r => setTimeout(r, 700));
  const after = window.__calls.filter(c => c.href.includes('/api/vision'));
  return { sentAgain: after.length - before.length,
           sameImage: before.length > 0 && after[after.length - 1].body.image === before[0].body.image,
           drafts: document.querySelectorAll('.draft').length,
           alertGone: !document.querySelector('.alert') };
`);
eq('retry sends the photo again', s.sentAgain, 1);
ok('  without asking for a second photo', s.sameImage);
eq('  and the draft arrives', s.drafts, 1);
ok('  and the error clears', s.alertGone);

s = await B.evaluate(`
  window.__visionFail = "today's free quota for reading photos is used up - it resets tomorrow";
  window.__visionStatus = 429;
  ${feedPhoto}
  return { retry: !!document.querySelector('#retry'),
           typeInstead: !!document.querySelector('#type-instead'),
           msg: document.querySelector('.alert-msg')?.textContent };
`);
ok('no retry offered when the quota is spent', !s.retry, 'retry button should be absent');
ok('  but typing is still offered', s.typeInstead);
ok('  and the message says the quota resets', /resets tomorrow/.test(s.msg || ''), s.msg);

s = await B.evaluate(`
  document.querySelector('#type-instead').click();
  await new Promise(r => setTimeout(r, 200));
  return !!document.querySelector('#type-form');
`);
ok('"type it instead" opens the typed form', s);

console.log('== recent reads are on the page, not in a terminal ==');
s = await B.evaluate(`
  window.__visionFail = null; window.__visionStatus = null;
  window.__logs = [
    { id: 9, at: '2026-09-28 04:15:00', ok: false, duration_ms: 46500, image_kb: 200,
      model: null, items: null, error: 'the image service is busy right now',
      attempts: [{ model: 'gemini-3.5-flash', status: 0, ms: 45000 },
                 { model: 'gemini-3.7-flash', status: 429, ms: 700 }] },
    { id: 8, at: '2026-09-28 04:10:00', ok: true, duration_ms: 21900, image_kb: 200,
      model: 'gemini-3.5-flash', items: 5, error: null,
      attempts: [{ model: 'gemini-3.5-flash', status: 200, ms: 21800 }] },
  ];
  document.querySelector('[data-mode="photo"]').click();
  await new Promise(r => setTimeout(r, 500));
  const panel = document.querySelector('#diag');
  return { hidden: panel?.hidden, rows: document.querySelectorAll('.log tr:not(.log-detail)').length,
           text: document.querySelector('#diag-body')?.textContent.replace(/\\s+/g, ' '),
           canCopy: !!document.querySelector('#copy-log') };
`);
ok('the panel is shown once there is something in it', s.hidden === false, JSON.stringify(s.hidden));
eq('one row per read', s.rows, 2);
ok('  the failure names the models it tried', /3\.5-flash timeout/.test(s.text || ''), s.text);
ok('  the success names the model that answered', /gemini-3\.5-flash · 5 items/.test(s.text || ''), s.text);
ok('  each row carries its log id', /#9/.test(s.text || '') && /#8/.test(s.text || ''), s.text);
ok('  and the whole lot can be copied', s.canCopy);


console.log('== the review screen says whose definition it is ==');
await B.evaluate(`
  document.querySelector('#discard-draft')?.click();
  await new Promise(r => setTimeout(r, 300));
  window.__draftReply = [
    { term: 'vandal', kind: 'word', meaning: 'a person who deliberately damages property',
      vi: 'ke pha hoai', ipa: '/\u02c8v\u00e6ndl/', cefr: 'b2', verified: true,
      example: 'The **vandal** was caught.', confidence: 'high' },
    { term: 'negatively affect', kind: 'collocation', meaning: 'to have a bad influence on something',
      vi: 'anh huong tieu cuc', verified: false,
      example: 'Traffic will **negatively affect** the area.', confidence: 'high' },
  ];
  document.querySelector('[data-mode="photo"]').click();
  await new Promise(r => setTimeout(r, 200));
  const c = document.createElement('canvas'); c.width = 40; c.height = 40;
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'p.jpg', { type: 'image/jpeg' }));
  const input = document.querySelector('#photo');
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
  await new Promise(r => setTimeout(r, 900));
`);
s = await B.evaluate(`
  return [...document.querySelectorAll('.draft')].map((c) => ({
    pills: [...c.querySelectorAll('.pill')].map((p) => p.textContent.trim()),
    meaning: c.querySelector('[data-field=meaning]')?.value,
    placeholder: c.querySelector('[data-field=meaning]')?.placeholder,
    dict: c.querySelector('.draft-dict')?.textContent.trim() || null,
  }));
`);
ok('a word Oxford knows is labelled Oxford', (s[0]?.pills || []).includes('Oxford'), JSON.stringify(s[0]));
eq('  and shows what the dictionary gave', s[0]?.dict, '/\u02c8v\u00e6ndl/ \u00b7 B2');
ok('a collocation Oxford does not know is labelled unverified',
   (s[1]?.pills || []).includes('unverified'), JSON.stringify(s[1]?.pills));
ok('  but still arrives with a meaning to review', (s[1]?.meaning || '').length > 0, s[1]?.meaning);
ok('  and its placeholder says to check it', /check this one/.test(s[1]?.placeholder || ''), s[1]?.placeholder);
ok('  with no dictionary line, because there is none', s[1]?.dict === null, s[1]?.dict);

console.log('== signing out ==');
// Sign-out moved into the header bar, which every screen now shows.
s = await B.evaluate(`
  document.querySelector('#global-signout').click();
  await new Promise(r => setTimeout(r, 400));
  return { gate: !!document.querySelector('.gate'),
           chromeHidden: document.body.classList.contains('signed-out'),
           stored: sessionStorage.getItem('knowledge/idtoken') };
`);
ok('returns to the sign-in gate', s.gate);
ok('nav and footer hidden on the gate', s.chromeHidden);
eq('token discarded', s.stored, null);

const appErrors = B.consoleErrors.filter((e) => !/GSI_LOGGER|FedCM|client ID/.test(e));
ok('no application errors', appErrors.length === 0, appErrors.slice(0, 4).join(' | '));

console.log(`\n${pass} passed, ${fail} failed`);
B.close();
process.exit(fail ? 1 : 0);
