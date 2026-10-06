// Write and check the questions for a few words against the real model, and
// print them for a person to read before any of it is trusted.
//
//   node tools/bank_try.mjs convince imply
//   (writes tools/oxford/bank-sample.sql for `wrangler d1 execute`)

import fs from 'node:fs';
import path from 'node:path';
import { parseProfile, pointsFrom } from '../worker/src/profile.js';
import { buildBank } from '../worker/src/bank.js';

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), 'oxford');
const secret = (name) => fs.readFileSync(`${process.env.HOME}/.config/knowledge/secrets.env`, 'utf8')
  .split('\n').find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).trim();
const env = { GEMINI_API_KEY: secret('GEMINI_API_KEY'), GEMINI_API_KEY_2: secret('GEMINI_API_KEY_2') };
const sql = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const rows = fs.readFileSync(path.join(DIR, 'core-1000.csv'), 'utf8').trim().split(/\r?\n/).slice(1)
  .map((l) => { const [word, pos, level, url] = l.split(','); return { word, pos, level, url }; });

async function html(url) {
  const file = path.join(DIR, 'pages', `${url.split('/').pop().replace(/[^a-z0-9_-]/gi, '_')}.html`);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/126 Safari/537.36' } });
  const text = await res.text();
  fs.writeFileSync(file, text);
  return text;
}

const words = [];
for (const [i, term] of process.argv.slice(2).entries()) {
  const row = rows.find((r) => r.word === term);
  if (!row) throw new Error(`${term} is not in core-1000`);
  const points = pointsFrom(parseProfile(await html(row.url)));
  words.push({ id: i + 1, term, pos: row.pos, level: row.level, path: new URL(row.url).pathname, points });
}

const started = Date.now();
const bank = await buildBank(words, env);
console.log(`model ${bank.model} · ${((Date.now() - started) / 1000).toFixed(0)}s · ${bank.items.length} kept, ${bank.dropped} malformed\n`);

for (const m of bank.malformed) console.log('MALFORMED', JSON.stringify(m).slice(0, 400));
const letter = (i) => 'ABC'[i];
for (const w of words) {
  console.log(`=== ${w.term} (${w.pos}, ${w.level.toUpperCase()})`);
  for (const it of bank.items.filter((x) => x.entry_id === w.id)) {
    const mark = it.status === 'verified' ? '✓' : '✗';
    console.log(`${mark} [${it.point_key}] ${it.type}${it.status === 'rejected' ? `  — ${it.verify_note}` : ''}`);
    if (it.stem) console.log(`    ${it.stem}`);
    if (it.instruction) console.log(`    ${it.instruction}`);
    (it.options || []).forEach((o, i) => console.log(`    ${letter(i)}. ${o}${it.answer.index === i ? '   ←' : ''}`));
    if (it.answer.fixes) console.log(`    fix: ${it.answer.wrong_word} → ${it.answer.fixes.join(' / ')}`);
    if (it.answer.model_answers) console.log(`    e.g. ${it.answer.model_answers[0]}`);
  }
}

const out = bank.items.map((it) => {
  const w = words.find((x) => x.id === it.entry_id);
  const body = { stem: it.stem, ...(it.options ? { options: it.options } : {}), ...(it.instruction ? { instruction: it.instruction } : {}) };
  return 'INSERT INTO quiz_item (entry_id, point_key, type, body, answer, status, verify_note, model) '
    + `SELECT id, ${sql(it.point_key)}, ${sql(it.type)}, ${sql(JSON.stringify(body))}, ${sql(JSON.stringify(it.answer))}, `
    + `${sql(it.status)}, ${sql(it.verify_note)}, ${sql(bank.model)} FROM oxford_entry `
    + `WHERE list = 'word' AND term = ${sql(w.term)} AND path = ${sql(w.path)};`;
});
fs.appendFileSync(path.join(DIR, 'bank-sample.sql'), out.join('\n') + '\n');
