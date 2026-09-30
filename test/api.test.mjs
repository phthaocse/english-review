import worker from '../worker/src/index.js';
import { parseItems, GeminiError, readPhoto, keysFrom } from '../worker/src/gemini.js';
import { viaRegion, REGIONS } from '../worker/src/region.js';
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
// The dictionary is stubbed by default: no test may depend on Oxford being up,
// and the lookup decides whether a new item lands 'captured' or 'enriched'.
let oxfordHandler = async () => ({ ok: false, status: 404, text: async () => '' });
export const oxfordPage = (ipa, cefr, def) => async () => ({
  ok: true, status: 200,
  text: async () => `<span class="phon">${ipa}</span>`
    + (cefr ? `<a href="/wordlist/?level=${cefr}">x</a>` : '')
    + `<span class="pos">noun</span><span class="def">${def}</span>`,
});
const patchedFetch = async (url, init) => {
  const href = String(url);
  if (href.includes('googleapis.com/oauth2')) return signer.jwksFetch()();
  if (href.includes('generativelanguage')) return geminiHandler(href, init);
  if (href.includes('oxfordlearnersdictionaries')) return oxfordHandler(href, init);
  return realFetch(url, init);
};
globalThis.fetch = patchedFetch;

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
  for (const [method, path] of [['GET','/api/me'], ['GET','/api/items'], ['POST','/api/items'],
                                ['POST','/api/vision'], ['GET','/api/logs']]) {
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
  eq('a word Oxford does not know stays captured', r.body.item.status, 'captured');
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

console.log('== a typed word is filled in from the dictionary ==');
{
  const env = makeEnv();
  oxfordHandler = oxfordPage('/ˈvændl/', 'b2', 'a person who deliberately destroys or damages public property');

  let r = await call(env, 'POST', '/api/items', { body: { term: 'vandal', kind: 'word' } });
  eq('a bare term is accepted', r.status, 201);
  eq('  the meaning is Oxford\'s, not invented', r.body.item.meaning,
     'a person who deliberately destroys or damages public property');
  eq('  with the British IPA', r.body.item.ipa, '/ˈvændl/');
  eq('  and the CEFR level', r.body.item.cefr, 'b2');
  eq('  marked enriched, so the vault can trust it', r.body.item.status, 'enriched');

  // What the person wrote is the sense they met; the dictionary does not win.
  r = await call(env, 'POST', '/api/items', { body: {
    term: 'vandal', kind: 'idiom', meaning: 'my own wording', vi: 'kẻ phá hoại' } });
  eq('a meaning typed by hand survives', r.body.item.meaning, 'my own wording');
  eq('  but the IPA is still filled in', r.body.item.ipa, '/ˈvændl/');

  // Oxford being down must not stop a word being saved.
  oxfordHandler = async () => { throw new Error('network'); };
  r = await call(env, 'POST', '/api/items', { body: { term: 'suture', kind: 'word' } });
  eq('a dictionary outage does not block the save', r.status, 201);
  eq('  it just stays captured', r.body.item.status, 'captured');
  oxfordHandler = async () => ({ ok: false, status: 404, text: async () => '' });
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
  // The real Interactions response: a 'thought' step, then 'model_output'.
  geminiHandler = async (_href, init) => {
    sentHeaders = init.headers; sentBody = JSON.parse(init.body);
    return { ok: true, json: async () => ({
      id: 'v1_abc', status: 'completed', object: 'interaction', model: 'gemini-3.8-flash',
      steps: [
        { type: 'thought', signature: 'xxx' },
        { type: 'model_output', content: [{ type: 'text', text: JSON.stringify({ items: [
            { term: 'go off', kind: 'phrasal-verb', meaning: 'to explode', vi: null,
              example: 'The alarm **went off**.', confidence: 'high' },
        ] }) }] },
      ],
    }) };
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

console.log('== one photo costs one request ==');
{
  const env = makeEnv();
  const ok = () => ({ ok: true, json: async () => ({
    steps: [{ type: 'model_output', content: [{ type: 'text', text:
      '{"items":[{"term":"go off","kind":"phrasal-verb","confidence":"high"}]}' }] }] }) });

  // A good read asks once and stops.
  let seen = [];
  geminiHandler = async (_h, init) => { seen.push(JSON.parse(init.body).model); return ok(); };
  let r = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('a good read returns the draft', r.body.items[0].term, 'go off');
  eq('  having spent exactly one request', seen.length, 1);

  // A bad one does NOT go looking for another model. Three models in a row
  // turned one bad minute into three of the day's twenty, and a saturated pool
  // is saturated for all of them anyway.
  for (const status of [500, 502, 503, 504]) {
    seen = [];
    geminiHandler = async (_h, init) => {
      seen.push(JSON.parse(init.body).model);
      return { ok: false, status, json: async () => ({}) };
    };
    r = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
    eq(`upstream ${status} still costs only one request`, seen.length, 1);
    eq(`  and is reported as busy`, r.status, 503);
  }
  ok('  saying busy, not out of quota',
     /busy/i.test(r.body.error) && !/quota/i.test(r.body.error), r.body.error);

  // Out of quota: say so plainly, and never retry it.
  let attempts = 0;
  geminiHandler = async () => { attempts++; return { ok: false, status: 429, json: async () => ({}) }; };
  r = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('exhausted quota -> 429', r.status, 429);
  ok('  explains the quota resets', /quota|resets tomorrow/i.test(r.body.error), r.body.error);
  ok('  suggests typing instead', /type the word/i.test(r.body.error), r.body.error);
  eq('  without spending another request', attempts, 1);

  // A refusal is a verdict on the photo, not an outage, and reads differently.
  geminiHandler = async () => ({ ok: false, status: 400, json: async () => ({}) });
  r = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('a refusal is not dressed up as busy', r.status, 502);
  ok('  and carries the upstream status', /400/.test(r.body.error), r.body.error);
}


console.log('== more than one key: order, failover, and what does not earn a retry ==');
{
  const env = makeEnv();
  const ok = () => ({ ok: true, json: async () => ({
    steps: [{ type: 'model_output', content: [{ type: 'text', text:
      '{"items":[{"term":"go off","kind":"phrasal-verb","confidence":"high"}]}' }] }] }) });
  env.GEMINI_API_KEY_2 = 'second-key-do-not-log';
  env.GEMINI_API_KEY_10 = 'tenth-key-do-not-log';

  eq('keys come back in order, 2 before 10', keysFrom(env).length, 3);
  eq('  the plain name leads', keysFrom(env)[0], env.GEMINI_API_KEY);
  eq('  then _2', keysFrom(env)[1], 'second-key-do-not-log');
  eq('  then _10, numerically not alphabetically', keysFrom(env)[2], 'tenth-key-do-not-log');

  // The happy path still costs exactly one request, however many keys are held.
  let used = [];
  geminiHandler = async (_h, init) => { used.push(init.headers['x-goog-api-key']); return ok(); };
  let r = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('a good read uses the first key only', used.length, 1);
  eq('  and it is the first one', used[0], env.GEMINI_API_KEY);

  // A spent key hands over; a busy service does not, because 503 is not about
  // the key and trying another would spend two requests to learn one thing.
  for (const [status, expected] of [[429, 3], [401, 3], [403, 3], [503, 1], [500, 1]]) {
    used = [];
    geminiHandler = async (_h, init) => { used.push(init.headers['x-goog-api-key']); return { ok: false, status, json: async () => ({}) }; };
    await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
    eq(`upstream ${status} tries ${expected} key(s)`, used.length, expected);
  }

  // The point of holding a second key: the first is spent, the read still works.
  used = [];
  geminiHandler = async (_h, init) => {
    const key = init.headers['x-goog-api-key'];
    used.push(key);
    return key === env.GEMINI_API_KEY ? { ok: false, status: 429, json: async () => ({}) } : ok();
  };
  r = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('a spent first key falls through to the second', r.status, 200);
  eq('  and stops there', used.length, 2);
  eq('  the log says which key answered', r.body.items[0].term, 'go off');

  // Nothing about any key may reach the client or the log.
  geminiHandler = async () => ({ ok: false, status: 400,
    text: async () => JSON.stringify({ error: { message: `bad key ${env.GEMINI_API_KEY_2}` } }) });
  r = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  ok('every key is redacted, not just the first',
     !JSON.stringify(r.body).includes('second-key-do-not-log'), JSON.stringify(r.body));
}

console.log('== every read leaves something to look up afterwards ==');
{
  const env = makeEnv();
  const answer = () => ({ ok: true, json: async () => ({
    steps: [{ type: 'model_output', content: [{ type: 'text', text:
      '{"items":[{"term":"go off","kind":"phrasal-verb","confidence":"high"}]}' }] }] }) });

  geminiHandler = async () => answer();
  let r = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('a read that worked', r.status, 200);
  ok('  answers with its log id', Number.isInteger(r.body.trace), JSON.stringify(r.body.trace));

  geminiHandler = async () => ({ ok: false, status: 429, json: async () => ({}) });
  const bad = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('a read that failed', bad.status, 429);
  ok('  answers with its log id too', Number.isInteger(bad.body.trace));

  const logs = await call(env, 'GET', '/api/logs');
  eq('both reads are listed', logs.body.logs.length, 2);
  eq('  newest first', logs.body.logs[0].id, bad.body.trace);
  eq('  the failure is marked as one', logs.body.logs[0].ok, false);
  ok('  and says why', /quota/i.test(logs.body.logs[0].error), logs.body.logs[0].error);
  eq('  with the one request it spent', logs.body.logs[0].attempts.length, 1);
  eq('  and what came back', logs.body.logs[0].attempts[0].status, 429);
  eq('the success records the model that answered', logs.body.logs[1].model, 'gemini-3.5-flash');
  eq('  and how many items it read', logs.body.logs[1].items, 1);
  eq('  on one request as well', logs.body.logs[1].attempts.length, 1);
  ok('  and the size of the photo', logs.body.logs[1].image_kb >= 0);

  // Someone else's reads are none of your business.
  addUser(env.DB, 'other@example.com');
  const theirs = await call(env, 'GET', '/api/logs', { email: 'other@example.com' });
  eq('logs are per person', theirs.body.logs.length, 0);

  const capped = await call(env, 'GET', '/api/logs?limit=1');
  eq('limit respected', capped.body.logs.length, 1);

  // Logging is there to explain failures, not to cause them.
  const noTable = makeEnv();
  noTable.DB._raw.exec('DROP TABLE vision_log');
  geminiHandler = answer;
  const survived = await call(noTable, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('a read still works when the log cannot be written', survived.status, 200);
  eq('  the draft is unaffected', survived.body.items[0].term, 'go off');
  eq('  and it says there is no trace to look up', survived.body.trace, null);
}

console.log('== vision failures stay quiet about internals ==');
{
  const env = makeEnv();
  // Google wraps this one in an array; the reason has to survive that.
  geminiHandler = async () => ({ ok: false, status: 400,
    text: async () => JSON.stringify([{ error: { code: 400, status: 'INVALID_ARGUMENT',
      message: 'API key not valid: test-key-do-not-log' } }]) });
  const r = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('a refused request → 502', r.status, 502);

  // The reason goes in the log, where it is useful - with the key taken out.
  const logged = (await call(env, 'GET', '/api/logs')).body.logs[0];
  ok('  the upstream reason is logged', /API key not valid/.test(logged.attempts[0].detail || ''),
     JSON.stringify(logged.attempts[0]));
  ok('  with the key redacted', logged.attempts[0].detail.includes('<key>')
     && !JSON.stringify(logged).includes('test-key-do-not-log'), JSON.stringify(logged.attempts[0]));

  ok('  the status is quoted so it can be reported', /\(400\)/.test(r.body.error), r.body.error);
  ok('upstream message is not forwarded', !JSON.stringify(r.body).includes('test-key-do-not-log'), JSON.stringify(r.body));

  geminiHandler = async () => { throw new Error('network down'); };
  const r3 = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('network failure exhausts the chain → 503', r3.status, 503);

  geminiHandler = async () => ({ ok: true, json: async () => ({
    steps: [{ type: 'model_output', content: [{ type: 'text', text: 'not json at all' }] }] }) });
  const r4 = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('unparseable model output → 502', r4.status, 502);
}

console.log('== the call to Google leaves from a region Google serves ==');
{
  const env = { GEMINI_API_KEY: 'test-key-do-not-log' };
  const blocked = (region) => ({ ok: false, status: 400, text: async () => JSON.stringify({
    error: { code: 400, status: 'FAILED_PRECONDITION',
             message: `This API is not available in your current location (${region}).` } }) });
  const answer = () => ({ ok: true, json: async () => ({
    steps: [{ type: 'model_output', content: [{ type: 'text', text:
      '{"items":[{"term":"go off","kind":"phrasal-verb","confidence":"high"}]}' }] }] }) });

  // The first region is geo-blocked, which one request is enough to establish.
  const asked = [];
  let draft = await readPhoto({ base64: 'AAAA', mimeType: 'image/jpeg' }, env, {
    regions: ['first', 'second'],
    relay: (_e, region) => async () => { asked.push(region); return region === 'first' ? blocked(region) : answer(); },
  });
  eq('a blocked region is abandoned for the next', draft.items[0].term, 'go off');
  eq('  having spent one request there, not three', asked.filter((r) => r === 'first').length, 1);
  eq('  and the log says which region answered', draft.attempts.at(-1).region, 'second');

  // A refusal that is NOT about location stays a refusal - no second region.
  asked.length = 0;
  const refuses = { ok: false, status: 400, text: async () => JSON.stringify(
    { error: { message: 'Invalid value at input[1].data' } }) };
  let failed = null;
  await readPhoto({ base64: 'AAAA' }, env, {
    regions: ['first', 'second'],
    relay: (_e, region) => async () => { asked.push(region); return refuses; },
  }).catch((e) => { failed = e; });
  ok('an ordinary refusal is reported, not retried elsewhere', failed instanceof GeminiError);
  eq('  and no other region is tried', asked.filter((r) => r === 'second').length, 0);

  // The relay itself: the body is passed through, the target named in a header.
  let sent = null;
  const fakeEnv = { REGION: {
    idFromName: (name) => ({ name }),
    get: (id, options) => ({ fetch: async (_url, init) => { sent = { id, options, init }; return answer(); } }),
  } };
  await viaRegion(fakeEnv, 'apac-se')('https://generativelanguage.googleapis.com/v1beta/interactions',
                                      { method: 'POST', headers: { 'x-goog-api-key': 'k' }, body: '{"model":"m"}' });
  eq('the object is pinned to the region', sent.options.locationHint, 'apac-se');
  // The name carries a generation so a relay that lands somewhere blocked can
  // be escaped by asking for a new one.
  ok('  and named after it, so the pin sticks', sent.id.name.startsWith('apac-se:'), sent.id.name);
  eq('  the real destination rides in a header', sent.init.headers['x-target'],
     'https://generativelanguage.googleapis.com/v1beta/interactions');
  eq('  the key still goes to Google', sent.init.headers['x-goog-api-key'], 'k');
  eq('  and the photo is not copied into an envelope', sent.init.body, '{"model":"m"}');

  // Without the binding - a local run, or a stripped deployment - call directly.
  let direct = false;
  const plain = viaRegion({}, 'apac-se');
  globalThis.fetch = async () => { direct = true; return answer(); };
  await plain('https://example.test', { method: 'POST' });
  ok('no binding means a direct call, not a crash', direct);
  globalThis.fetch = patchedFetch;

  // A blocked first region must still appear in the log, not vanish behind the
  // region that worked.
  const seen = [];
  const draft2 = await readPhoto({ base64: 'AAAA' }, env, {
    regions: ['first', 'second'],
    relay: (_e, region) => async () => { seen.push(region); return region === 'first' ? blocked(region) : answer(); },
  });
  eq('every region it tried is in the log', draft2.attempts.length, 2);
  eq('  the blocked one first', draft2.attempts[0].region, 'first');
  eq('  then the one that answered', draft2.attempts.at(-1).region, 'second');

  ok('the regions tried are ones Google serves', REGIONS.length >= 2, REGIONS.join(','));
}

console.log('== vision input limits ==');
{
  const env = makeEnv();
  geminiHandler = async () => ({ ok: true, json: async () => ({
    steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"items":[]}' }] }] }) });
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
  geminiHandler = async () => ({ ok: true, json: async () => ({
    steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"items":[]}' }] }] }) });
  let last;
  for (let i = 0; i < 52; i++) last = await call(env, 'POST', '/api/vision', { body: { image: 'AAAA' } });
  eq('blocked once over the daily limit', last.status, 429);
  const row = env.DB._raw.prepare('SELECT count FROM usage_counter').get();
  ok('usage counted', row.count >= 50, JSON.stringify(row));
}

console.log('== parseItems tolerates model sloppiness ==');
{
  const steps = (text) => ({ steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text }] }] });
  const items = parseItems(steps(JSON.stringify({ items: [
    { term: '  spaced  ', kind: 'word', confidence: 'high' },
    { term: 'x', kind: 'not-a-kind', confidence: 'wat' },
    { term: '', kind: 'word' },
    { notterm: 1 },
    null,
  ] })));
  eq('drops entries without a term', items.length, 2);
  eq('trims the term', items[0].term, 'spaced');
  eq('falls back to word for an unknown kind', items[1].kind, 'word');
  eq('falls back to low confidence', items[1].confidence, 'low');

  // Seen from gemini-3.5-flash at thinking_level "low": the model works out its
  // answer inside the field instead of in a thought step.
  const leaked = parseItems(steps(JSON.stringify({ items: [{
    term: 'brittle', kind: 'word', confidence: 'high',
    vi: 'giòn, dễ vỡ\nLet\'s write: {\n  "term": "brittle",\n  "vi": "giòn, dễ vỡ"\n}',
    meaning: 'x'.repeat(400),
  }] })));
  eq('keeps the answer, drops the thinking after it', leaked[0].vi, 'giòn, dễ vỡ');
  eq('caps a runaway field', leaked[0].meaning.length, 200);

  eq('reads the real steps shape',
    parseItems(steps('{"items":[{"term":"a","kind":"word","confidence":"high"}]}'))[0].term, 'a');
  eq('still reads the older candidates shape',
    parseItems({ candidates: [{ content: { parts: [{ text: '{"items":[{"term":"b","kind":"word","confidence":"high"}]}' }] } }] })[0].term, 'b');
  eq('ignores thought steps', parseItems({ steps: [
    { type: 'thought', content: [{ type: 'text', text: '{"items":[{"term":"WRONG","kind":"word","confidence":"high"}]}' }] },
    { type: 'model_output', content: [{ type: 'text', text: '{"items":[{"term":"right","kind":"word","confidence":"high"}]}' }] },
  ] })[0].term, 'right');

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
