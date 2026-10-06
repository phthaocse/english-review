// Today: ten words from the Oxford 1,000, two short questions each.
//
// The first question is a quick check; miss it and the word stops there with
// its learning card. Get it right and the second asks for one short piece of
// production. Keyed answers are marked by the Worker at once; sentences and
// rewrites are marked together at the end. Keys never reach this page.

import { api, ApiError } from './auth-client.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const message = (e, fallback) => (e instanceof ApiError ? e.message : fallback);

const FEATURES = [
  ['meaning', 'Precise meaning'], ['accuracy', 'Grammar of the word'], ['collocation', 'Collocation'],
  ['paraphrase', 'Paraphrase'], ['use', 'Using it in a sentence'],
];
const LEVELS = ['a1', 'a2', 'b1', 'b2', 'c1'];
const KIND_LABEL = { sense: 'meaning', pattern: 'pattern', collocation: 'collocation', idiom: 'idiom' };

let data = null;          // the overview
let screen = 'overview';  // overview | question | feedback | marking | ielts
let current = null;       // the question on screen
let feedback = null;      // what the Worker said about the last answer
let marked = null;        // results of the last marking
let ielts = null;         // the open IELTS task, and its result once answered
let busy = null;
let error = null;
let preparing = { running: false, note: null };
let shownAt = 0;
let view = null;

const here = () => location.hash.startsWith('#/today');

async function load() {
  data = await api('/api/check');
}

export async function renderToday(target) {
  view = target;
  if (!data && !busy) {
    busy = 'loading';
    draw();
    try {
      await load();
      error = null;
    } catch (e) {
      error = message(e, 'could not load today\'s words');
    }
    busy = null;
    if (!here()) return;
    prepareWaiting();
  }
  draw();
}

function draw() {
  if (!view || !here()) return;
  if (busy === 'loading') {
    view.innerHTML = '<h2 class="section">Today</h2><p class="lede">Dealing today\'s words…</p>';
    return;
  }
  if (!data) {
    view.innerHTML = `<h2 class="section">Today</h2><p class="empty">${esc(error || 'Nothing to show.')}</p>`;
    return;
  }
  ({ overview: drawOverview, question: drawQuestion, feedback: drawFeedback,
     marking: drawMarking, ielts: drawIelts })[screen]();
}

// ------------------------------------------------------- background work --

/** Write questions for dealt words that have none yet, one word per request. */
async function prepareWaiting() {
  if (preparing.running || !data?.waiting) return;
  preparing = { running: true, note: null };
  try {
    while (data.waiting > 0) {
      const res = await api('/api/check/prepare', { method: 'POST' });
      if (!res.prepared) break;
      await load();
      if (screen === 'overview') draw();
    }
  } catch (e) {
    preparing.note = message(e, 'could not write questions right now');
  }
  preparing.running = false;
  if (screen === 'overview') draw();
}

// --------------------------------------------------------------- overview --

function drawOverview() {
  const t = data.totals;
  view.innerHTML = `
    <h2 class="section">Today</h2>
    <p class="lede">Ten words from your Oxford 1,000. A quick check, then one short thing to produce.
      Miss the check and the word stops there for today.</p>

    <div class="statgrid">
      <div class="card stat ${data.left ? 'is-due' : ''}"><b>${data.left}</b><span>to check</span></div>
      <div class="card stat"><b>${t.masteredToday}</b><span>mastered today</span></div>
      <div class="card stat"><b>${t.mastered}</b><span>mastered of ${t.of}</span></div>
      <div class="card stat"><b>${t.active}</b><span>in play</span></div>
    </div>
    ${error ? `<p class="verdict wrong">${esc(error)}</p>` : ''}
    ${data.waiting ? `<p class="verdict typo">${data.waiting} word${data.waiting === 1 ? ' is' : 's are'} still
      waiting for questions${preparing.running ? ' — writing them now, about 40 seconds each' : ''}.
      ${preparing.note ? `${esc(preparing.note)}. They will be ready after tonight's run.` : ''}</p>` : ''}

    <div class="card block">
      ${data.left ? `<button class="btn" id="start">Start · ${data.left} word${data.left === 1 ? '' : 's'}</button>
        <p class="next-hint">About 45 seconds a word. Sentences are marked together at the end.</p>`
        : data.pendingMarks ? `<button class="btn" id="mark">Mark ${data.pendingMarks} answer${data.pendingMarks === 1 ? '' : 's'}</button>`
        : '<p style="margin:0">Done for today. The words you missed are below with what to learn.</p>'}
    </div>

    ${drawIeltsCard()}
    ${marked?.length ? drawResults(marked) : ''}
    <div class="card block"><h3>Your words</h3><div class="results">${data.words.map(drawWord).join('')}</div></div>
    ${drawProgress()}`;

  view.querySelector('#start')?.addEventListener('click', () => openQuestion());
  view.querySelector('#mark')?.addEventListener('click', () => { screen = 'marking'; draw(); });
  view.querySelector('#ielts-new')?.addEventListener('click', newIelts);
  view.querySelector('#ielts-open')?.addEventListener('click', () => { screen = 'ielts'; draw(); });
}

