// The Gemini proxy.
//
// The API key is a Worker secret and never reaches the browser; the client
// sends an image here and gets back a *draft*, which a human confirms on the
// review screen before anything is stored.
//
// Request shape follows the current Interactions API
// (https://ai.google.dev/gemini-api/docs/quickstart): POST /v1beta/interactions
// with an `x-goog-api-key` header and a {model, input, response_format} body.

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

// Ordered by what answered fastest and most accurately on a handwritten page;
// each carries its own free-tier quota, so a bad day for one is survivable.
const MODEL_CHAIN = ['gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-3.8-flash'];
const RATE_LIMITED = 429;

// The free tier is slow when busy - an 8-token text prompt took 17s the day
// this was written - so waiting beats failing, but not for ever.
const ATTEMPT_TIMEOUT_MS = 90_000;
const CHAIN_DEADLINE_MS = 150_000;

// 500 and up is the service having a bad moment rather than a verdict on the
// photo, so the next model gets a turn. 0 is our own timeout or network.
const isTransient = (status) => status === 0 || status >= 500;

// Inline image data caps the whole request at 20 MB; stay well under it, and
// the client downscales before uploading anyway.
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const KINDS = ['word', 'phrasal-verb', 'idiom', 'collocation',
                      'conversational', 'grammar-pattern'];

// Deliberately does NOT ask for IPA or CEFR. Those are verified against Oxford
// during enrichment; a guess here would be a plausible-sounding fabrication,
// which is the failure this whole system is built to avoid.
const PROMPT = `You are reading a photograph of handwritten English study notes.

Extract every English word or phrase the writer was learning. For each one give:
- term: the headword, lower-cased unless it is a proper noun, with no leading article
- kind: one of ${KINDS.join(', ')}
- meaning: a short English definition, only if you can read one in the notes or
  are confident of the everyday sense
- vi: the Vietnamese gloss ONLY if it is written in the photo; otherwise null
- example: an example sentence ONLY if one appears in the photo; otherwise null.
  Wrap the target word in **double asterisks**.
- pattern: the grammatical pattern the word takes, ONLY if the notes show one —
  e.g. "spend + on / + -ing (not for)", "accuse sb of sth". Otherwise null.
- source_note: any context the writer recorded about where they met it
- confidence: high, medium or low — how sure you are you read the handwriting correctly

Rules:
- Cover the WHOLE page. Every numbered or bulleted entry becomes one item, in
  the order they are written. Do not stop after the first few.
- Each field holds the final value only — never your reasoning, alternatives,
  restatements or commentary. Work it out before you answer, not in the field.
- Transcribe, do not invent. If the handwriting is unclear, use low confidence
  and put your best reading in term.
- Never invent a Vietnamese gloss, an example, or a pattern that is not in the photo.
- Do not supply pronunciation or CEFR level; those are verified elsewhere.
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
async function askModel(model, image, env, fetchImpl) {
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
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
  } catch {
    return { status: 0, ms: Date.now() - started };   // timed out or unreachable
  }

  if (!res.ok) return { status: res.status, ms: Date.now() - started, detail: await reason(res, env) };
  return { status: 200, ms: Date.now() - started, payload: await res.json() };
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
  if (env.GEMINI_API_KEY) clean = clean.split(env.GEMINI_API_KEY).join('<key>');
  return clean.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, '<data>').replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * Turn a photo into draft items, asking each model in turn until one answers.
 * The chain is the retry: a busy model is rarely free a second later.
 */
export async function draftFromImage(image, env, { fetchImpl = fetch } = {}) {
  if (!env.GEMINI_API_KEY) throw new GeminiError('image reading is not configured', 503);

  const chain = env.GEMINI_MODEL
    ? [env.GEMINI_MODEL, ...MODEL_CHAIN.filter((m) => m !== env.GEMINI_MODEL)]
    : MODEL_CHAIN;

  let refused = 0;      // a 4xx: the service looked at the request and said no
  let exhausted = 0;    // models with nothing left in today's free quota
  const startedAt = Date.now();
  const attempts = [];  // what every model said, for the log and the UI

  // Attached to the error so the caller can record why this failed.
  const give = (message, status) => Object.assign(new GeminiError(message, status), { attempts });

  for (const model of chain) {
    if (Date.now() - startedAt > CHAIN_DEADLINE_MS) break;
    const { status, ms, detail, payload } = await askModel(model, image, env, fetchImpl);
    attempts.push({ model, status, ms, ...(detail ? { detail } : {}) });
    if (status === 200) return { items: parseItems(payload), model, attempts };
    if (status === RATE_LIMITED) exhausted += 1;
    else if (!isTransient(status)) refused = status;
  }

  // The status is in the message on purpose: it is the one fact that tells a
  // refusal apart from an outage when this is reported second-hand.
  if (refused) throw give(`the image service could not read that photo (${refused})`, 502);
  if (exhausted === chain.length) {
    throw give("today's free quota for reading photos is used up - it resets "
      + 'tomorrow, or you can type the word in instead', RATE_LIMITED);
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
