// API for the knowledge site.
//
// Everything here is behind Google sign-in plus an allowlist: the store and the
// Gemini key are only reachable by a verified, listed identity. The static site
// itself stays public — it is only a shell until someone signs in.

import { authenticate, AuthError } from './auth.js';
import { readPhoto, GeminiError, MAX_IMAGE_BYTES, KINDS } from './gemini.js';
import { verifyAll, lookup } from './oxford.js';
import { createItem, mergeIntoItem, findItemByTerm, getItem, listItems, countItems,
         consumeQuota, logVision, listVisionLogs } from './db.js';

const VISION_CALLS_PER_DAY = 50;

/**
 * Record a read, and never let recording it be the thing that fails.
 * A missing table or a full database must not turn a working read into an error.
 */
async function recordVision(env, user, entry) {
  console[entry.ok ? 'log' : 'error'](JSON.stringify({ event: 'vision', user: user.email, ...entry }));
  try {
    return await logVision(env.DB, user.id, entry);
  } catch (error) {
    console.error('could not write vision_log', error?.message);
    return null;
  }
}

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
    ipa: body.ipa?.trim?.() || null,
    cefr: body.cefr?.trim?.()?.toLowerCase() || null,
    pattern: body.pattern?.trim?.()?.slice(0, 300) || null,
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

    // A typed entry is usually a bare word. Oxford fills in what was left
    // blank - and only what was left blank, because a meaning the person wrote
    // themselves is the sense they met, which may not be Oxford's first one.
    try {
      const entry = await lookup(item.term);
      if (entry) {
        item.meaning ??= entry.meaning;
        item.ipa ??= entry.ipa;
        item.cefr ??= entry.cefr;
        item.status = 'enriched';       // the dictionary has spoken; the vault can trust it
      }
    } catch (error) {
      console.error('oxford lookup failed', error?.message);
    }

    const id = await createItem(env.DB, item, user.id);
    if (id === null) {
      // Not a rejection: a word met twice usually brings a second sentence.
      const existing = await findItemByTerm(env.DB, item.term, item.kind);
      const merged = await mergeIntoItem(env.DB, existing, item);
      return json({ item: await getItem(env.DB, existing.id), merged }, 200);
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

    const imageKb = Math.round(base64.length * 0.75 / 1024);
    const startedAt = Date.now();

    // Both paths record a row and hand its id back, so "it failed" always has
    // something to look up afterwards.
    try {
      const draft = await readPhoto({ base64, mimeType }, env);
      // The model read the handwriting; Oxford says what the words mean. A
      // lookup failure must not lose a read that already cost a request.
      let items = draft.items;
      try {
        items = await verifyAll(draft.items);
      } catch (error) {
        console.error('oxford lookup failed', error?.message);
      }
      const trace = await recordVision(env, user, {
        ok: true, durationMs: Date.now() - startedAt, imageKb,
        model: draft.model, items: items.length, attempts: draft.attempts,
        verified: items.filter((i) => i.verified).length });
      return json({ items, model: draft.model, trace,
                    quota: { remaining: quota.remaining } }, 200);
    } catch (error) {
      if (!(error instanceof GeminiError)) throw error;
      const trace = await recordVision(env, user, {
        ok: false, durationMs: Date.now() - startedAt, imageKb,
        attempts: error.attempts || [], error: error.message });
      return json({ error: error.message, trace }, error.status);
    }
  },

  'GET /api/logs': async (request, env, user) => {
    const limit = new URL(request.url).searchParams.get('limit');
    return json({ logs: await listVisionLogs(env.DB, user.id, limit) }, 200);
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

// The relay that keeps the call to Google inside a country Google serves.
export { RegionalFetcher } from './region.js';
