// The Gemini proxy.
//
// The API key is a Worker secret and never reaches the browser; the client
// sends an image here and gets back a *draft*, which a human confirms on the
// review screen before anything is stored.
//
// Request shape follows the current Interactions API
// (https://ai.google.dev/gemini-api/docs/quickstart): POST /v1beta/interactions
// with an `x-goog-api-key` header and a {model, input, response_format} body.

import { REGIONS, viaRegion } from './region.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// One photo costs one request. Trying three models in a row turned a bad minute
// into three of the day's twenty, and when a pool is saturated they are all
// saturated together - so a failure is reported and the reader offers a retry,
// which spends the next request only if the person asks for it.
const DEFAULT_MODEL = 'gemini-3.5-flash';
const RATE_LIMITED = 429;

// A key is done for the day (429) or no longer valid (401/403). Either way the
// next key has a real chance, which is not true of a 503 - when a pool is
// saturated it is saturated for every key, so retrying there spends two
// requests to learn one thing.
const KEY_IS_SPENT = new Set([401, 403, RATE_LIMITED]);

/**
 * Every key the Worker holds, in the order they should be tried:
 * GEMINI_API_KEY first, then GEMINI_API_KEY_2, _3 and so on. Adding one is a
 * `wrangler secret put` and nothing else - no deploy, no code change - which is
 * what makes retiring a key possible without downtime.
 */
export function keysFrom(env) {
  const numbered = Object.keys(env)
    .filter((name) => /^GEMINI_API_KEY_\d+$/.test(name))
    .sort((a, b) => Number(a.split('_').pop()) - Number(b.split('_').pop()));
  return [env.GEMINI_API_KEY, ...numbered.map((n) => env[n])].filter(Boolean);
}

// The free tier is slow when busy - an 8-token text prompt took 17s the day
// this was written - so waiting beats failing, but not for ever.
const ATTEMPT_TIMEOUT_MS = 90_000;

// 500 and up is the service having a bad moment rather than a verdict on the
// photo, so the next model gets a turn. 0 is our own timeout or network.
const isTransient = (status) => status === 0 || status >= 500;

// Inline image data caps the whole request at 20 MB; stay well under it, and
// the client downscales before uploading anyway.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const KINDS = ['word', 'phrasal-verb', 'idiom', 'collocation',
                      'conversational', 'grammar-pattern'];

