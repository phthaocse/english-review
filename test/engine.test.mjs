import { grade, normalise, levenshtein, applyRating, loadProgress, cardFor,
         buildQueue, isNew, isDue, stats, Rating, State, LEVELS } from '../review.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra='') => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, extra); } };
const eq = (name, a, b) => ok(name, a === b, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

console.log('== normalise / levenshtein ==');
eq('case+punct', normalise('It **Turned**, out.'), 'it **turned** out');
eq('smart quote', normalise('don’t'), "don't");
eq('lev same', levenshtein('abc','abc'), 0);
eq('lev one', levenshtein('accuse','accusa'), 1);

console.log('== grading ==');
let g = grade('turned out', ['turned out'], 9000);
eq('exact slow -> Good', g.rating, Rating.Good);
eq('exact verdict', g.verdict, 'exact');

g = grade('turned out', ['turned out'], 1200);
eq('exact fast -> Easy', g.rating, Rating.Easy);

g = grade('  Turned  Out. ', ['turned out'], 9000);
eq('normalised exact', g.verdict, 'exact');

g = grade('accusd', ['accused'], 9000);
eq('typo -> Hard', g.rating, Rating.Hard);
eq('typo verdict', g.verdict, 'typo');

g = grade('accuse', ['accused'], 9000);
eq('wrong inflection -> form, not typo', g.verdict, 'form');
eq('wrong inflection -> Hard', g.rating, Rating.Hard);
eq('-e dropped on inflection', grade('use', ['used'], 9000).rating, Rating.Again);  // too short to stem
eq('longer -e stem matches', grade('argue', ['argued'], 9000).verdict, 'form');
eq('plural stem matches', grade('base', ['bases'], 9000).verdict, 'form');
eq('a real typo is still a typo', grade('accusd', ['accused'], 9000).verdict, 'typo');
eq('irregulars fall through', grade('go', ['went'], 9000).verdict, 'wrong');

g = grade('celebrate', ['accused'], 9000);
eq('plain wrong -> Again', g.rating, Rating.Again);
eq('wrong verdict', g.verdict, 'wrong');

g = grade('', ['accused'], 500);
eq('empty -> Again', g.rating, Rating.Again);

// short word must not accept a 1-edit neighbour as a typo
g = grade('cat', ['cut'], 9000);
eq('short near-miss is NOT forgiven', g.verdict, 'wrong');
g = grade('disingenous', ['disingenuous'], 9000);
eq('long word typo forgiven', g.verdict, 'typo');

g = grade('went off', ['turned out','went off'], 9000);
eq('multi-accepted second form', g.matched, 'went off');

console.log('== scheduling ladder ==');
const p = loadProgress();
const id = 'turn out';
cardFor(p, id);
eq('starts at recognise', p.cards[id].level, 0);
eq('starts New', p.cards[id].card.state, State.New);

applyRating(p, id, Rating.Good, {mode:'recognise'});
eq('one good: still level 0', p.cards[id].level, 0);
applyRating(p, id, Rating.Good, {mode:'recognise'});
eq('two goods: promoted', p.cards[id].level, 1);
eq('streak reset on promote', p.cards[id].streak, 0);

applyRating(p, id, Rating.Again, {mode:'gapfill'});
eq('lapse demotes', p.cards[id].level, 0);
eq('lapse counted', p.cards[id].lapses, 1);
eq('streak cleared', p.cards[id].streak, 0);

ok('due date is a real date', !isNaN(new Date(p.cards[id].card.due).getTime()));
ok('no longer New', p.cards[id].card.state !== State.New);
ok('history recorded', p.history.length === 3, `len=${p.history.length}`);

console.log('== interval sanity (FSRS) ==');
const p2 = loadProgress(); p2.cards = {};
cardFor(p2,'x');
const before = new Date();
applyRating(p2,'x',Rating.Easy,{});
const easyDue = new Date(p2.cards['x'].card.due);
const p3 = loadProgress(); p3.cards={}; cardFor(p3,'y');
applyRating(p3,'y',Rating.Again,{});
const againDue = new Date(p3.cards['y'].card.due);
ok('Easy schedules further out than Again', easyDue > againDue, `${easyDue.toISOString()} vs ${againDue.toISOString()}`);
ok('Again is soon (< 1 day)', (againDue - before) < 24*3600*1000);

console.log('== queue ==');
const items = [
  {id:'a', type:'word', priority:'high', added:'2026-09-23'},
  {id:'b', type:'word', priority:'normal', added:'2026-09-21'},
  {id:'c', type:'idiom', priority:'high', added:'2026-09-22'},
];
const p4 = loadProgress(); p4.cards={};
let q = buildQueue(items, p4, {limit:10});
eq('all new are queued', q.length, 3);
eq('high priority first', q[0].id, 'a');
q = buildQueue(items, p4, {limit:10, kinds:['idiom']});
eq('kind filter', q.map(x=>x.id).join(','), 'c');
q = buildQueue(items, p4, {limit:2});
eq('limit respected', q.length, 2);

// With a review waiting, the new-item cap protects it.
const p7 = loadProgress(); p7.cards = {};
const many = Array.from({length:30},(_,i)=>({id:'w'+i,type:'word',priority:'normal',added:'2026-09-01'}));
applyRating(p7,'w0',Rating.Again,{});
// An 'Again' card is due a minute later, so backdate it to make it genuinely overdue.
p7.cards['w0'].card.due = new Date(Date.now() - 3600e3).toISOString();
let q7 = buildQueue(many, p7, {limit:10});
ok('session filled to the requested length', q7.length === 10, `len=${q7.length}`);
eq('the overdue item comes first', q7[0].id, 'w0');
const freshCount = q7.filter(x=>isNew(p7,x.id)).length;
eq('the rest are new items', freshCount, 9);

const s = stats(items, p4);
eq('stats total', s.total, 3);
eq('stats fresh', s.fresh, 3);


console.log('== strict (punctuation drills) ==');
const splice = 'It turned out to be a config problem. The retry never fired.';
const wrongSplice = 'It turned out to be a config problem, the retry never fired.';
let sg = grade(wrongSplice, [splice], 9000, {strict:true});
eq('comma splice rejected in strict mode', sg.verdict, 'wrong');
sg = grade(splice, [splice], 9000, {strict:true});
eq('correct punctuation accepted', sg.verdict, 'exact');
sg = grade(wrongSplice, [splice], 9000);
eq('non-strict would wrongly accept it', sg.verdict, 'exact');
sg = grade('It turned out to be a config problem; the retry never fired.',
           [splice, 'It turned out to be a config problem; the retry never fired.'], 9000, {strict:true});
eq('any listed correct form accepted', sg.verdict, 'exact');

console.log('== maxLevel cap ==');
const p5 = loadProgress(); p5.cards = {};
cardFor(p5,'drill');
applyRating(p5,'drill',Rating.Good,{maxLevel:1});
applyRating(p5,'drill',Rating.Good,{maxLevel:1});
eq('promoted to 1', p5.cards['drill'].level, 1);
applyRating(p5,'drill',Rating.Good,{maxLevel:1});
applyRating(p5,'drill',Rating.Good,{maxLevel:1});
eq('capped at maxLevel', p5.cards['drill'].level, 1);
const p6 = loadProgress(); p6.cards = {};
cardFor(p6,'pron');
applyRating(p6,'pron',Rating.Good,{maxLevel:0});
applyRating(p6,'pron',Rating.Good,{maxLevel:0});
eq('maxLevel 0 never promotes', p6.cards['pron'].level, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