function drawIeltsCard() {
  const s = data.ielts;
  if (!s || s.state === 'later') return '';
  if (s.state === 'ready') {
    return `<div class="card block"><h3>IELTS practice</h3>
      <p style="margin:0 0 10px">A short reading task with your recent words is ready.</p>
      <button class="btn secondary" id="ielts-open">Open it</button></div>`;
  }
  return `<div class="card block"><h3>IELTS practice</h3>
    <p style="margin:0 0 10px">A short IELTS-format reading task over your recent words is due — about 5 minutes.</p>
    <button class="btn secondary" id="ielts-new" ${busy === 'ielts' ? 'disabled' : ''}>
      ${busy === 'ielts' ? 'Writing it… about a minute' : 'Write today\'s task'}</button></div>`;
}

function drawWord(w) {
  const level = `<span class="pill">${w.level.toUpperCase()}</span>`;
  if (!w.term) {
    return `<div class="result"><div class="result-top"><span class="result-term muted">Hidden until you check it</span>
      ${level}${w.ready ? '' : '<span class="pill warn">questions being written</span>'}</div></div>`;
  }
  const passed = w.checklist.filter((c) => c.passed).length;
  return `<details class="result">
    <summary class="result-top"><span class="result-term">${esc(w.term)}</span>${level}
      <span class="muted">${esc(w.pos || '')}</span>
      <span class="pill ${passed === w.checklist.length ? 'good' : 'accent'}">${passed} of ${w.checklist.length} points</span>
      ${w.passes ? `<span class="pill warn">passed ${w.passes} of ${w.passesNeeded} days</span>` : ''}</summary>
    <div style="margin-top:10px">
      ${w.ipa ? `<p class="result-ipa" style="margin:0">${esc(w.ipa)}</p>` : ''}
      ${w.senses.map((s) => `<p style="margin:6px 0 0">${s.cefr ? `<span class="pill">${s.cefr.toUpperCase()}</span> ` : ''}${esc(s.def)}
        ${s.example ? `<br><span class="muted">${esc(s.example)}</span>` : ''}</p>`).join('')}
      <ul style="margin:12px 0 0; padding-left:20px">${w.checklist.map((c) =>
        `<li>${c.passed ? '✓' : '·'} <span class="muted">${KIND_LABEL[c.kind] || c.kind}:</span> ${esc(c.label)}</li>`).join('')}</ul>
      ${w.today.map((a) => a.feedback ? `<p style="margin:10px 0 0"><b>You wrote:</b> ${esc(a.answer)}<br>${esc(a.feedback)}
        ${a.corrected && a.corrected !== a.answer ? `<br><span class="rightline">→ ${esc(a.corrected)}</span>` : ''}</p>` : '').join('')}
    </div></details>`;
}

function drawProgress() {
  const f = data.features || {};
  const rows = FEATURES.filter(([k]) => f[k]?.n).map(([k, label]) => {
    const pct = Math.round((f[k].right / f[k].n) * 100);
    return `<li>${label}: <b>${pct}%</b> <span class="muted">(${f[k].right} of ${f[k].n})</span></li>`;
  });
  const levels = LEVELS.map((lv) => `${lv.toUpperCase()} ${data.byLevel[lv] || 0}`).join(' · ');
  return `<div class="card block"><h3>Progress</h3>
    <p style="margin:0">Mastered by level: ${levels}
      <span class="muted">— ${data.totals.known} already known, ${data.totals.learnt} learnt here, ${data.totals.self} marked by you</span></p>
    ${rows.length ? `<p style="margin:12px 0 4px">Last 30 days, by IELTS feature:</p><ul style="margin:0; padding-left:20px">${rows.join('')}</ul>`
      : '<p class="muted" style="margin:10px 0 0">Accuracy by IELTS feature appears after your first answers.</p>'}</div>`;
}

