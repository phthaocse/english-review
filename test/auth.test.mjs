import { verifyGoogleToken, authenticate, createKeyStore, AuthError } from '../worker/src/auth.js';
import { makeSigner, claimsFor } from './jwt.mjs';
import { makeD1, addUser } from './d1.mjs';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x); } };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const CLIENT_ID = '123456789-abc.apps.googleusercontent.com';
const signer = await makeSigner();
const keyFor = createKeyStore(signer.jwksFetch());

/** Run the verifier and report either the claims or the rejection reason. */
async function verify(token, clientId = CLIENT_ID, opts = {}) {
  try {
    return { ok: true, claims: await verifyGoogleToken(token, clientId, { keyFor, ...opts }) };
  } catch (e) {
    return { ok: false, message: e.message, status: e.status, isAuthError: e instanceof AuthError };
  }
}

console.log('== a genuine token is accepted ==');
let r = await verify(await signer.sign(claimsFor('thaop@ghn.vn', CLIENT_ID)));
ok('valid token accepted', r.ok, r.message);
eq('email extracted', r.claims?.email, 'thaop@ghn.vn');
eq('name extracted', r.claims?.name, 'Test User');

r = await verify(await signer.sign(claimsFor('Thao.P@Example.COM', CLIENT_ID)));
eq('email is lower-cased for matching', r.claims?.email, 'thao.p@example.com');

r = await verify(await signer.sign(claimsFor('a@b.com', CLIENT_ID, { iss: 'accounts.google.com' })));
ok('bare issuer accepted', r.ok, r.message);

console.log('== forged and tampered tokens are rejected ==');

// The check people leave out: a token Google really did sign, for someone else's app.
r = await verify(await signer.sign(claimsFor('a@b.com', 'SOME-OTHER-APP.apps.googleusercontent.com')));
ok('token minted for another app is rejected', !r.ok, 'ACCEPTED IT');
ok('  and says why', /not issued for this app/.test(r.message || ''), r.message);

