// Mints real RS256 tokens for the auth tests, and serves a matching JWKS.
// Real signatures, so the verifier's crypto path is genuinely exercised.

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const enc = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

export async function makeSigner(kid = 'test-key-1') {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk = { ...jwk, kid, alg: 'RS256', use: 'sig' };
  delete publicJwk.key_ops;
  delete publicJwk.ext;

  async function sign(claims, { header = {}, key = pair.privateKey } = {}) {
    const head = enc({ alg: 'RS256', kid, typ: 'JWT', ...header });
    const body = enc(claims);
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key,
      new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64url(sig)}`;
  }

  /** A JWKS endpoint stand-in, so no network call is made in tests. */
  function jwksFetch(extraKeys = []) {
    return async () => ({
      ok: true,
      json: async () => ({ keys: [publicJwk, ...extraKeys] }),
      headers: { get: (h) => (h.toLowerCase() === 'cache-control' ? 'public, max-age=3600' : null) },
    });
  }

  return { sign, publicJwk, jwksFetch, pair, kid };
}

/** A valid-looking set of Google claims, before any tampering. */
export function claimsFor(email, clientId, overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: clientId,
    sub: '1234567890',
    email,
    email_verified: true,
    name: 'Test User',
    iat: now,
    exp: now + 3600,
    ...overrides,
  };
}