function drawResults(list) {
  return `<div class="card block"><h3>Just marked</h3><div class="results">${list.map((r) => `
    <div class="result"><div class="result-top"><span class="result-term">${esc(r.term)}</span>
      <span class="pill ${r.verdict === 'right' ? 'good' : 'bad'}">${r.verdict === 'right' ? 'right' : 'not yet'}</span>
      ${r.mastered ? `<span class="pill good">${r.how === 'known' ? 'you already knew it' : 'learnt'} · dropped</span>` : ''}</div>
      <p class="result-gloss">${esc(r.feedback)}</p>
      ${r.corrected && r.corrected !== r.answer ? `<p class="rightline" style="margin:4px 0 0">→ ${esc(r.corrected)}</p>` : ''}
    </div>`).join('')}</div></div>`;
}

// --------------------------------------------------------------- question --

async function openQuestion() {
  try {
    const next = await api('/api/check/next');
    if (next.done) {
      await load();
      screen = data.pendingMarks ? 'marking' : 'overview';
    } else {
      current = next;
      screen = 'question';
      shownAt = Date.now();
    }
    error = null;
  } catch (e) {
    error = message(e, 'could not load the next question');
    screen = 'overview';
  }
  draw();
}

const STEMS = {
  meaning_mc: (q) => `<p class="prompt">${esc(q.item.stem)}</p><p class="prompt-sub">Here <b>${esc(q.word.term)}</b> means:</p>`,
  pattern_mc: () => '<p class="prompt-sub">Choose the correct sentence:</p>',
  fix_word: (q) => `<p class="prompt">${esc(q.item.stem)}</p>
    <p class="prompt-sub">One word is wrong. Type the word that should replace it.</p>`,
  rewrite: (q) => `<p class="prompt">${esc(q.item.stem)}</p><p class="prompt-sub">${esc(q.item.instruction)}</p>`,
  sentence: (q) => `<p class="prompt">${esc(q.item.stem)}</p><p class="prompt-sub">${esc(q.item.instruction)}</p>`,
};

function drawQuestion() {
  const q = current;
  const typed = q.item.options ? '' : q.item.type === 'fix_word'
    ? '<input class="answer" id="typed" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="the right word">'
    : '<textarea class="answer" id="typed" rows="3" maxlength="400"></textarea>';
  view.innerHTML = `
    <div class="quizbar">
      <div class="progressbar"><i style="width:${q.progress.total ? (q.progress.done / q.progress.total) * 100 : 0}%"></i></div>
      <span class="quizcount">${q.progress.done + 1} / ${q.progress.total}</span>
      <button class="btn secondary small" id="pause">Pause</button></div>
    <div class="card quiz">
      <div class="quiz-mode"><span>${q.slot === 1 ? 'Quick check' : 'Now use it'}</span>
        <span class="pill">${q.word.level.toUpperCase()}</span>${q.slot === 2 ? `<span>${esc(q.word.term)}</span>` : ''}</div>
      ${STEMS[q.item.type](q)}
      ${q.item.options ? `<div class="options">${q.item.options.map((o, i) =>
        `<button class="option" data-choice="${i}">${esc(o)}</button>`).join('')}</div>` : typed}
      ${error ? `<p class="verdict wrong">${esc(error)}</p>` : ''}
      <div class="row" style="margin-top:12px">
        ${q.item.options ? '' : '<button class="btn" id="submit">Next →</button>'}
        <button class="btn secondary" id="skip">${q.slot === 1 ? 'I don\'t know it' : 'I can\'t'}</button>
        ${q.offers.selfKnown ? '<button class="btn secondary" id="known">I know this well</button>' : ''}
      </div>
      <button class="override" id="report">Report this question</button>
    </div>`;

  const send = (body) => submit({ entry_id: q.word.id, ms: Date.now() - shownAt, ...body });
  view.querySelectorAll('[data-choice]').forEach((b) =>
    b.addEventListener('click', () => send({ choice: Number(b.dataset.choice) })));
  const box = view.querySelector('#typed');
  box?.focus();
  view.querySelector('#submit')?.addEventListener('click', () => {
    if (!box.value.trim()) return box.focus();
    send({ text: box.value.trim() });
  });
  if (box?.tagName === 'INPUT') box.addEventListener('keydown', (e) => { if (e.key === 'Enter') view.querySelector('#submit').click(); });
  view.querySelector('#skip').addEventListener('click', () => send({ skipped: true }));
  view.querySelector('#known')?.addEventListener('click', () => send({ selfKnown: true }));
  view.querySelector('#pause').addEventListener('click', async () => { await load(); screen = 'overview'; draw(); });
  view.querySelector('#report').addEventListener('click', reportQuestion);
}

