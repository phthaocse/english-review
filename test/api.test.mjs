import worker from '../worker/src/index.js';
import { parseItems, GeminiError } from '../worker/src/gemini.js';
import { makeSigner, claimsFor } from './jwt.mjs';
import { makeD1, addUser } from './d1.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x); } };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const CLIENT_ID = 'client-id.apps.googleusercontent.com';
const ORIGIN = 'https://phthaocse.github.io';
const signer = await makeSigner();

// The Worker calls the real Google JWKS URL; point fetch at our test keys.
const realFetch = globalThis.fetch;
let geminiHandler = async () => { throw new Error('gemini not stubbed'); };
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (href.includes('googleapis.com/oauth2')) return signer.jwksFetch()();
  if (href.includes('generativelanguage')) return geminiHandler(href, init);
  return realFetch(url, init);
};

function makeEnv(seed = (db) => addUser(db, 'thaop@ghn.vn', { role: 'owner' })) {
  const DB = makeD1();
  seed(DB);
  return { DB, GOOGLE_CLIENT_ID: CLIENT_ID, ALLOWED_ORIGINS: ORIGIN, GEMINI_API_KEY: 'test-key-do-not-log' };
}

async function call(env, method, path, { body, email = 'thaop@ghn.vn', token, origin = ORIGIN } = {}) {
  const headers = { Origin: origin };
  if (token !== null) headers.Authorization = `Bearer ${token ?? await signer.sign(claimsFor(email, CLIENT_ID))}`;
  const sendsBody = body !== undefined && method !== 'GET' && method !== 'HEAD';
  if (sendsBody) headers['Content-Type'] = 'application/json';
  const res = await worker.fetch(new Request(`https://api.test${path}`, {
    method, headers, body: sendsBody ? JSON.stringify(body) : undefined,
  }), env);
  let parsed = null;
  try { parsed = await res.clone().json(); } catch { /* not json */ }
  return { status: res.status, body: parsed, headers: res.headers };
}

console.log('== every route requires a valid identity ==');
{
  const env = makeEnv();
  for (const [method, path] of [['GET','/api/me'], ['GET','/api/items'], ['POST','/api/items'], ['POST','/api/vision']]) {
    const r = await call(env, method, path, { token: null, body: {} });
    eq(`${method} ${path} without a token → 401`, r.status, 401);
  }
  const r = await call(env, 'GET', '/api/me', { email: 'stranger@example.com' });
  eq('unlisted user → 403', r.status, 403);

  const other = await makeSigner();
  const r2 = await call(env, 'GET', '/api/me', { token: await other.sign(claimsFor('thaop@ghn.vn', CLIENT_ID)) });
  eq('token signed by a foreign key → 401', r2.status, 401);

  const r3 = await call(env, 'GET', '/api/me', { token: await signer.sign(claimsFor('thaop@ghn.vn', 'another-app')) });
  eq('token for another app → 401', r3.status, 401);
}

console.log('== /api/me ==');
{
  const env = makeEnv();
  const r = await call(env, 'GET', '/api/me');
  eq('200', r.status, 200);
  eq('reports the signed-in email', r.body.user.email, 'thaop@ghn.vn');
  eq('reports the role from the database', r.body.user.role, 'owner');
  eq('reports an empty library', r.body.stats.total, 0);
}

console.log('== capture ==');
{
  const env = makeEnv();
  let r = await call(env, 'POST', '/api/items', { body: {
    term: 'brittle', kind: 'word', meaning: 'hard but easily broken', vi: 'giòn, dễ vỡ',
    pattern: 'spend + on / + -ing (not for)',
    examples: ['The service was **brittle** under load.'], tags: ['theme/engineering'], source: 'typed',
  }});
  eq('created → 201', r.status, 201);
  eq('term stored', r.body.item.term, 'brittle');
  eq('status defaults to captured', r.body.item.status, 'captured');
  eq('example stored with its bold target', r.body.item.examples[0], 'The service was **brittle** under load.');
  eq('tag stored', r.body.item.tags[0], 'theme/engineering');
  eq('pattern stored', r.body.item.pattern, 'spend + on / + -ing (not for)');
  ok('attributed to the signed-in user', r.body.item.captured_by === 1, JSON.stringify(r.body.item.captured_by));

  r = await call(env, 'POST', '/api/items', { body: { term: 'brittle', kind: 'word' } });
  eq('duplicate → 409', r.status, 409);
  ok('duplicate returns the existing row', r.body.item?.term === 'brittle', JSON.stringify(r.body));

  r = await call(env, 'GET', '/api/items');
  eq('list returns it', r.body.items.length, 1);

  r = await call(env, 'GET', '/api/me');
  eq('stats count it', r.body.stats.total, 1);
  eq('and mark it as captured', r.body.stats.captured, 1);
}

console.log('== capture validation ==');
{
  const env = makeEnv();
  const bad = [
    ['missing term', { kind: 'word' }],
    ['blank term', { term: '   ', kind: 'word' }],
    ['unknown kind', { term: 'x', kind: 'sandwich' }],
    ['missing kind', { term: 'x' }],
    ['over-long term', { term: 'a'.repeat(300), kind: 'word' }],
  ];
  for (const [label, body] of bad) {
    const r = await call(env, 'POST', '/api/items', { body });
    eq(`${label} → 400`, r.status, 400);
  }
  const r = await call(env, 'POST', '/api/items', { body: { term: ' spaced ', kind: 'word' } });
  eq('term is trimmed', r.body.item.term, 'spaced');
}

