// Today: ten words from the Oxford 1,000, two short questions each.
//
// The first question is a quick check; miss it and the word stops there with
// its learning card. Get it right and the second asks for one short piece of
// production. Keyed answers are marked by the Worker at once; sentences and
// rewrites are marked together at the end. Missed words then come back as
// retests, which are practice: a word's level moves only on a day's first try.

import { api, ApiError } from './auth-client.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const message = (e, fallback) => (e instanceof ApiError ? e.message : fallback);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const FEATURES = [
  ['meaning', 'Precise meaning'], ['accuracy', 'Grammar of the word'], ['collocation', 'Collocation'],
  ['paraphrase', 'Paraphrase'], ['use', 'Using it in a sentence'],
];
const STAGES = ['New', 'Recognise', 'Can use', 'Secure'];
const SECURE = 3;
const KIND_LABEL = { sense: 'Meaning', pattern: 'Pattern', collocation: 'Collocation', idiom: 'Idiom' };

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
let focus = null;         // the word whose own Retest button started this question
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

// ------------------------------------------------------- shared pieces --

const dots = (stage) => '●'.repeat(stage) + '○'.repeat(SECURE - stage);
const stagePill = (stage) =>
  `<span class="pill ${stage === SECURE ? 'good' : stage ? 'accent' : ''}">${dots(stage)} ${STAGES[stage]}</span>`;

function nextStep(w) {
  if (w.stage === 0) return 'Next: show you know what it means';
  if (w.stage === 1) return 'Next: use it yourself';
  return `Next: use it again on another day · day ${w.passes} of ${w.passesNeeded}`;
}

const oxfordLink = (url) => (url
  ? `<a href="${esc(url)}" target="_blank" rel="noopener">Open in Oxford ↗</a>` : '');