async function submit(body) {
  if (busy) return;
  busy = 'answering';
  try {
    feedback = { ...(await api('/api/check/answer', { method: 'POST', body })), question: current };
    error = null;
    // A right check goes straight on to the second question.
    if (feedback.verdict === 'right' && !feedback.done) {
      busy = null;
      return openQuestion();
    }
    screen = 'feedback';
  } catch (e) {
    error = message(e, 'that answer was not saved');
  }
  busy = null;
  draw();
}

async function reportQuestion() {
  const note = window.prompt('What is wrong with this question? (optional)', '');
  if (note === null) return;
  try {
    await api('/api/check/report', { method: 'POST', body: { item_id: current.item.id, note } });
    error = null;
  } catch (e) {
    error = message(e, 'the report was not saved');
  }
  openQuestion();
}

function drawFeedback() {
  const f = feedback;
  const q = f.question;
  const head = {
    right: 'Right', wrong: 'Not quite', skipped: q.slot === 1 ? 'New to you' : 'Counted as a miss',
    self: 'Marked as known', pending: 'Saved — marked at the end',
  }[f.verdict];
  const tone = { right: 'exact', self: 'exact', pending: 'typo' }[f.verdict] || 'wrong';
  view.innerHTML = `<div class="card quiz">
    <div class="quiz-mode"><span>${esc(q.word.term)}</span><span class="pill">${q.word.level.toUpperCase()}</span></div>
    <div class="verdict ${tone}">
      <div class="verdict-head">${head}</div>
      <div class="verdict-body">
        ${f.correct && f.verdict !== 'right' ? `<p style="margin:0 0 6px">Answer: <b class="solution">${esc(f.correct)}</b></p>` : ''}
        ${f.meaning ? `<p style="margin:0">${esc(f.meaning)}</p>` : ''}
        ${(f.oxford || []).map((x) => `<p class="muted" style="margin:4px 0 0">${esc(x)}</p>`).join('')}
        ${f.mastered ? `<p style="margin:8px 0 0">${f.how === 'known' ? 'You already knew it — dropped and replaced.'
          : f.how === 'self' ? 'Dropped and replaced.' : 'Learnt — dropped and replaced.'}</p>` : ''}
        ${f.passed && !f.mastered ? `<p style="margin:8px 0 0">Passed ${f.passes} of ${f.passesNeeded} days.</p>` : ''}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="next">Next →</button>
        ${f.undoable ? '<button class="btn secondary" id="undo">Undo</button>' : ''}
      </div>
    </div></div>`;
  view.querySelector('#next').focus();
  view.querySelector('#next').addEventListener('click', openQuestion);
  view.querySelector('#undo')?.addEventListener('click', async () => {
    try {
      await api('/api/check/undo', { method: 'POST', body: { entry_id: q.word.id } });
    } catch (e) {
      error = message(e, 'could not undo that');
    }
    openQuestion();
  });
}

// ---------------------------------------------------------------- marking --

