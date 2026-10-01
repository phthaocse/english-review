// Today: ten Oxford 5000 words and ten Oxford phrases, each tested cold.
//
// Step 1 shows the item in one of Oxford's sentences and asks what it means, in
// your own words (understand). Step 2 asks for a sentence of your own in a given
// situation (use). The Worker marks both; an item leaves the set only on a pass
// at both, and anything else becomes a learning card that comes back tomorrow.

import { api, ApiError } from './auth-client.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const LIST_LABEL = { word: 'Oxford 5000', phrase: 'Oxford Phrase List' };
// v2: answers are explanations now, not typed recalls, so older drafts are dropped.
const DRAFT_KEY = 'today-draft-v2';

let data = null;          // the Worker's state for today
let run = null;           // { queue, index, step, answers: Map }
let results = null;       // the last marking
let busy = null;          // 'loading' | 'marking'
let error = null;
let scenes = { running: false, error: null };   // situations arrive in the background
let currentView = null;
const MARK_BATCH = 5;     // sentences per marking request; twenty in one ran past the model's timeout

// Answers survive a reload: the check can take a while and a phone can drop the page.
function loadDraft(day) {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    return saved?.day === day ? new Map(saved.answers) : new Map();
  } catch { return new Map(); }
}
function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ day: data.day, answers: [...run.answers] }));
  } catch { /* private window: the check still works, only a reload loses it */ }
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* nothing to clear */ }
}

const allCards = () => (data ? [...data.lists.word, ...data.lists.phrase] : []);
const untested = () => allCards().filter((c) => !c.testedToday && c.meaning);

export async function renderToday(view) {
  if (!data && !busy) {
    busy = 'loading';
    renderShell(view);
    try {
      data = await api('/api/daily');
      error = null;
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'could not load today\'s set';
    }
    busy = null;
    prepareScenes();
    if (!location.hash.startsWith('#/today')) return;   // you left while it loaded
  }
  currentView = view;
  if (run && run.index < run.queue.length) return renderStep(view);
  if (run) return renderSubmit(view);
  return renderShell(view);
}

// ------------------------------------------------------------- situations --

const byId = (id) => allCards().find((c) => c.id === id);

/** Ask for situations a few at a time, the items you will meet next first. */
async function prepareScenes() {
  if (scenes.running || !data) return;
  scenes = { running: true, error: null };
  try {
    while (data.scenesPending > 0) {
      const next = run ? run.queue.slice(run.index).map((c) => c.id) : untested().map((c) => c.id);
      const res = await api('/api/daily/scenes', { method: 'POST', body: { ids: next } });
      for (const card of res.cards) Object.assign(byId(card.id) || {}, card);
      data.scenesPending = res.remaining;
      if (res.error) { scenes.error = res.error; break; }
      if (!res.cards.length) break;
      refreshIfWaiting();
    }
  } catch (e) {
    scenes.error = e instanceof ApiError ? e.message : 'could not prepare situations';
  }
  scenes.running = false;
  refreshIfWaiting();
}

// Only the "preparing a situation" screen redraws itself; anything else would lose what you are typing.
function refreshIfWaiting() {
  if (currentView?.querySelector('[data-waiting]') && location.hash.startsWith('#/today')) renderToday(currentView);
}

// ---------------------------------------------------------------- overview --

function renderShell(view) {
  if (busy === 'loading') {
    view.innerHTML = `<h2 class="section">Today</h2>
      <p class="lede">Dealing today's words and reading Oxford for them…</p>`;
    return;
  }
  if (!data) {
    view.innerHTML = `<h2 class="section">Today</h2>
      <p class="empty">${esc(error || 'Nothing to show.')}</p>`;
    return;
  }
  const pending = untested();
  const s = data.stats;
  view.innerHTML = `
    <h2 class="section">Today</h2>
    <p class="lede">Ten words and ten phrases. Each one is tested before you study it;
      it leaves the list only when you can explain it <i>and</i> use it.</p>

    <div class="statgrid">
      <div class="card stat ${pending.length ? 'is-due' : ''}"><b>${pending.length}</b><span>to check</span></div>
      <div class="card stat"><b>${s.word.masteredToday + s.phrase.masteredToday}</b><span>mastered today</span></div>
      <div class="card stat"><b>${s.word.mastered}</b><span>words mastered</span></div>
      <div class="card stat"><b>${s.phrase.mastered}</b><span>phrases mastered</span></div>
    </div>
    ${scenes.error ? `<p class="verdict typo">Situations could not be prepared: ${esc(scenes.error)}.
      You can still do the check; step 2 will ask for a sentence about your own life instead.</p>` : ''}
    ${error ? `<p class="verdict wrong">${esc(error)}</p>` : ''}

    <div class="card block">
      ${pending.length
        ? `<button class="btn" id="start">Start the check · ${pending.length} item${pending.length === 1 ? '' : 's'}</button>
           <p class="next-hint">About a minute each. Step 1: say what it means. Step 2: write your own sentence.
             Both are marked together at the end.</p>`
        : `<p style="margin:0">Done for today. What you did not master is below — read it now,
             and it comes back tomorrow.</p>`}
    </div>

    ${results ? renderResults(results) : ''}
    ${['word', 'phrase'].map((list) => renderList(list)).join('')}`;

  view.querySelector('#start')?.addEventListener('click', () => startRun(view));
}