function levelChange(r) {
  if (r.level == null || r.levelBefore == null) return '';
  if (r.level === r.levelBefore) return `<p style="margin:8px 0 0">Level: ${stagePill(r.level)} (no change)</p>`;
  return `<p style="margin:8px 0 0">Level: ${stagePill(r.levelBefore)} → ${stagePill(r.level)}</p>`;
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

function drawAction() {
  const parts = [
    data.left && `${data.left} to check`,
    data.pendingMarks && `${plural(data.pendingMarks, 'answer')} to mark`,
    data.retestLeft && `${data.retestLeft} to retest`,
  ].filter(Boolean);
  const button = data.left ? `<button class="btn" id="start">Start · ${plural(data.left, 'word')}</button>
      <p class="next-hint">About 45 seconds a word. Sentences are marked together at the end.</p>`
    : data.pendingMarks ? `<button class="btn" id="mark">Mark ${plural(data.pendingMarks, 'answer')}</button>`
    : data.retestLeft ? `<button class="btn" id="retest">Retest · ${plural(data.retestLeft, 'word')}</button>
      <p class="next-hint">A different question on what you missed. Practice only: levels move on tomorrow's first try.</p>`
    : '';
  return `<div class="card block">
    <p class="prompt" style="margin:0 0 12px">${parts.length ? parts.join(' · ') : 'Done for today.'}</p>
    ${button}</div>`;
}

function drawOverview() {
  view.innerHTML = `
    <h2 class="section">Today</h2>
    <p class="lede">Each word has a level: ${STAGES.map((s, i) => `${dots(i)} ${s}`).join(' → ')}.
      A right first try moves it up; a miss on a later day moves it down one step.</p>
    ${error ? `<p class="verdict wrong">${esc(error)}</p>` : ''}
    ${data.waiting ? `<p class="verdict typo">${plural(data.waiting, 'word')} still
      waiting for questions${preparing.running ? ' — writing them now, about 40 seconds each' : ''}.
      ${preparing.note ? `${esc(preparing.note)}. They will be ready after tonight's run.` : ''}</p>` : ''}
    ${drawAction()}
    ${drawIeltsCard()}
    ${marked?.length ? drawResults(marked) : ''}
    <div class="card block"><h3>Your words</h3><div class="results">${data.words.map(drawWord).join('')}</div></div>
    ${drawLevels()}`;

  view.querySelector('#start')?.addEventListener('click', () => { focus = null; openQuestion(); });
  view.querySelector('#retest')?.addEventListener('click', () => { marked = null; focus = null; openQuestion(); });
  view.querySelectorAll('[data-retest]').forEach((b) => b.addEventListener('click', (e) => {
    e.preventDefault();      // the button sits in the row's summary, which a click would otherwise open
    marked = null;
    focus = Number(b.dataset.retest);
    openQuestion();
  }));
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
      ${level}${stagePill(w.stage)}${w.ready ? '' : '<span class="pill warn">questions being written</span>'}</div></div>`;
  }
  const tested = w.checklist.filter((c) => c.state);
  const untested = w.checklist.length - tested.length;
  return `<details class="result">
    <summary class="result-top"><span class="result-term">${esc(w.term)}</span>${level}
      <span class="muted">${esc(w.pos || '')}</span>${stagePill(w.stage)}
      ${w.retest ? '<span class="pill warn">retest today</span>' : ''}
      ${w.ready ? `<button class="btn secondary small retest-word" data-retest="${w.id}">Retest</button>` : ''}
      <span class="level-next">${nextStep(w)}</span></summary>
    <div style="margin-top:10px">
      <p style="margin:0">${w.ipa ? `<span class="result-ipa">${esc(w.ipa)}</span> · ` : ''}${oxfordLink(w.url)}</p>
      ${w.senses.map((s) => `<p style="margin:6px 0 0">${s.cefr ? `<span class="pill">${s.cefr.toUpperCase()}</span> ` : ''}${esc(s.def)}
        ${s.example ? `<br><span class="muted">${esc(s.example)}</span>` : ''}</p>`).join('')}
      <p style="margin:14px 0 4px"><b>What you've shown</b></p>
      <ul style="margin:0; padding-left:20px">${tested.map((c) => `<li>${c.state === 'right' ? '✓' : '✗'}
        <span class="muted">${KIND_LABEL[c.kind] || c.kind}:</span> ${esc(c.label)}
        ${c.state === 'missed' && c.practised ? '<span class="muted">— practised today ✓</span>' : ''}</li>`).join('')}</ul>
      ${untested ? `<p class="muted" style="margin:4px 0 0">${plural(untested, 'more use')} of this word still to test.</p>` : ''}
      ${w.today.map((a) => `<p style="margin:10px 0 0"><b>You wrote${a.retest ? ' (retest)' : ''}:</b> ${esc(a.answer)}<br>${esc(a.feedback)}
        ${a.corrected && a.corrected !== a.answer ? `<br><span class="rightline">→ ${esc(a.corrected)}</span>` : ''}</p>`).join('')}
    </div></details>`;
}

function drawLevels() {
  const s = data.stages;
  const f = data.features || {};
  const rows = FEATURES.filter(([k]) => f[k]?.n).map(([k, label]) => {
    const pct = Math.round((f[k].right / f[k].n) * 100);
    return `<li>${label}: <b>${pct}%</b> <span class="muted">(${f[k].right} of ${f[k].n})</span></li>`;
  });
  const line = [[SECURE, s.secure], [2, s.canUse], [1, s.recognise], [0, s.new]]
    .map(([stage, n]) => `<li>${stagePill(stage)} <b>${n}</b>${stage === SECURE ? ` <span class="muted">of ${data.totals.of}</span>` : ''}</li>`);
  return `<div class="card block"><h3>Your level</h3>
    <ul style="margin:0; padding:0; list-style:none; display:grid; gap:8px">${line.join('')}</ul>
    ${rows.length ? `<details style="margin-top:14px"><summary class="muted">By IELTS skill, last 30 days</summary>
      <ul style="margin:8px 0 0; padding-left:20px">${rows.join('')}</ul></details>` : ''}</div>`;
}

function drawResults(list) {
  return `<div class="card block"><h3>Just marked</h3><div class="results">${list.map((r) => `
    <div class="result"><div class="result-top"><span class="result-term">${esc(r.term)}</span>
      ${r.retest ? '<span class="muted">retest</span>' : ''}
      <span class="pill ${r.verdict === 'right' ? 'good' : 'bad'}">${r.verdict === 'right' ? 'right' : 'not yet'}</span>
      ${r.mastered ? `<span class="pill good">${r.how === 'known' ? 'you already knew it' : 'learnt'} · leaves your list</span>` : ''}</div>
      <p class="result-gloss">${esc(r.feedback)}</p>
      ${r.corrected && r.corrected !== r.answer ? `<p class="rightline" style="margin:4px 0 0">→ ${esc(r.corrected)}</p>` : ''}
      ${r.retest ? '' : levelChange(r)}
    </div>`).join('')}</div></div>`;
}

// --------------------------------------------------------------- question --

async function openQuestion() {
  try {
    const next = await api(focus ? `/api/check/next?word=${focus}` : '/api/check/next');
    if (next.done) {
      focus = null;
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

/** The sentence with its wrong word underlined, or as it is if the word is not found in it. */
function withWrongWord(stem, wrong) {
  const at = wrong ? stem.toLowerCase().indexOf(wrong.toLowerCase()) : -1;
  if (at < 0) return esc(stem);
  return `${esc(stem.slice(0, at))}<u class="wrongword">${esc(stem.slice(at, at + wrong.length))}</u>${esc(stem.slice(at + wrong.length))}`;
}

const STEMS = {
  meaning_mc: (q) => `<p class="prompt">${esc(q.item.stem)}</p><p class="prompt-sub">Here <b>${esc(q.word.term)}</b> means:</p>`,
  pattern_mc: () => '<p class="prompt-sub">Choose the correct sentence:</p>',
  fix_word: (q) => {
    const found = q.item.wrong && q.item.stem.toLowerCase().includes(q.item.wrong.toLowerCase());
    return `<p class="prompt">${withWrongWord(q.item.stem, q.item.wrong)}</p>
      <p class="prompt-sub">${found ? 'The underlined word is wrong.' : q.item.wrong ? `“${esc(q.item.wrong)}” is wrong.`
        : 'One word is wrong.'} Type the word that should replace it.</p>`;
  },
  rewrite: (q) => `<p class="prompt">${esc(q.item.stem)}</p><p class="prompt-sub">${esc(q.item.instruction)}</p>`,
  sentence: (q) => `<p class="prompt">${esc(q.item.stem)}</p><p class="prompt-sub">${esc(q.item.instruction)}</p>`,
};

function drawQuestion() {
  const q = current;
  const typed = q.item.options ? '' : q.item.type === 'fix_word'
    ? '<input class="answer" id="typed" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="the right word">'
    : '<textarea class="answer" id="typed" rows="3" maxlength="400"></textarea>';
  const mode = q.retest ? 'Retest · practice' : q.slot === 1 ? 'Quick check' : 'Now use it';
  view.innerHTML = `
    <div class="quizbar">
      <div class="progressbar"><i style="width:${q.progress.total ? (q.progress.done / q.progress.total) * 100 : 0}%"></i></div>
      <span class="quizcount">${q.progress.done + 1} / ${q.progress.total}</span>
      <button class="btn secondary small" id="pause">Pause</button></div>
    <div class="card quiz">
      <div class="quiz-mode"><span>${mode}</span>
        <span class="pill">${q.word.level.toUpperCase()}</span>${q.slot === 2 || q.retest ? `<span>${esc(q.word.term)}</span>` : ''}</div>
      ${STEMS[q.item.type](q)}
      ${q.item.options ? `<div class="options">${q.item.options.map((o, i) =>
        `<button class="option" data-choice="${i}">${esc(o)}</button>`).join('')}</div>` : typed}
      ${error ? `<p class="verdict wrong">${esc(error)}</p>` : ''}
      <div class="row" style="margin-top:12px">
        ${q.item.options ? '' : '<button class="btn" id="submit">Next →</button>'}
        <button class="btn secondary" id="skip">${q.slot === 1 && !q.retest ? 'I don\'t know it' : 'I can\'t'}</button>
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

function feedbackHead(f, q) {
  if (f.retest) {
    return { right: 'Right — practised ✓', pending: 'Saved — marked at the end' }[f.verdict]
      || (f.triesLeft ? 'Not yet — it comes back once more' : 'Not yet — it comes back tomorrow');
  }
  return {
    right: 'Right', wrong: 'Not quite', skipped: q.slot === 1 ? 'New to you' : 'Counted as a miss',
    self: 'Marked as known', pending: 'Saved — marked at the end',
  }[f.verdict];
}

function drawFeedback() {
  const f = feedback;
  const q = f.question;
  const tone = { right: 'exact', self: 'exact', pending: 'typo' }[f.verdict] || 'wrong';
  view.innerHTML = `<div class="card quiz">
    <div class="quiz-mode"><span>${esc(q.word.term)}</span><span class="pill">${q.word.level.toUpperCase()}</span>
      <span style="text-transform:none; letter-spacing:0">${oxfordLink(q.word.url)}</span></div>
    <div class="verdict ${tone}">
      <div class="verdict-head">${feedbackHead(f, q)}</div>
      <div class="verdict-body">
        ${f.correct && f.verdict !== 'right' ? `<p style="margin:0 0 6px">Answer: <b class="solution">${esc(f.correct)}</b></p>` : ''}
        ${f.meaning ? `<p style="margin:0">${esc(f.meaning)}</p>` : ''}
        ${(f.oxford || []).map((x) => `<p class="muted" style="margin:4px 0 0">${esc(x)}</p>`).join('')}
        ${f.mastered ? `<p style="margin:8px 0 0">${f.how === 'known' ? 'You already knew it — it leaves your list.'
          : f.how === 'self' ? 'It leaves your list.' : 'Learnt — it leaves your list.'}</p>` : ''}
        ${f.retest ? '<p class="muted" style="margin:8px 0 0">Retests are practice; the level moves on tomorrow\'s first try.</p>' : levelChange(f)}
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="next">Next →</button>
        ${f.undoable ? '<button class="btn secondary" id="undo">Undo</button>' : ''}
      </div>
    </div></div>`;
  view.querySelector('#next').focus();
  view.querySelector('#next').addEventListener('click', focus && f.done ? backToList : openQuestion);
  view.querySelector('#undo')?.addEventListener('click', async () => {
    try {
      await api('/api/check/undo', { method: 'POST', body: { entry_id: q.word.id } });
    } catch (e) {
      error = message(e, 'could not undo that');
    }
    openQuestion();
  });
}

/** After a word's own Retest, Next returns to the list rather than starting another word. */
async function backToList() {
  focus = null;
  await load();
  screen = 'overview';
  draw();
}

// ---------------------------------------------------------------- marking --

function drawMarking() {
  view.innerHTML = `<div class="card quiz">
    <p class="prompt">${busy === 'marking' ? 'Marking your answers…' : `${plural(data.pendingMarks, 'answer')} to mark.`}</p>
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
