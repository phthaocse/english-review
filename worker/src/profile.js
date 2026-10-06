// What an Oxford entry page says that a question can be built on, and the
// checklist of things to test, most important first.

import { strip } from './oxford.js';

export const PARSER_VERSION = 2;
// Four tests per word (first sight plus three days) at two questions each.
export const CHECKLIST_SIZE = 8;
const EXAMPLES_KEPT_PER_POINT = 3;

const all = (html, re) => [...html.matchAll(re)].map((m) => strip(m[1])).filter(Boolean);
const first = (html, re) => strip(html.match(re)?.[1] || '') || null;

/** One example line: the pattern it illustrates, its text, and Oxford's bold collocations in it. */
function parseExample(li) {
  const x = li.match(/<span class="x">([\s\S]*)<\/span>/)?.[1];
  if (!x) return null;
  return {
    pattern: first(li, /class="cf"[^>]*>([\s\S]*?)<\/span>/),
    text: strip(x),
    highlights: all(x, /class="cl"[^>]*>([\s\S]*?)<\/span>/g),
  };
}

function parseSenseBlock(block) {
  const ul = block.indexOf('<ul class="examples"');
  const head = ul >= 0 ? block.slice(0, ul) : block;
  // Extra examples sit in a collapsed box after the list; they are not the entry's own selection.
  const list = ul >= 0 ? block.slice(ul, block.indexOf('</ul>', ul)) : '';
  return {
    cefr: block.match(/^[^>]*cefr="([a-c][12])"/)?.[1] || null,
    def: first(head, /class="def"[^>]*>([\s\S]*?)<\/span>\s*(?:<|$)/) || first(head, /class="def"[^>]*>([\s\S]*?)<\/span>/),
    grammar: first(head, /class="grammar"[^>]*>([\s\S]*?)<\/span>/),
    labels: first(head, /class="labels"[^>]*>([\s\S]*?)<\/span>/),
    use: first(head, /class="use"[^>]*>([\s\S]*?)<\/span>\s*<span class="def/),
    examples: list.split(/<li\b/).slice(1).map(parseExample).filter(Boolean),
  };
}

/** Senses, patterns, collocations and idioms from one entry page. Null when the page has no senses. */
export function parseProfile(html) {
  const idiomsAt = html.search(/<(?:div|span) class="idioms"/);
  const main = idiomsAt >= 0 ? html.slice(0, idiomsAt) : html;
  const senses = main.split('<li class="sense"').slice(1)
    .map(parseSenseBlock).filter((s) => s.def)
    .map((s, i) => ({ n: i + 1, ...s }));

  const idioms = idiomsAt < 0 ? [] : html.slice(idiomsAt).split('<span class="idm-g"').slice(1).map((g) => {
    const sense = g.includes('<li class="sense"') ? parseSenseBlock(g.split('<li class="sense"')[1]) : null;
    return {
      phrase: first(g, /class="idm"[^>]*>([\s\S]*?)<\/span>/),
      cefr: g.match(/class="idm"[^>]*cefr="([a-c][12])"/)?.[1] || null,
      def: sense?.def || first(g, /class="def"[^>]*>([\s\S]*?)<\/span>/),
      examples: sense?.examples || [],
    };
  }).filter((i) => i.phrase && i.def);

  // Entries like "rely" keep their meanings on separate phrasal-verb pages ("rely on").
  const pvList = html.match(/<ul class="pvrefs">([\s\S]*?)<\/ul>/)?.[1] || '';
  const phrasalVerbs = [...pvList.matchAll(/href="([^"#]+)[^"]*"[^>]*title="([^"]+?) definition"/g)]
    .map((m) => ({ phrase: strip(m[2]), url: m[1] }));

  if (!senses.length && !idioms.length && !phrasalVerbs.length) return null;

  return {
    // Oxford numbers homographs ("content" 1 and 2) inside the headword.
    headword: first(html.replace(/<span class="hm"[^>]*>\d+<\/span>/g, ''), /<h1 class="headword"[^>]*>([\s\S]*?)<\/h1>/),
    pos: first(html, /class="pos"[^>]*>([\s\S]*?)<\/span>/)?.replace(/,$/, '') || null,
    ipa: html.match(/class="phon">([^<]*)</)?.[1] || null,
    senses,
    idioms,
    phrasalVerbs,
  };
}

/**
 * Give an entry with no meanings of its own the meanings of its phrasal verbs.
 * "X upon" repeats "X on" in Oxford, so it is left out.
 */
export function mergePhrasal(profile, pvProfiles) {
  if (profile.senses.length) return profile;
  const senses = [];
  for (const { phrase, profile: pv } of pvProfiles) {
    if (!pv || / upon$/.test(phrase)) continue;
    for (const s of pv.senses) senses.push({ ...s, n: senses.length + 1, phrase });
  }
  return { ...profile, senses };
}

/**
 * The checklist, most important first: the core meaning, then how it is built
 * (patterns) and what it goes with (collocations), then its other meanings.
 * Everything is kept; only the first CHECKLIST_SIZE count towards mastery.
 */
export function pointsFrom(profile) {
  const points = [];
  const seen = new Set();
  const add = (rank, point) => {
    if (seen.has(point.key)) return;
    seen.add(point.key);
    points.push({ rank, ...point });
  };
  for (const s of profile.senses) {
    const core = s.n === 1;
    add(core ? 0 : s.cefr ? 3 : 5, {
      key: `sense:${s.n}`, kind: 'sense', sense: s.n, cefr: s.cefr, def: s.def,
      ...(s.phrase ? { phrase: s.phrase } : {}),
      grammar: s.grammar, labels: s.labels,
      examples: s.examples.map((e) => e.text).slice(0, EXAMPLES_KEPT_PER_POINT),
    });
    for (const e of s.examples) {
      if (e.pattern) {
        add(core ? 1 : 4, { key: `pattern:${e.pattern}`, kind: 'pattern', sense: s.n, pattern: e.pattern, def: s.def,
                            examples: s.examples.filter((x) => x.pattern === e.pattern).map((x) => x.text)
                              .slice(0, EXAMPLES_KEPT_PER_POINT) });
      }
      for (const h of e.highlights) {
        add(core ? 2 : 4, { key: `colloc:${h}`, kind: 'collocation', sense: s.n, collocation: h, def: s.def,
                            examples: [e.text] });
      }
    }
  }
  const idiomsLead = !profile.senses.length;
  profile.idioms.forEach((i, k) => add(idiomsLead ? (k === 0 ? 0 : 3) : 5, {
    key: `idiom:${i.phrase}`, kind: 'idiom', phrase: i.phrase, def: i.def, cefr: i.cefr,
    examples: (i.examples || []).map((e) => e.text).slice(0, EXAMPLES_KEPT_PER_POINT),
  }));
  return points.sort((a, b) => a.rank - b.rank);
}