function renderList(list) {
  const cards = data.lists[list];
  return `
    <div class="card block">
      <h3>${LIST_LABEL[list]} · ${cards.length} in your set · ${data.stats[list].pool - data.stats[list].mastered} left to master</h3>
      ${cards.length ? `<div class="results">${cards.map(renderRow).join('')}</div>`
        : '<p class="muted" style="margin:0">Nothing left to draw today.</p>'}
    </div>`;
}

// An untested item stays hidden, so the check meets it cold.
function renderRow(card) {
  const level = `<span class="pill">${card.level.toUpperCase()}</span>`;
  if (!card.testedToday) {
    return `<div class="result"><div class="result-top">
      <span class="result-term muted">Hidden until you check it</span>${level}
      ${card.meaning ? '' : '<span class="pill warn">Oxford unreachable — retry later</span>'}</div></div>`;
  }
  return `<details class="result">
    <summary class="result-top"><span class="result-term">${esc(card.term)}</span>${level}
      ${card.pos ? `<span class="muted">${esc(card.pos)}</span>` : ''}
      <span class="pill bad">keep learning</span></summary>
    ${learningCard(card, card.lastResult)}
  </details>`;
}

function learningCard(card, result) {
  const j = result?.judgement;
  return `<div style="margin-top:10px">
    ${card.ipa ? `<p class="result-ipa" style="margin:0">${esc(card.ipa)}</p>` : ''}
    <p style="margin:6px 0 0">${esc(card.meaning)}</p>
    ${card.vi ? `<p class="result-vi" style="margin:4px 0 0">${esc(card.vi)}</p>` : ''}
    ${card.examples?.length ? `<ul style="margin:10px 0 0; padding-left:20px">${card.examples
      .map((e) => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    ${result?.explanation ? `<p style="margin:12px 0 0"><b>You said it means:</b> ${esc(result.explanation)}</p>` : ''}
    ${result?.sentence ? `<p style="margin:4px 0 0"><b>You wrote:</b> ${esc(result.sentence)}</p>` : ''}
    ${j ? `<p style="margin:4px 0 0">${esc(j.feedback)}</p>
           ${j.corrected && j.corrected !== result.sentence ? `<p class="rightline" style="margin:4px 0 0">→ ${esc(j.corrected)}</p>` : ''}` : ''}
    ${card.sample ? `<p class="muted" style="margin:8px 0 0"><b>A natural way to say it:</b> ${esc(card.sample)}</p>` : ''}
    <p style="margin:10px 0 0"><a href="${esc(card.url)}" target="_blank" rel="noopener noreferrer">Open in Oxford ↗</a></p>
  </div>`;
}

function renderResults(list) {
  if (!list.length) return '';
  const mastered = list.filter((r) => r.mastered);
  return `<div class="card block">
    <h3>Last check · ${mastered.length} of ${list.length} mastered</h3>
    <div class="results">${list.map((r) => `
      <div class="result"><div class="result-top">
        <span class="result-term">${esc(r.term)}</span>
        ${r.mastered ? '<span class="pill good">mastered · dropped and replaced</span>'
          : `<span class="pill bad">${r.skipped ? 'new to you'
            : !r.judgement?.understood ? 'meaning not right yet' : 'not used correctly yet'}</span>`}
      </div>
      ${r.judgement && !r.mastered ? `<p class="result-gloss">${esc(r.judgement.feedback)}</p>` : ''}
      </div>`).join('')}</div>
  </div>`;
}

// ------------------------------------------------------------------ check --

function startRun(view) {
  const queue = untested();
  run = { queue, index: 0, answers: loadDraft(data.day) };
  // Resume where a reload left off.
  while (run.index < queue.length && run.answers.get(queue[run.index].id)?.done) run.index++;
  renderToday(view);
}

function renderStep(view) {
  const card = run.queue[run.index];
  const answer = run.answers.get(card.id) || { id: card.id };
  const step = answer.explanation === undefined ? 'understand' : 'use';
  const bar = `<div class="quizbar">
      <div class="progressbar"><i style="width:${(run.index / run.queue.length) * 100}%"></i></div>
      <span class="quizcount">${run.index + 1} / ${run.queue.length}</span>
      <button class="btn secondary small" id="pause">Pause</button></div>`;
  const mode = `<div class="quiz-mode"><span>${LIST_LABEL[card.list]}</span>
      <span class="pill">${card.level.toUpperCase()}</span>
      <span>${step === 'understand' ? 'Step 1 of 2 · What does it mean?' : 'Step 2 of 2 · Use it'}</span></div>`;

  if (step === 'understand') {
    const c = card.context;
    view.innerHTML = `${bar}<div class="card quiz">${mode}
      <p class="prompt prompt-serif">${esc(card.term)}</p>
      ${c ? `<p class="prompt">${esc(c.before)}<mark>${esc(c.target)}</mark>${esc(c.after)}</p>` : ''}
      <p class="prompt-sub">What does it mean${c ? ' here' : ''}? Explain in your own words —
        English or Vietnamese, a synonym or a short example all count.</p>
      <textarea class="answer" id="explanation" rows="2" maxlength="300"></textarea>
      <div class="row" style="margin-top:12px">
        <button class="btn" id="next">Next →</button>
        <button class="btn secondary" id="dunno">I don't know it</button>
      </div></div>`;
    const box = view.querySelector('#explanation');
    box.focus();
    view.querySelector('#next').addEventListener('click', () => {
      if (!box.value.trim()) return box.focus();
      answer.explanation = box.value.trim();
      run.answers.set(card.id, answer);
      saveDraft();
      renderToday(view);
    });
    // Nothing to mark for an item you have not met: it goes straight to the learning cards.
    view.querySelector('#dunno').addEventListener('click', () => {
      Object.assign(answer, { explanation: '', skipped: true, done: true });
      run.answers.set(card.id, answer);
      saveDraft();
      run.index++;
      renderToday(view);
    });
  } else if (!card.situation && !scenes.error && data.scenesPending > 0) {
    view.innerHTML = `${bar}<div class="card quiz" data-waiting>${mode}
      <p class="prompt prompt-serif">${esc(card.term)}</p>
      <p class="prompt-sub">Preparing a situation for this one — a few seconds…</p></div>`;
    if (!scenes.running) prepareScenes();
  } else {
    view.innerHTML = `${bar}<div class="card quiz">${mode}
      <p class="prompt prompt-serif">${esc(card.term)}</p>
      <p class="prompt">${esc(card.situation || 'Write a sentence about your own life or work.')}</p>
      <p class="prompt-sub">Write what you would actually say, using <b>${esc(card.term)}</b> in this meaning.</p>
      ${!card.situation && scenes.error ? `<p class="next-hint">No situation: ${esc(scenes.error)}.
        <button class="override" id="retry-scenes">Try preparing it again</button></p>` : ''}
      <textarea class="answer" id="sentence" rows="3" maxlength="400">${esc(answer.sentence || '')}</textarea>
      <div class="row" style="margin-top:12px"><button class="btn" id="done">Next →</button></div></div>`;
    const box = view.querySelector('#sentence');
    box.focus();
    view.querySelector('#retry-scenes')?.addEventListener('click', () => {
      scenes.error = null;
      prepareScenes();
      renderToday(view);
    });
    view.querySelector('#done').addEventListener('click', () => {
      if (!box.value.trim()) return box.focus();
      answer.sentence = box.value.trim();
      answer.done = true;
      run.answers.set(card.id, answer);
      saveDraft();
      run.index++;
      renderToday(view);
    });
  }
  view.querySelector('#pause').addEventListener('click', () => { run = null; renderToday(view); });
}

function renderSubmit(view) {
  const answers = [...run.answers.values()].filter((a) => a.done && run.queue.some((c) => c.id === a.id));
  const toMark = answers.filter((a) => !a.skipped).length;
  view.innerHTML = `<div class="card quiz">
    <p class="prompt">${busy === 'marking' ? 'Marking your answers…' : `All ${answers.length} answered.`}</p>
    <p class="prompt-sub">${toMark} to mark, ${MARK_BATCH} per request.</p>
    ${error ? `<p class="verdict wrong">${esc(error)} Your answers are kept — try again.</p>` : ''}
    <button class="btn" id="mark" ${busy ? 'disabled' : ''}>${error ? 'Try again' : 'Mark them'}</button></div>`;
  view.querySelector('#mark').addEventListener('click', async () => {
    busy = 'marking';
    error = null;
    renderSubmit(view);
    const marked = [];
    try {
      for (let i = 0; i < answers.length; i += MARK_BATCH) {
        const res = await api('/api/daily/grade', { method: 'POST', body: { answers: answers.slice(i, i + MARK_BATCH) } });
        marked.push(...res.results);
        data = res.state;
        // What was marked is final; only the rest is retried after a failure.
        for (const a of answers.slice(i, i + MARK_BATCH)) run.answers.delete(a.id);
        saveDraft();
      }
      results = marked;
      run = null;
      clearDraft();
      prepareScenes();      // replacements need situations too
    } catch (e) {
      error = e instanceof ApiError ? e.message : 'marking failed';
      if (marked.length) results = marked;
    }
    busy = null;
    renderToday(view);
  });
}