function drawMarking() {
  view.innerHTML = `<div class="card quiz">
    <p class="prompt">${busy === 'marking' ? 'Marking your answers…' : `${data.pendingMarks} answer${data.pendingMarks === 1 ? '' : 's'} to mark.`}</p>
    <p class="prompt-sub">Five per request, about 20 seconds each.</p>
    ${error ? `<p class="verdict wrong">${esc(error)} Your answers are kept — try again.</p>` : ''}
    <div class="row"><button class="btn" id="go" ${busy ? 'disabled' : ''}>${error ? 'Try again' : 'Mark them'}</button>
      <button class="btn secondary" id="later" ${busy ? 'disabled' : ''}>Later</button></div></div>`;
  view.querySelector('#later').addEventListener('click', () => { screen = 'overview'; draw(); });
  view.querySelector('#go').addEventListener('click', async () => {
    busy = 'marking';
    error = null;
    draw();
    try {
      const res = await api('/api/check/mark', { method: 'POST' });
      marked = res.results;
      data = res;
      screen = 'overview';
    } catch (e) {
      error = message(e, 'marking failed');
    }
    busy = null;
    draw();
    prepareWaiting();      // replacements may need questions
  });
}

// ------------------------------------------------------------------ ielts --

async function newIelts() {
  busy = 'ielts';
  draw();
  try {
    const { task } = await api('/api/ielts/new', { method: 'POST' });
    ielts = { task, result: null };
    screen = 'ielts';
    error = null;
  } catch (e) {
    error = message(e, 'could not write the task');
  }
  busy = null;
  draw();
}

function drawIelts() {
  if (!ielts?.task && data.ielts?.task) ielts = { task: data.ielts.task, result: null };
  const { task, result } = ielts;
  const letters = ['A', 'B', 'C', 'D'];
  view.innerHTML = `<div class="card quiz">
    <div class="quiz-mode"><span>IELTS Academic Reading · practice</span></div>
    <p class="prompt prompt-serif" style="font-size:1.3rem">${esc(task.title || 'Reading passage')}</p>
    <p style="line-height:1.7">${esc(task.passage)}</p>
    ${task.questions.map((q, i) => `
      <div style="margin-top:18px">
        <p style="margin:0 0 8px"><b>${i + 1}.</b> ${esc(q.text)}
          ${q.kind === 'tfng' ? '<span class="muted"> — TRUE, FALSE or NOT GIVEN?</span>' : ''}</p>
        <div class="options">${q.options.map((o, k) => {
          const value = q.kind === 'mc' ? letters[k] : o;
          const r = result?.results[i];
          const state = r ? (value === r.answer ? 'right' : value === r.given ? 'wrong' : '') : '';
          return `<button class="option" data-q="${i}" data-v="${value}" ${result ? 'disabled' : ''} ${state ? `data-state="${state}"` : ''}>
            ${q.kind === 'mc' ? `<b>${value}</b>&nbsp; ` : ''}${esc(o)}</button>`;
        }).join('')}</div>
        ${result ? `<p class="muted" style="margin:6px 0 0">${esc(result.results[i].explanation)}</p>` : ''}
      </div>`).join('')}
    ${error ? `<p class="verdict wrong">${esc(error)}</p>` : ''}
    <div class="row" style="margin-top:18px">
      ${result ? `<p style="margin:0"><b>${result.score} of ${result.of}</b></p>
        <button class="btn" id="back">Back to today</button>`
        : '<button class="btn" id="submit">Check my answers</button><button class="btn secondary" id="back">Later</button>'}
    </div></div>`;

  const chosen = ielts.chosen || (ielts.chosen = []);
  view.querySelectorAll('[data-q]').forEach((b) => {
    if (chosen[b.dataset.q] === b.dataset.v) b.setAttribute('aria-pressed', 'true');
    b.addEventListener('click', () => {
      chosen[b.dataset.q] = b.dataset.v;
      view.querySelectorAll(`[data-q="${b.dataset.q}"]`).forEach((x) => x.removeAttribute('aria-pressed'));
      b.setAttribute('aria-pressed', 'true');
    });
  });
  view.querySelector('#back').addEventListener('click', async () => { await load(); screen = 'overview'; draw(); });
  view.querySelector('#submit')?.addEventListener('click', async () => {
    try {
      ielts.result = await api('/api/ielts/answer', { method: 'POST', body: { id: task.id, answers: chosen } });
      error = null;
    } catch (e) {
      error = message(e, 'the answers were not saved');
    }
    draw();
  });
}
