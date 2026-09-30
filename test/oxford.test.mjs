// The parser, against markup Oxford actually served - a stub I wrote myself
// would only prove my regex matches my stub.
import fs from 'node:fs';
import { parseEntry, slugsFor, lookup } from '../worker/src/oxford.js';

let pass = 0, fail = 0;
const ok = (n, c, x = '') => { if (c) pass++; else { fail++; console.log('  FAIL:', n, x); } };
const eq = (n, a, b) => ok(n, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('== a real Oxford page ==');
{
  const html = fs.readFileSync(new URL('./fixtures/oxford-vandal.html', import.meta.url), 'utf8');
  const e = parseEntry(html);
  eq('the British IPA, first of the two', e.ipa, '/ˈvændl/');
  eq('the CEFR badge', e.cefr, 'b2');
  eq('the first definition, in Oxford\'s wording', e.meaning,
     'a person who deliberately destroys or damages public property');
  ok('tags are stripped out of it', !/[<>]/.test(e.meaning), e.meaning);
}

console.log('== the slugs worth trying ==');
{
  eq('a plain word first', slugsFor('vandal')[0], 'vandal');
  eq('  then the numbered entries', slugsFor('vandal')[1], 'vandal_1');
  eq('a leading article is dropped', slugsFor('a dark horse')[0], 'dark-horse');
  eq('a phrasal verb hyphenates', slugsFor('abide by')[0], 'abide-by');
  eq('punctuation goes', slugsFor("don't panic")[0], 'dont-panic');
  eq('nothing usable gives nothing to try', slugsFor('  ').length, 0);
}

console.log('== looking a word up ==');
{
  const page = (body) => ({ ok: true, status: 200, text: async () => body });
  const miss = { ok: false, status: 404, text: async () => '' };

  const asked = [];
  const entry = await lookup('fine', { fetchImpl: async (url) => {
    asked.push(url.split('/').pop());
    return url.endsWith('fine_3')
      ? page('<span class="phon">/faɪn/</span><a href="?level=c1">x</a>'
           + '<span class="def">a sum of money that must be paid as punishment</span>')
      : miss;
  }});
  eq('it keeps trying the numbered entries', asked.length, 4);
  eq('  and takes the one that answers', entry.meaning, 'a sum of money that must be paid as punishment');
  eq('  recording which page it read', entry.slug, 'fine_3');

  const none = await lookup('go everywhere easily', { fetchImpl: async () => miss });
  eq('a phrase with no entry returns nothing, not a guess', none, null);

  const broken = await lookup('vandal', { fetchImpl: async () => { throw new Error('offline'); } });
  eq('a network failure is no verdict either', broken, null);

  // A page that renders but carries no definition is not an answer.
  const shell = await lookup('vandal', { fetchImpl: async () => page('<html><body>nope</body></html>') });
  eq('an empty shell is not mistaken for an entry', shell, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
