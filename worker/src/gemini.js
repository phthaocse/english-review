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
const DEFAULT_MODEL = 'gemini-3.8-flash';

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
- source_note: any context the writer recorded about where they met it
- confidence: high, medium or low — how sure you are you read the handwriting correctly

Rules:
- Transcribe, do not invent. If the handwriting is unclear, use low confidence
  and put your best reading in term.
- Never invent a Vietnamese gloss or an example that is not in the photo.
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

/**
 * Turn a photo into draft items. Never throws the API key into a message.
 *
 * @param {{base64: string, mimeType: string}} image
 */
export async function draftFromImage(image, env, { fetchImpl = fetch } = {}) {
  if (!env.GEMINI_API_KEY) throw new GeminiError('image reading is not configured', 503);

  const body = {
    model: env.GEMINI_MODEL || DEFAULT_MODEL,
    input: [
      { type: 'text', text: PROMPT },
      { type: 'image', data: image.base64, mime_type: image.mimeType },
    ],
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: RESPONSE_SCHEMA,
    },
  };

  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GeminiError('could not reach the image service', 502);
  }

  if (!res.ok) {
    // Upstream errors can echo the request back. Log a bare status and tell the
    // client nothing that could carry the key.
    console.error('gemini request failed', res.status);
    throw new GeminiError(res.status === 429
      ? 'the image service is rate limiting; try again shortly'
      : 'the image service rejected the request', res.status === 429 ? 429 : 502);
  }

  const payload = await res.json();
  return { items: parseItems(payload) };
}

/** Pull the model's JSON out of whichever field carries it, and sanity-check it. */
export function parseItems(payload) {
  const text = payload?.output_text
    ?? payload?.output?.[0]?.content?.[0]?.text
    ?? payload?.candidates?.[0]?.content?.parts?.[0]?.text;

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
      term: i.term.trim(),
      kind: KINDS.includes(i.kind) ? i.kind : 'word',
      meaning: i.meaning?.trim() || null,
      vi: i.vi?.trim() || null,
      example: i.example?.trim() || null,
      source_note: i.source_note?.trim() || null,
      confidence: ['high', 'medium', 'low'].includes(i.confidence) ? i.confidence : 'low',
    }));
}