console.log('== vision: the key never leaves the Worker ==');
{
  const env = makeEnv();
  let sentHeaders = null, sentBody = null;
  geminiHandler = async (_href, init) => {
    sentHeaders = init.headers; sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({ output_text: JSON.stringify({ items: [
      { term: 'go off', kind: 'phrasal-verb', meaning: 'to explode', vi: null,
        example: 'The alarm **went off**.', confidence: 'high' },
    ] }) }) };
  };

  const r = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA', mimeType: 'image/png' } });
  eq('200', r.status, 200);
  eq('draft returned', r.body.items[0].term, 'go off');
  eq('draft kind kept', r.body.items[0].kind, 'phrasal-verb');
  ok('quota reported', typeof r.body.quota.remaining === 'number');

  eq('key sent to Google in the header', sentHeaders['x-goog-api-key'], 'test-key-do-not-log');
  ok('key never appears in the client response', !JSON.stringify(r.body).includes('test-key-do-not-log'));
  eq('uses the verified Interactions shape', Array.isArray(sentBody.input), true);
  eq('  with the image part', sentBody.input[1].type, 'image');
  eq('  and a JSON response format', sentBody.response_format.mime_type, 'application/json');

  // Nothing was stored: the review screen decides that.
  const list = await call(env, 'GET', '/api/items');
  eq('vision stores nothing by itself', list.body.items.length, 0);
}

console.log('== vision failures stay quiet about internals ==');
{
  const env = makeEnv();
  geminiHandler = async () => ({ ok: false, status: 400, json: async () => ({
    error: { message: 'API key not valid: test-key-do-not-log' } }) });
  const r = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('upstream failure → 502', r.status, 502);
  ok('upstream message is not forwarded', !JSON.stringify(r.body).includes('test-key-do-not-log'), JSON.stringify(r.body));

  geminiHandler = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const r2 = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('upstream 429 is passed through as 429', r2.status, 429);

  geminiHandler = async () => { throw new Error('network down'); };
  const r3 = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('network failure → 502', r3.status, 502);

  geminiHandler = async () => ({ ok: true, json: async () => ({ output_text: 'not json at all' }) });
  const r4 = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('unparseable model output → 502', r4.status, 502);
}

console.log('== vision input limits ==');
{
  const env = makeEnv();
  geminiHandler = async () => ({ ok: true, json: async () => ({ output_text: '{"items":[]}' }) });
  let r = await call(env, 'POST', '/api/vision', { body: {} });
  eq('missing image → 400', r.status, 400);
  r = await call(env, 'POST', '/api/vision', { body: { image: 'A'.repeat(7 * 1024 * 1024) } });
  eq('oversized image → 413', r.status, 413);
  r = await call(env, 'POST', '/api/vision', { body: { image: 'data:image/png;base64,AAAA' } });
  eq('data: URL prefix accepted', r.status, 200);
}

console.log('== daily quota bounds a stolen token ==');
{
  const env = makeEnv();
  geminiHandler = async () => ({ ok: true, json: async () => ({ output_text: '{"items":[]}' }) });
  let last;
  for (let i = 0; i < 52; i++) last = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('blocked once over the daily limit', last.status, 429);
  const row = env.DB._raw.prepare('SELECT count FROM usage_counter').get();
  ok('usage counted', row.count >= 50, JSON.stringify(row));
}

console.log('== parseItems tolerates model sloppiness ==');
{
  const items = parseItems({ output_text: JSON.stringify({ items: [
    { term: '  spaced  ', kind: 'word', confidence: 'high' },
    { term: 'x', kind: 'not-a-kind', confidence: 'wat' },
    { term: '', kind: 'word' },
    { notterm: 1 },
    null,
  ] }) });
  eq('drops entries without a term', items.length, 2);
  eq('trims the term', items[0].term, 'spaced');
  eq('falls back to word for an unknown kind', items[1].kind, 'word');
  eq('falls back to low confidence', items[1].confidence, 'low');

  eq('reads the candidates shape too',
    parseItems({ candidates: [{ content: { parts: [{ text: '{"items":[{"term":"a","kind":"word","confidence":"high"}]}' }] } }] })[0].term, 'a');

  let threw = null;
  try { parseItems({ nothing: true }); } catch (e) { threw = e; }
  ok('an unrecognised payload throws GeminiError', threw instanceof GeminiError, String(threw));
}

console.log('== CORS ==');
{
  const env = makeEnv();
  const pre = await worker.fetch(new Request('https://api.test/api/items', {
    method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
  eq('preflight → 204', pre.status, 204);
  eq('echoes the allowed origin', pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  ok('allows the Authorization header', /Authorization/i.test(pre.headers.get('Access-Control-Allow-Headers')));

  const r = await call(env, 'GET', '/api/me', { origin: 'https://evil.example.com' });
  ok('unknown origin is not echoed back', r.headers.get('Access-Control-Allow-Origin') !== 'https://evil.example.com',
     r.headers.get('Access-Control-Allow-Origin'));
}

console.log('== unknown routes ==');
{
  const env = makeEnv();
  const r = await call(env, 'GET', '/api/nope');
  eq('404', r.status, 404);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
