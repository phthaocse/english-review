// Read every entry in a study set from Oxford and turn it into SQL for D1.
//
// Pages are cached under tools/oxford/pages/ (git-ignored), so a re-run or a
// parser change never fetches a page twice; requests are spaced out so the
// dictionary is read at a person's pace, not a crawler's.
//
//   node tools/oxford_profiles.mjs [collection]
//   cd worker && wrangler d1 execute knowledge --remote --file ../tools/oxford/<collection>-profiles.sql

import fs from 'node:fs';
import path from 'node:path';
import { parseProfile, pointsFrom, mergePhrasal, PARSER_VERSION, CHECKLIST_SIZE } from '../worker/src/profile.js';

const COLLECTION = process.argv[2] || 'core-1000';
const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'oxford');
const PAGES = path.join(DIR, 'pages');
const PAUSE_MS = 1200;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
             + ' (KHTML, like Gecko) Chrome/126 Safari/537.36',
  'Accept-Language': 'en-GB,en;q=0.9',
};

const sql = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readCsv(file) {
  const [head, ...lines] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const keys = head.split(',');
  return lines.map((line) => Object.fromEntries(line.split(',').map((v, i) => [keys[i], v])));
}

async function page(url) {
  const file = path.join(PAGES, `${url.split('/').pop().replace(/[^a-z0-9_-]/gi, '_')}.html`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  for (let attempt = 1; attempt <= 2; attempt++) {
    await sleep(PAUSE_MS * attempt);
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
      if (res.ok) {
        const html = await res.text();
        fs.writeFileSync(file, html);
        return html;
      }
      if (res.status === 404) return null;
    } catch { /* retried once, then reported */ }
  }
  return null;
}

fs.mkdirSync(PAGES, { recursive: true });
const words = readCsv(path.join(DIR, `${COLLECTION}.csv`));
const out = fs.createWriteStream(path.join(DIR, `${COLLECTION}-profiles.sql`));
const failed = [];
const sizes = [];

for (const [i, w] of words.entries()) {
  const html = await page(w.url);
  let profile = html && parseProfile(html);
  if (profile && !profile.senses.length && profile.phrasalVerbs.length) {
    const pvs = [];
    for (const pv of profile.phrasalVerbs) {
      const pvHtml = await page(pv.url);
      pvs.push({ phrase: pv.phrase, profile: pvHtml && parseProfile(pvHtml) });
    }
    profile = mergePhrasal(profile, pvs);
  }
  if (!profile || (!profile.senses.length && !profile.idioms.length)) {
    failed.push(`${w.word} (${w.pos}) ${w.url}`);
    continue;
  }
  const points = pointsFrom(profile);
  sizes.push(Math.min(points.length, CHECKLIST_SIZE));
  const entryPath = new URL(w.url).pathname;
  out.write('INSERT OR REPLACE INTO word_profile (entry_id, profile, points, parser_version) '
    + `SELECT id, ${sql(JSON.stringify(profile))}, ${sql(JSON.stringify(points))}, ${PARSER_VERSION} `
    + `FROM oxford_entry WHERE list = 'word' AND term = ${sql(w.word)} AND path = ${sql(entryPath)};\n`);
  if ((i + 1) % 50 === 0) console.log(`${i + 1}/${words.length} read, ${failed.length} failed`);
}
out.end();

const histogram = sizes.reduce((h, n) => ({ ...h, [n]: (h[n] || 0) + 1 }), {});
console.log(`done: ${sizes.length} profiles, ${failed.length} failed`);
console.log('checklist sizes:', JSON.stringify(histogram));
if (failed.length) console.log('failed:\n  ' + failed.join('\n  '));
