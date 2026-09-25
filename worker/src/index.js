// API for the knowledge site.
//
// Everything here is behind Google sign-in plus an allowlist: the store and the
// Gemini key are only reachable by a verified, listed identity. The static site
// itself stays public — it is only a shell until someone signs in.

import { authenticate, AuthError } from './auth.js';
import { draftFromImage, GeminiError, MAX_IMAGE_BYTES, KINDS } from './gemini.js';
import { createItem, findItemByTerm, getItem, listItems, countItems, consumeQuota } from './db.js';

const VISION_CALLS_PER_DAY = 50;

function cors(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origin = request.headers.get('Origin');
  return {
    // An echo, not a wildcard, so the Authorization header is usable. Note this
    // is not a security control — curl ignores CORS. The token is the control.
    'Access-Control-Allow-Origin': origin && allowed.includes(origin) ? origin : (allowed[0] || ''),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  });

function fail(error, headers) {
  if (error instanceof AuthError || error instanceof GeminiError) {
    return json({ error: error.message }, error.status, headers);
  }
  // Never surface an internal message: it can carry configuration or the key.
  console.error('unhandled error', error?.stack || error);
  return json({ error: 'something went wrong' }, 500, headers);
}

async function readJson(request, limitBytes = 8 * 1024 * 1024) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > limitBytes) throw new AuthError('request too large', 413);
  try {
    return await request.json();
  } catch {
    throw new AuthError('body is not valid JSON', 400);
  }
}

/** Reject anything the review screen should have fixed before submitting. */
function validateItem(body) {
  const term = typeof body?.term === 'string' ? body.term.trim() : '';
  if (!term) throw new AuthError('term is required', 400);
  if (term.length > 200) throw new AuthError('term is too long', 400);

  const kind = KINDS.includes(body?.kind) ? body.kind
    : ['pronunciation-rule', 'error-drill'].includes(body?.kind) ? body.kind : null;
  if (!kind) throw new AuthError(`kind must be one of: ${KINDS.join(', ')}`, 400);

  const examples = Array.isArray(body.examples) ? body.examples.filter((e) => typeof e === 'string') : [];
  const tags = Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string').slice(0, 20) : [];

  return {
    term, kind,
    meaning: body.meaning?.trim?.() || null,
    vi: body.vi?.trim?.() || null,
    rule: body.rule?.trim?.() || null,
    notes: body.notes?.trim?.() || null,
    source: ['photo', 'typed'].includes(body.source) ? body.source : 'typed',
    source_note: body.source_note?.trim?.() || null,
    examples: examples.slice(0, 10).map((e) => e.slice(0, 1000)),
    tags,
  };
}

const ROUTES = {
  'GET /api/me': async (_request, env, user) => json({
    user: { email: user.email, name: user.name, role: user.role },
    stats: await countItems(env.DB),
  }, 200),

  'GET /api/items': async (request, env) => {
    const url = new URL(request.url);
    return json({
      items: await listItems(env.DB, {
        status: url.searchParams.get('status'),
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      }),
    }, 200);
  },

  'POST /api/items': async (request, env, user) => {
    const item = validateItem(await readJson(request));
    const id = await createItem(env.DB, item, user.id);
    if (id === null) {
      const existing = await findItemByTerm(env.DB, item.term, item.kind);
      return json({ error: 'already captured', item: existing }, 409);
    }
    return json({ item: await getItem(env.DB, id) }, 201);
  },

  // Photo in, draft out. Nothing is stored here — the review screen decides.
  'POST /api/vision': async (request, env, user) => {
    const quota = await consumeQuota(env.DB, user.id, 'gemini_image', VISION_CALLS_PER_DAY);
    if (!quota.allowed) {
      return json({ error: `daily limit of ${quota.limit} image reads reached` }, 429);
    }

    const body = await readJson(request);
    const base64 = typeof body?.image === 'string' ? body.image.replace(/^data:[^,]+,/, '') : '';
    if (!base64) throw new AuthError('image is required', 400);
    // base64 carries 3 bytes per 4 characters.
    if (base64.length * 0.75 > MAX_IMAGE_BYTES) throw new AuthError('image is too large', 413);

    const mimeType = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
      .includes(body.mimeType) ? body.mimeType : 'image/jpeg';

    const draft = await draftFromImage({ base64, mimeType }, env);
    return json({ ...draft, quota: { remaining: quota.remaining } }, 200);
  },
};

export default {
  async fetch(request, env) {
    const headers = cors(env, request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    const route = ROUTES[`${request.method} ${url.pathname}`];
    if (!route) return json({ error: 'not found' }, 404, headers);

    try {
      const user = await authenticate(request, env);
      const response = await route(request, env, user);
      for (const [k, v] of Object.entries(headers)) response.headers.set(k, v);
      return response;
    } catch (error) {
      return fail(error, headers);
    }
  },
};