// alg confusion: attacker rewrites the header hoping the verifier obeys it.
const noneToken = (() => {
  const b64 = (o) => btoa(JSON.stringify(o)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  return `${b64({ alg: 'none', kid: signer.kid })}.${b64(claimsFor('a@b.com', CLIENT_ID))}.`;
})();
r = await verify(noneToken);
ok('alg=none rejected', !r.ok, 'ACCEPTED IT');

const hsToken = await signer.sign(claimsFor('a@b.com', CLIENT_ID), { header: { alg: 'HS256' } });
r = await verify(hsToken);
ok('alg=HS256 rejected', !r.ok, 'ACCEPTED IT');

// Payload edited after signing — signature must no longer match.
const good = await signer.sign(claimsFor('nobody@evil.com', CLIENT_ID));
const [h, , s] = good.split('.');
const swapped = btoa(JSON.stringify(claimsFor('thaop@ghn.vn', CLIENT_ID)))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
r = await verify(`${h}.${swapped}.${s}`);
ok('edited payload rejected', !r.ok, 'ACCEPTED IT');

// Signed with a different key than the JWKS advertises.
const other = await makeSigner(signer.kid);
r = await verify(await other.sign(claimsFor('a@b.com', CLIENT_ID)));
ok('token signed by a foreign key rejected', !r.ok, 'ACCEPTED IT');

r = await verify(await signer.sign(claimsFor('a@b.com', CLIENT_ID), { header: { kid: 'unknown-kid' } }));
ok('unknown kid rejected', !r.ok, 'ACCEPTED IT');

console.log('== claim checks ==');
r = await verify(await signer.sign(claimsFor('a@b.com', CLIENT_ID, { exp: Math.floor(Date.now()/1000) - 7200 })));
ok('expired token rejected', !r.ok, 'ACCEPTED IT');
ok('  and says why', /expired/.test(r.message || ''), r.message);

r = await verify(await signer.sign(claimsFor('a@b.com', CLIENT_ID, { exp: Math.floor(Date.now()/1000) - 10 })));
ok('small clock skew tolerated', r.ok, r.message);

r = await verify(await signer.sign(claimsFor('a@b.com', CLIENT_ID, { iss: 'https://evil.example.com' })));
ok('wrong issuer rejected', !r.ok, 'ACCEPTED IT');

r = await verify(await signer.sign(claimsFor('a@b.com', CLIENT_ID, { email_verified: false })));
ok('unverified email rejected', !r.ok, 'ACCEPTED IT');

r = await verify(await signer.sign(claimsFor(undefined, CLIENT_ID, { email: undefined })));
ok('token without an email rejected', !r.ok, 'ACCEPTED IT');

console.log('== malformed input ==');
for (const [label, bad] of [['empty', ''], ['not a jwt', 'hello'], ['two parts', 'a.b'],
                            ['garbage segments', 'x.y.z'], ['null', null]]) {
  r = await verify(bad);
  ok(`${label} rejected without throwing`, !r.ok && r.isAuthError, r.message);
}

r = await verify(await signer.sign(claimsFor('a@b.com', CLIENT_ID)), '');
eq('missing server client id is a 500, not a 401', r.status, 500);

console.log('== allowlist ==');
async function authOf(email, seed) {
  const db = makeD1();
  if (seed) seed(db);
  const env = { DB: db, GOOGLE_CLIENT_ID: CLIENT_ID };
  const token = await signer.sign(claimsFor(email, CLIENT_ID));
  const req = new Request('https://x/api/items', { headers: { Authorization: `Bearer ${token}` } });
  try { return { ok: true, user: await authenticate(req, env, { keyFor }), db }; }
  catch (e) { return { ok: false, message: e.message, status: e.status, db }; }
}

let a = await authOf('thaop@ghn.vn', (db) => addUser(db, 'thaop@ghn.vn', { role: 'owner' }));
ok('allowlisted user authenticates', a.ok, a.message);
eq('role comes from the database', a.user?.role, 'owner');

a = await authOf('stranger@example.com', (db) => addUser(db, 'thaop@ghn.vn'));
ok('unlisted user rejected', !a.ok, 'LET THEM IN');
eq('  with 403, not 401', a.status, 403);

a = await authOf('gone@example.com', (db) => addUser(db, 'gone@example.com', { status: 'revoked' }));
ok('revoked user rejected', !a.ok, 'LET THEM IN');
eq('  with 403', a.status, 403);

// Case-insensitive match: Google may report a differently-cased address.
a = await authOf('ThaoP@GHN.vn', (db) => addUser(db, 'thaop@ghn.vn'));
ok('allowlist match ignores case', a.ok, a.message);

// last_seen_at should be stamped on a successful sign-in.
a = await authOf('thaop@ghn.vn', (db) => addUser(db, 'thaop@ghn.vn'));
const seen = a.db._raw.prepare('SELECT last_seen_at FROM user WHERE email = ?').get('thaop@ghn.vn');
ok('last seen recorded', !!seen.last_seen_at, JSON.stringify(seen));

console.log('== missing / malformed Authorization header ==');
for (const [label, headers] of [['no header', {}], ['not bearer', { Authorization: 'Basic abc' }],
                                ['empty bearer', { Authorization: 'Bearer ' }]]) {
  const db = makeD1(); addUser(db, 'thaop@ghn.vn');
  try {
    await authenticate(new Request('https://x/', { headers }), { DB: db, GOOGLE_CLIENT_ID: CLIENT_ID }, { keyFor });
    fail++; console.log('  FAIL:', label, 'was accepted');
  } catch (e) { ok(`${label} rejected`, e instanceof AuthError, e.message); }
}

console.log('== JWKS caching ==');
let fetches = 0;
const counting = createKeyStore(async (...args) => { fetches++; return signer.jwksFetch()(...args); });
for (let i = 0; i < 5; i++) await verifyGoogleToken(await signer.sign(claimsFor('a@b.com', CLIENT_ID)), CLIENT_ID, { keyFor: counting });
eq('keys fetched once, then cached', fetches, 1);

let t = 0;
const expiring = createKeyStore(async (...args) => { fetches++; return signer.jwksFetch()(...args); }, () => t);
fetches = 0;
await verifyGoogleToken(await signer.sign(claimsFor('a@b.com', CLIENT_ID)), CLIENT_ID, { keyFor: expiring, now: () => Date.now() });
t = 3600_001;  // past the advertised max-age
await verifyGoogleToken(await signer.sign(claimsFor('a@b.com', CLIENT_ID)), CLIENT_ID, { keyFor: expiring, now: () => Date.now() });
eq('keys refetched after max-age', fetches, 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
