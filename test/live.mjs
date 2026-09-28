// The whole photo path, for real: a browser drives the real front-end, which
// calls the real Worker code, which calls the real Gemini API with the real key.
// Only two things are stood in for - Google's signing keys (a headless browser
// cannot sign in) and D1 (node:sqlite). Everything else is what production runs.
//
//   node test/live.mjs            read the fixture page
//   node test/live.mjs photo.jpg  read a photo of your own
//
// It is deliberately NOT in run.sh: it needs the Gemini key and spends daily
// free-tier quota. Run it when the photo path itself is in question.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launch } from './cdp.mjs';
import { makeD1, addUser } from './d1.mjs';
import { makeSigner, claimsFor } from './jwt.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
const EMAIL = 'live-test@example.com';
const CLIENT_ID = 'live-test.apps.googleusercontent.com';
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const SITE_PORT = 8741;
const API_PORT = 8742;

function secret(name) {
  const file = `${process.env.HOME}/.config/knowledge/secrets.env`;
  if (!fs.existsSync(file)) throw new Error(`no ${file} - run ./save-secret.sh ${name}`);
  const line = fs.readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} not in ${file} - run ./save-secret.sh ${name}`);
  return line.slice(name.length + 1);
}

// Overridable so `GEMINI_API_KEY=nonsense node test/live.mjs` exercises the
// failure screen against real upstream errors, without spending any quota.
const KEY = process.env.GEMINI_API_KEY || secret('GEMINI_API_KEY');
const redact = (text) => String(text).split(KEY).join('<KEY>');

// --- stand in for Google, and only for Google ---------------------------------
const signer = await makeSigner();
const token = await signer.sign(claimsFor(EMAIL, CLIENT_ID));
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) =>
  (String(input?.url ?? input) === JWKS ? signer.jwksFetch()() : realFetch(input, init));

// --- the real Worker, over a throwaway database -------------------------------
const worker = (await import(`${ROOT}/worker/src/index.js`)).default;
const db = makeD1(`${ROOT}/worker/schema.sql`);
addUser(db, EMAIL, { name: 'Live Test' });
const env = {
  DB: db, GOOGLE_CLIENT_ID: CLIENT_ID, GEMINI_API_KEY: KEY,
  ALLOWED_ORIGINS: `http://localhost:${SITE_PORT}`,
  ...(process.env.GEMINI_MODEL ? { GEMINI_MODEL: process.env.GEMINI_MODEL } : {}),
};

const api = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const out = await worker.fetch(new Request(`http://localhost:${API_PORT}${req.url}`, {
    method: req.method, headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  }), env);
  const text = await out.text();
  if (req.url.startsWith('/api/vision')) console.log(`  ${req.method} ${req.url} -> ${out.status}`);
  if (out.status >= 400) console.log('  ', redact(text).slice(0, 300));
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(text);
});

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
               '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg',
               '.png': 'image/png', '.svg': 'image/svg+xml' };

const site = http.createServer((req, res) => {
  const name = req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0];
  // The deployed config points at the live Worker; this run points at ours.
  if (name === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(`export const CONFIG = { googleClientId: ${JSON.stringify(CLIENT_ID)}, `
      + `apiBase: 'http://localhost:${API_PORT}' };`);
  }
  if (name === '/note.jpg') {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    return res.end(fs.readFileSync(`${WORK}/note.jpg`));
  }
  const file = path.join(ROOT, name);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});

await new Promise((r) => api.listen(API_PORT, r));
await new Promise((r) => site.listen(SITE_PORT, r));

