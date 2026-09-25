// Google ID token verification.
//
// The browser signs in with Google and sends the resulting ID token on every
// request. This module decides whether that token is genuine and whether the
// person behind it is on the allowlist. Everything downstream — the knowledge
// base, and the Gemini key — depends on it being right, so it validates the
// full set of claims rather than just decoding the JWT.

const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const VALID_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

function b64urlToBytes(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(text.length + ((4 - (text.length % 4)) % 4), '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment)));
}

/**
 * Google's signing keys, cached for as long as the response says.
 *
 * Fetching them per request would add a round trip to every call; caching them
 * forever would break when Google rotates. `Cache-Control: max-age` is the
 * interval Google itself nominates.
 */
// `fetch` is looked up when the store is used, not when this module is
// evaluated: capturing the global at load time freezes in whatever binding
// existed then, which breaks instrumentation and test doubles alike.
function createKeyStore(fetchImpl = (...args) => fetch(...args), now = () => Date.now()) {
  let cache = { keys: null, expiresAt: 0 };

  return async function keyFor(kid) {
    if (!cache.keys || now() >= cache.expiresAt) {
      const res = await fetchImpl(GOOGLE_JWKS);
      if (!res.ok) throw new AuthError('cannot reach Google signing keys', 503);
      const body = await res.json();
      const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1]);
      cache = {
        keys: body.keys || [],
        expiresAt: now() + (Number.isFinite(maxAge) ? maxAge : 3600) * 1000,
      };
    }
    return cache.keys.find((k) => k.kid === kid) || null;
  };
}

export const defaultKeyStore = createKeyStore();
export { createKeyStore };

/**
 * Verify a Google ID token and return its claims.
 *
 * @param {string} token     the raw JWT
 * @param {string} clientId  this app's OAuth client ID
 */
export async function verifyGoogleToken(token, clientId, { keyFor = defaultKeyStore, now = () => Date.now(), clockSkewSec = 60 } = {}) {
  if (!clientId) throw new AuthError('server is missing GOOGLE_CLIENT_ID', 500);
  if (!token || typeof token !== 'string') throw new AuthError('no token supplied');

  const parts = token.split('.');
  if (parts.length !== 3) throw new AuthError('malformed token');

  let header, claims;
  try {
    header = decodeJson(parts[0]);
    claims = decodeJson(parts[1]);
  } catch {
    throw new AuthError('malformed token');
  }

  // Reject 'none' and HMAC algorithms outright. Accepting whatever the token
  // asks for is the classic JWT forgery: an attacker sets alg to HS256 and
  // signs with the public key, which is not secret.
  if (header.alg !== 'RS256') throw new AuthError('unexpected token algorithm');

  const jwk = await keyFor(header.kid);
  if (!jwk) throw new AuthError('unknown signing key');

  const key = await crypto.subtle.importKey(
    'jwk', { ...jwk, alg: 'RS256' }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify'],
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), signed);
  if (!valid) throw new AuthError('bad signature');

  // Without this check, a token Google minted for ANY other application would
  // be accepted here. It is the check people leave out.
  if (claims.aud !== clientId) throw new AuthError('token was not issued for this app');

  if (!VALID_ISSUERS.includes(claims.iss)) throw new AuthError('unexpected issuer');

  const seconds = Math.floor(now() / 1000);
  if (typeof claims.exp !== 'number' || seconds > claims.exp + clockSkewSec) {
    throw new AuthError('token has expired');
  }
  if (typeof claims.iat === 'number' && seconds + clockSkewSec < claims.iat) {
    throw new AuthError('token is not valid yet');
  }

  // An unverified address proves nothing: anyone can put your email on a
  // Google account they control until Google has confirmed it.
  if (claims.email_verified !== true) throw new AuthError('email is not verified');
  if (!claims.email) throw new AuthError('token carries no email');

  return { email: String(claims.email).toLowerCase(), name: claims.name || null, sub: claims.sub };
}

/**
 * Verify the request's token, then look the person up on the allowlist.
 * Identity comes only from the token — never from anything the client sends.
 */
export async function authenticate(request, env, options = {}) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer (.+)$/.exec(header.trim());
  if (!match) throw new AuthError('missing Authorization: Bearer <token>');

  const identity = await verifyGoogleToken(match[1], env.GOOGLE_CLIENT_ID, options);

  const row = await env.DB.prepare(
    'SELECT id, email, name, role, status FROM user WHERE email = ?',
  ).bind(identity.email).first();

  if (!row) throw new AuthError('this account is not on the allowlist', 403);
  if (row.status !== 'allowed') throw new AuthError('this account has been revoked', 403);

  await env.DB.prepare("UPDATE user SET last_seen_at = datetime('now'), name = COALESCE(name, ?) WHERE id = ?")
    .bind(identity.name, row.id).run();

  return { id: row.id, email: row.email, name: row.name || identity.name, role: row.role };
}