// The model's one job here is to READ THE PAGE. It used to be asked for a
// definition as well, and it obliged - fluently, differently every run, and
// close enough to Oxford to look right while saying "other people's property"
// where Oxford says "public property". The definition now comes from Oxford
// itself (oxford.js), so anything the model supplies here is a transcription,
// not an answer.
const PROMPT = `You are reading a photograph of handwritten English study notes.

The writer is Vietnamese, learning English at about B2. A page is often a bare
list of words with nothing beside them; a usable draft still comes back filled
in, because a word with no meaning is no use to revise from.

Extract every English word or phrase the writer was learning. For each one give:
- term: the headword, lower-cased unless it is a proper noun, with no leading article
- kind: one of ${KINDS.join(', ')}
- meaning: ONLY what the page itself gives. If the writer wrote a definition
  beside the word, transcribe theirs. If the page gives none, use null — do not
  write one. The definition is looked up in Oxford afterwards, and a fluent
  invention here would quietly replace a real one.
- vi: a short Vietnamese gloss with full diacritics. Transcribe the writer's if
  the page has one; otherwise supply one, because no dictionary here gives
  Vietnamese and a gloss is what makes the draft usable.
- example: one natural sentence showing the word in use, with the target wrapped
  in **double asterisks**. Take the writer's own sentence when the page has one;
  otherwise write a plain, everyday sentence of your own.
- pattern: the grammatical pattern the word takes, ONLY if the notes show one —
  e.g. "spend + on / + -ing (not for)", "accuse sb of sth". Otherwise null.
- source_note: any context the writer recorded about where they met it
- confidence: high, medium or low — how sure you are you read the handwriting correctly

Rules:
- Cover the WHOLE page. Every numbered or bulleted entry becomes one item, in
  the order they are written. Do not stop after the first few.
- Each field holds the final value only — never your reasoning, alternatives,
  restatements or commentary. Work it out before you answer, not in the field.
- Transcribe the TERM, do not invent it. If the handwriting is unclear, use low
  confidence and put your best reading in term.
- The Vietnamese gloss and the example may be yours. The meaning and the
  pattern may not: both are checked against a dictionary afterwards, and a
  plausible guess there is worse than a blank.
- Do not supply pronunciation or CEFR level; those come from the dictionary.
- Return an empty list if the image contains no English study notes.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          kind: { type: 'string', enum: KINDS },
          meaning: { type: 'string', nullable: true },
          vi: { type: 'string', nullable: true },
          example: { type: 'string', nullable: true },
          pattern: { type: 'string', nullable: true },
          source_note: { type: 'string', nullable: true },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['term', 'kind', 'confidence'],
      },
    },
  },
  required: ['items'],
};

export class GeminiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

/** One attempt at one model. Returns the parsed draft, or the status to act on. */
async function askModel(model, image, env, fetchImpl, key) {
  const body = {
    model,
    input: [
      { type: 'text', text: PROMPT },
      { type: 'image', data: image.base64, mime_type: image.mimeType },
    ],
    response_format: { type: 'text', mime_type: 'application/json', schema: RESPONSE_SCHEMA },
  };

  const started = Date.now();
  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
  } catch {
    return { status: 0, ms: Date.now() - started };   // timed out or unreachable
  }

  // Which data centre the relay actually sits in. The location hint is best
  // effort, so this is the only way to know it landed where Google serves.
  const colo = res.headers?.get?.('x-relay-colo') || null;

  if (!res.ok) return { status: res.status, ms: Date.now() - started, colo, detail: await reason(res, env) };
  return { status: 200, ms: Date.now() - started, colo, payload: await res.json() };
}

/**
 * The upstream complaint in a few words, for the log. Upstream errors can quote
 * the request back, so the key and any image data are taken out first.
 */
async function reason(res, env) {
  let body;
  try {
    body = await res.text();
  } catch {
    return null;
  }
  let message = body;
  try {
    // Some errors arrive wrapped in an array, some bare.
    const parsed = JSON.parse(body);
    const failure = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
    message = failure?.message || failure?.status || body;
  } catch { /* not JSON; the raw text is still a clue */ }

  let clean = String(message);
  for (const key of keysFrom(env)) clean = clean.split(key).join('<key>');
  return clean.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '<data>').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Google's refusal when the request comes from a country it does not serve. */
const blockedByLocation = (attempts) => attempts.length > 0
  && attempts.every((a) => a.status === 400 && /current location/i.test(a.detail || ''));

/**
 * Turn a photo into draft items, from a region Google serves.
 *
 * The relay's region is fixed when it is first created, so a bad one would be
 * permanent: if every model says the location is wrong, the next region gets
 * the same photo rather than the reader getting a dead end.
 */
export async function readPhoto(image, env, { regions = REGIONS, relay = viaRegion } = {}) {
  const tried = [];      // every region's attempts, so the log tells the whole story
  let last;

  for (const region of regions) {
    try {
      const draft = await draftFromImage(image, env, { fetchImpl: relay(env, region), region });
      return { ...draft, attempts: [...tried, ...draft.attempts] };
    } catch (error) {
      const here = error.attempts || [];
      tried.push(...here);
      error.attempts = [...tried];
      last = error;
      if (!blockedByLocation(here)) throw error;   // only a blocked region earns another go
    }
  }
  throw last;
}

/**
 * Turn a photo into draft items, asking each model in turn until one answers.
 * The chain is the retry: a busy model is rarely free a second later.
 */
export async function draftFromImage(image, env, { fetchImpl = fetch, region = null } = {}) {
  const keys = keysFrom(env);
  if (!keys.length) throw new GeminiError('image reading is not configured', 503);

  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  const attempts = [];  // what came back, for the log and the UI

  // Attached to the error so the caller can record why this failed.
  const give = (message, status) => Object.assign(new GeminiError(message, status), { attempts });

  let status, ms, colo, detail, payload;
  for (let k = 0; k < keys.length; k++) {
    ({ status, ms, colo, detail, payload } = await askModel(model, image, env, fetchImpl, keys[k]));
    attempts.push({ model, status, ms, ...(keys.length > 1 ? { key: k + 1 } : {}),
                    ...(region ? { region } : {}), ...(colo ? { colo } : {}),
                    ...(detail ? { detail } : {}) });
    if (!KEY_IS_SPENT.has(status)) break;   // this key is fine; the answer is not about the key
  }

  if (status === 200) return { items: parseItems(payload), model, attempts };

  if (status === RATE_LIMITED) {
    throw give(`today's free quota for reading photos is used up${
      keys.length > 1 ? ` on all ${keys.length} keys` : ''} - it resets tomorrow, `
      + 'or you can type the word in instead', RATE_LIMITED);
  }
  // The status is in the message on purpose: it is the one fact that tells a
  // refusal apart from an outage when this is reported second-hand.
  if (!isTransient(status)) {
    throw give(`the image service could not read that photo (${status})`, 502);
  }
  throw give('the image service is busy right now - try again in a moment', 503);
}

/**
 * Pull the model's text out of the response.
 *
 * The Interactions API answers with a `steps` array: reasoning arrives as
 * `type: 'thought'` steps and the answer as the `model_output` one, so the
 * text has to be picked out rather than read off the top level. The older
 * shapes are kept as fallbacks.
 */
export function modelText(payload) {
  const steps = Array.isArray(payload?.steps) ? payload.steps : [];
  const output = [...steps].reverse().find((s) => s?.type === 'model_output');
  const fromStep = output?.content?.find((c) => typeof c?.text === 'string')?.text;

  return fromStep
    ?? payload?.output_text
    ?? payload?.output?.[0]?.content?.[0]?.text
    ?? payload?.candidates?.[0]?.content?.parts?.[0]?.text;
}

// A model under a JSON schema sometimes deliberates inside a string field, so
// keep the first line and cap the length; the review screen fixes the rest.
function field(text, max) {
  if (typeof text !== 'string') return null;
  const line = text.split('\n')[0].trim();
  return line ? line.slice(0, max) : null;
}

/** Pull the model's JSON out of the response, and sanity-check it. */
export function parseItems(payload) {
  const text = modelText(payload);

  if (typeof text !== 'string') throw new GeminiError('unexpected response from the image service');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiError('the image service did not return usable JSON');
  }

  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  return items
    .filter((i) => i && typeof i.term === 'string' && i.term.trim())
    .map((i) => ({
      term: field(i.term, 200),
      kind: KINDS.includes(i.kind) ? i.kind : 'word',
      meaning: field(i.meaning, 200),
      vi: field(i.vi, 120),
      example: field(i.example, 500),
      pattern: field(i.pattern, 200),
      source_note: field(i.source_note, 200),
      confidence: ['high', 'medium', 'low'].includes(i.confidence) ? i.confidence : 'low',
    }));
}
