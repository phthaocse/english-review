// Oxford Learner's Dictionaries, read straight off the page.
//
// The definition a learner sees should be the one the dictionary prints, not a
// model's paraphrase of it. A paraphrase is different every run and cannot be
// checked; the printed string is the same every time and carries a URL. The
// page is server-rendered, so a plain fetch is enough - no browser, no model,
// no API quota. Verified from a Cloudflare edge node, which Oxford serves the
// same as a laptop.

const BASE = 'https://www.oxfordlearnersdictionaries.com/definition/english/';

// Oxford serves the full entry to a browser user agent and a shell to anything
// that looks automated.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
             + ' (KHTML, like Gecko) Chrome/120 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
};

const LOOKUP_TIMEOUT_MS = 8_000;

/**
 * The URLs worth trying for one term, in order.
 *
 * Entries that share a spelling across parts of speech are disambiguated by a
 * numeric suffix - `fine_1` is the adjective, `fine_3` the penalty - and the
 * bare slug then 404s or lands on the wrong word class. Phrasal verbs hyphenate.
 */
export function slugsFor(term) {
  const base = term.trim().toLowerCase()
    .replace(/^(a|an|the)\s+/, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-');
  if (!base) return [];
  return [base, `${base}_1`, `${base}_2`, `${base}_3`];
}

const strip = (html) => html
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** What the entry page prints. Null for anything the page does not show. */
export function parseEntry(html) {
  // The first .phon is British, the second American; the vault uses British.
  const ipa = html.match(/class="phon">([^<]*)</)?.[1] || null;
  const defs = [...html.matchAll(/class="def"[^>]*>(.*?)<\/span>/gs)].map((m) => strip(m[1]));
  // The level badge comes from the Oxford 3000/5000 links, which cover only
  // about 5000 headwords - absent means unlisted, not unknown.
  const cefr = html.match(/level=([a-c][12])/i)?.[1]?.toLowerCase() || null;
  const pos = strip(html.match(/class="pos">([^<]*)</)?.[1] || '') || null;
  if (!defs.length && !ipa) return null;
  return { ipa, cefr, pos, meaning: defs[0] || null, senseCount: defs.length };
}

/**
 * Look one term up. Returns null when Oxford has no entry for it, which is the
 * normal answer for a collocation or a phrase the writer made up - a blank the
 * reviewer can see beats a definition nobody checked.
 */
export async function lookup(term, { fetchImpl = fetch } = {}) {
  for (const slug of slugsFor(term)) {
    let res;
    try {
      res = await fetchImpl(BASE + encodeURIComponent(slug), {
        headers: HEADERS, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
    } catch {
      return null;                       // timeout or network: no verdict, not a wrong one
    }
    if (!res.ok) continue;
    const entry = parseEntry(await res.text());
    if (entry?.meaning) return { ...entry, url: BASE + slug, slug };
  }
  return null;
}

const SENSE_WINDOW_CHARS = 8_000;
const MAX_EXAMPLES = 4;

/**
 * The sense an Oxford word-list link points at: `bit_1#bit_sng_1` is one
 * phrase inside a long entry, so reading from the anchor keeps its definition
 * and examples rather than the headword's first sense.
 */
export function parseSense(html, anchor = null) {
  const anchored = anchor ? html.indexOf(`id="${anchor}"`) : -1;
  const from = anchored >= 0 ? anchored : Math.max(0, html.search(/<li class="sense"|class="def"/));
  let slice = html.slice(from, from + SENSE_WINDOW_CHARS);
  // Stop at the next sense, so its examples are not mistaken for this one's.
  const next = slice.slice(1).search(/<li class="sense"|class="idm-g"/);
  if (next > 0) slice = slice.slice(0, next + 1);

  const meaning = strip(slice.match(/class="def"[^>]*>(.*?)<\/span>/s)?.[1] || '') || null;
  const examples = [...slice.matchAll(/<span class="x">(.*?)<\/span><\/li>/gs)]
    .map((m) => strip(m[1])).filter(Boolean).slice(0, MAX_EXAMPLES);
  const ipa = html.match(/class="phon">([^<]*)</)?.[1] || null;
  if (!meaning) return null;
  return { meaning, examples, ipa };
}

/** Read the sense behind a word-list path such as `/definition/english/bit_1#bit_sng_1`. */
export async function fetchSense(path, { fetchImpl = fetch } = {}) {
  const [page, anchor] = path.split('#');
  const url = 'https://www.oxfordlearnersdictionaries.com' + page;
  try {
    const res = await fetchImpl(url, { headers: HEADERS, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    if (!res.ok) return null;
    const sense = parseSense(await res.text(), anchor || null);
    return sense ? { ...sense, url: url + (anchor ? `#${anchor}` : '') } : null;
  } catch {
    return null;                         // no verdict, not a wrong one
  }
}

/**
 * Fill a batch of drafts in from Oxford, in order, keeping the model's own
 * wording only where Oxford has nothing. `verified` is what tells the reviewer
 * which is which.
 */
export async function verifyAll(items, { fetchImpl = fetch, limit = 40 } = {}) {
  const out = [];
  for (const item of items.slice(0, limit)) {
    const entry = await lookup(item.term, { fetchImpl });
    out.push(entry
      ? { ...item, meaning: entry.meaning, ipa: entry.ipa, cefr: entry.cefr,
          oxford_url: entry.url, senses: entry.senseCount, verified: true }
      : { ...item, verified: false });
  }
  return [...out, ...items.slice(limit)];
}