// --- the photo ----------------------------------------------------------------
const browser = await launch();
const given = process.argv[2];
if (given) {
  fs.copyFileSync(path.resolve(given), `${WORK}/note.jpg`);
  console.log(`photo: ${given}`);
} else {
  await browser.goto(`file://${ROOT}/test/fixtures/note.html`);
  await browser.screenshot(`${WORK}/note.png`, 1000, 1300, { fullPage: true });
  // A PNG is not what a camera produces; re-encode so the model sees a photo.
  const { execFileSync } = await import('node:child_process');
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85',
                        `${WORK}/note.png`, '--out', `${WORK}/note.jpg`], { stdio: 'ignore' });
  console.log('photo: test/fixtures/note.html, rendered');
}
console.log(`        ${Math.round(fs.statSync(`${WORK}/note.jpg`).size / 1024)}KB\n`);

// --- drive the page exactly as a thumb would ----------------------------------
await browser.addInitScript(`
  window.google = { accounts: { id: {
    initialize() {}, renderButton() {}, prompt(cb) { if (cb) cb(); }, disableAutoSelect() {},
  } } };
  try { sessionStorage.setItem('knowledge/idtoken', ${JSON.stringify(token)}); } catch {}
`);
await browser.goto(`http://localhost:${SITE_PORT}/#/capture`);
await browser.setViewport(390, 844, { mobile: true });

for (let i = 0; i < 20 && !(await browser.evaluate(
  `return !!document.querySelector('[data-mode="photo"]');`)); i++) {
  await new Promise((r) => setTimeout(r, 500));
}
await browser.evaluate(`
  const chip = document.querySelector('[data-mode="photo"]');
  if (!chip) throw new Error('not signed in - the capture screen never rendered');
  chip.click();
`);
await new Promise((r) => setTimeout(r, 300));

await browser.evaluate(`
  const input = document.querySelector('#photo');
  const blob = await (await fetch('/note.jpg')).blob();
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'note.jpg', { type: 'image/jpeg' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
`);

let status = '';
for (let i = 0; i < 200; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  status = await browser.evaluate(`return document.querySelector('#photo-status')?.textContent || ''`);
  const failed = await browser.evaluate(`return document.querySelector('.alert-msg')?.textContent || ''`);
  if (failed) { status = failed; break; }
  if (status && !/Preparing|Reading/.test(status)) break;
}

const drafts = await browser.evaluate(`
  return [...document.querySelectorAll('.draft')].map((d) => ({
    term: d.querySelector('[data-field=term]')?.value,
    kind: d.querySelector('[data-field=kind]')?.value,
    meaning: d.querySelector('[data-field=meaning]')?.value,
    vi: d.querySelector('[data-field=vi]')?.value,
    pattern: d.querySelector('[data-field=pattern]')?.value,
    example: d.querySelector('[data-field=example]')?.value,
  }));
`);

console.log(`\non screen: ${status}`);
for (const item of drafts) console.log('  •', JSON.stringify(item));

// The same rows the Recent reads panel shows, printed for the terminal.
console.log('\nlog:');
for (const row of (await fetch(`http://localhost:${API_PORT}/api/logs`, {
  headers: { Authorization: `Bearer ${token}` },
}).then((r) => r.json())).logs) {
  console.log(`  #${row.id} ${row.ok ? 'ok ' : 'FAIL'} ${(row.duration_ms / 1000).toFixed(1)}s`
    + ` ${row.image_kb}KB ${row.ok ? `${row.model} · ${row.items} items` : row.error}`);
  for (const a of row.attempts) {
    console.log(`      ${a.model} ${a.status || 'timeout'} ${(a.ms / 1000).toFixed(1)}s`
      + (a.detail ? `  ${a.detail}` : ''));
  }
}

// Folded-away detail is exactly what a debugging screenshot needs to show.
await browser.evaluate(`document.querySelectorAll('details').forEach((d) => { d.open = true; });`);
await browser.screenshot(`${WORK}/screen.png`, 390, 1200, { mobile: true });
console.log(`\nscreenshot: ${WORK}/screen.png`);
if (browser.consoleErrors.length) console.log('console errors:', browser.consoleErrors.slice(0, 5));

await browser.close();
api.close();
site.close();
process.exit(drafts.length ? 0 : 1);
