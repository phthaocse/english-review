// English Review — look up what I've learnt, and practise it.
//
// Data comes from data/vocab.json, generated out of the Obsidian vault by
// _System/Scripts/build_site.py. Scheduling and grading live in review.js.

import * as R from './review.js';
import { renderCapture } from './capture.js';
import { initAuth, onAuthChange, currentUser, renderSignInButton, signOut } from './auth-client.js';

const state = {
  items: [],
  byId: new Map(),
  progress: R.loadProgress(),
  generated: '',
  session: null,
  query: '',
  filter: 'all',
};

const view = document.getElementById('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

const TYPE_LABEL = {
  word: 'Word', 'phrasal-verb': 'Phrasal verb', idiom: 'Idiom',
  collocation: 'Collocation', conversational: 'Conversational',
  'grammar-pattern': 'Grammar', 'pronunciation-rule': 'Pronunciation',
  'error-drill': 'Error drill',
};

const SCOPES = {
  all: { label: 'Everything', types: null },
  vocab: { label: 'Words & phrases', types: ['word', 'phrasal-verb', 'idiom', 'collocation', 'conversational'] },
  grammar: { label: 'Grammar & drills', types: ['grammar-pattern', 'error-drill'] },
  pron: { label: 'Pronunciation', types: ['pronunciation-rule'] },
};

// ------------------------------------------------------------------ boot ---

async function boot() {
  const res = await fetch('data/vocab.json', { cache: 'no-cache' });
  if (!res.ok) { view.innerHTML = '<p class="empty">Could not load the vocabulary data.</p>'; return; }
  const data = await res.json();
  state.items = data.items;
  state.generated = data.generated;
  state.byId = new Map(data.items.map((i) => [i.id, i]));
  document.getElementById('foot-meta').textContent =
    `${data.items.length} items · built from the Obsidian vault on ${data.generated}`;
  window.addEventListener('hashchange', route);
  onAuthChange(() => route());
  initAuth().catch(() => { /* offline, or Google unreachable: the rest still works */ });
  route();
}

function route() {
  const hash = location.hash.replace(/^#/, '') || '/review';
  const [, section, ...rest] = hash.split('/');
  renderAccountBar();
  document.querySelectorAll('.tabs a').forEach((a) => {
    a.removeAttribute('aria-current');
    if (a.dataset.tab === section || (section === 'item' && a.dataset.tab === 'lookup')) {
      a.setAttribute('aria-current', 'page');
    }
  });
  window.scrollTo(0, 0);

  // Nothing is usable until you are signed in — including looking words up.
  if (!currentUser()) return renderSignInGate();

  if (section === 'capture') return renderCapture(view);
  if (section === 'lookup') return renderLookup();
  if (section === 'progress') return renderProgress();
  if (section === 'item') return renderItem(decodeURIComponent(rest.join('/')));
  return renderReview();
}

/** A small account strip in the header, once signed in. */
function renderAccountBar() {
  const existing = document.getElementById('account-bar');
  const user = currentUser();
  if (!user) { existing?.remove(); return; }
  if (existing) return;

  const bar = document.createElement('div');
  bar.id = 'account-bar';
  bar.className = 'account-bar';
  bar.innerHTML = `<span class="muted">${esc(user.email)}</span>
                   <button class="btn secondary small" id="global-signout">Sign out</button>`;
  document.querySelector('.topbar-inner').appendChild(bar);
  bar.querySelector('#global-signout').addEventListener('click', () => { signOut(); route(); });
}

function renderSignInGate() {
  view.innerHTML = `
    <div class="card block gate">
      <h2 class="section" style="margin-bottom:6px">English Review</h2>
      <p class="lede" style="margin-bottom:26px">
        Capture what you learn, look it up later, and practise it until you can produce it.
      </p>
      <div id="gsi-button" style="display:flex; justify-content:center"></div>
      <p class="next-hint" style="margin-top:20px">
        Sign in with Google. Only accounts on the allowlist can get in.
      </p>
    </div>`;
  renderSignInButton(view.querySelector('#gsi-button')).catch((error) => {
    view.querySelector('#gsi-button').innerHTML =
      `<span class="muted">${esc(error.message)}</span>`;
  });
}

const save = () => R.saveProgress(state.progress);
const go = (path) => { location.hash = path; };

// -------------------------------------------------------- question models --

/** How far up the ladder an item can climb, given what its note supports. */
function maxLevelFor(item) {
  if (item.kind === 'vocab') return 2;                  // recognise -> gap-fill -> produce
  if (item.type === 'pronunciation-rule') return 0;     // rule recall only
  return 1;                                             // choose correct -> fix the sentence
}

function levelOf(item) {
  const record = state.progress.cards[item.id];
  return Math.min(record ? record.level : 0, maxLevelFor(item));
}

/** Blank the bold span out of an example sentence. */
function gapSentence(md) {
  const m = md.match(/\*\*(.+?)\*\*/);
  if (!m) return null;
  const plain = (t) => esc(t.replace(/\*\*/g, '').replace(/`/g, ''));
  return {
    html: plain(md.slice(0, m.index)) + '<span class="gap">?</span>' + plain(md.slice(m.index + m[0].length)),
    answer: m[1].trim(),
  };
}

/** Blank one bold span out of a rule statement, leaving the others visible. */
function ruleCloze(rule) {
  const spans = [...rule.matchAll(/\*\*(.+?)\*\*/g)];
  if (!spans.length) return null;
  const chosen = pick(spans);
  const plain = (t) => esc(t.replace(/\*\*/g, '').replace(/[*`]/g, ''));
  return {
    html: plain(rule.slice(0, chosen.index)) + '<span class="gap">?</span>' +
          plain(rule.slice(chosen.index + chosen[0].length)),
    answer: chosen[1].trim(),
  };
}

function distractors(item, n) {
  const pool = state.items.filter((i) => i.id !== item.id && i.type === item.type && i.term);
  const wide = pool.length >= n ? pool : state.items.filter((i) => i.id !== item.id && i.kind === 'vocab');
  return shuffle(wide).slice(0, n).map((i) => i.term);
}

/** All example sentences that carry a gap, senses included. */
function gappableExamples(item) {
  const out = item.examples.filter((e) => e.gaps && e.gaps.length).map((e) => e.md);
  for (const sense of item.senses || []) {
    if (sense.example && sense.example.gaps && sense.example.gaps.length) out.push(sense.example.md);
  }
  return out;
}

/**
 * Build the question for an item at its current level.
 * Falls back down the ladder if the note lacks the data for that level.
 */
function makeQuestion(item) {
  const level = levelOf(item);

  if (item.kind === 'vocab') {
    if (level >= 1) {
      const pool = gappableExamples(item);
      if (pool.length) {
        const gap = gapSentence(pick(pool));
        if (level === 1) {
          return {
            item, level, mode: 'Gap-fill', kind: 'type',
            promptHtml: gap.html,
            subHtml: `<span class="muted">${esc(item.meaning)}</span>`,
            accepted: [gap.answer],
            hint: gap.answer,
            solution: gap.answer,
          };
        }
        // Level 2 produces the word from meaning alone; the sentence is the
        // feedback afterwards, not the prompt.
        return {
          item, level, mode: 'Produce it', kind: 'type',
          promptHtml: `<span class="prompt-serif">${esc(item.vi || item.meaning)}</span>`,
          subHtml: `<span class="muted">${esc(item.vi ? item.meaning : (item.pos || []).join(', '))}</span>`,
          accepted: [item.term],
          hint: item.term,
          solution: item.term,
          after: gap.html.replace('<span class="gap">?</span>', `<strong>${esc(gap.answer)}</strong>`),
        };
      }
    }
    const options = shuffle([item.term, ...distractors(item, 3)]);
    return {
      item, level: 0, mode: 'Which word?', kind: 'choice',
      promptHtml: esc(item.meaning),
      subHtml: item.vi ? `<span class="muted">${esc(item.vi)}</span>` : '',
      options, correct: item.term, accepted: [item.term], solution: item.term,
    };
  }

  if (item.type === 'pronunciation-rule') {
    const cloze = ruleCloze(item.rule || '');
    if (cloze) {
      return {
        item, level: 0, mode: 'Complete the rule', kind: 'type',
        promptHtml: cloze.html,
        subHtml: `<span class="muted">${esc(item.vi)}</span>`,
        accepted: [cloze.answer], hint: cloze.answer, solution: cloze.answer,
        after: (item.examples || []).map((e) => e.text).join(' &nbsp;·&nbsp; '),
      };
    }
  }

  // Grammar patterns and error drills: choose the correct sentence, then fix one.
  const wrong = item.wrong || [], correct = item.correct || [];
  if (wrong.length && correct.length) {
    const paired = wrong.length === correct.length;
    const idx = Math.floor(Math.random() * wrong.length);
    const right = paired ? correct[idx] : pick(correct);
    if (level >= 1) {
      return {
        item, level: 1, mode: 'Fix the sentence', kind: 'type',
        promptHtml: `<span class="wrongline">${esc(wrong[idx])}</span>`,
        subHtml: `<span class="muted">${esc(item.rule.replace(/\*\*/g, '').replace(/\*/g, ''))}</span>`,
        accepted: paired ? [right] : correct,
        strict: true, hint: right, solution: right,
        multiline: true,
      };
    }
    const others = wrong.filter((_, i) => i !== idx);
    const options = shuffle([right, wrong[idx], ...(others.length ? [pick(others)] : [])]);
    return {
      item, level: 0, mode: 'Which one is correct?', kind: 'choice',
      promptHtml: `<span class="muted">${esc(item.term)}</span>`,
      subHtml: '', options, correct: right, accepted: [right], solution: right,
    };
  }

  // Last resort for a note with neither examples nor pairs.
  return {
    item, level: 0, mode: 'Recall', kind: 'type',
    promptHtml: esc(item.vi || item.rule || item.meaning || item.term),
    subHtml: '', accepted: [item.term], hint: item.term, solution: item.term,
  };
}

// ------------------------------------------------------------ review view --

function renderReview() {
  if (state.session) return renderQuestion();

  const scope = SCOPES[state.filter] || SCOPES.all;
  const pool = scope.types ? state.items.filter((i) => scope.types.includes(i.type)) : state.items;
  const s = R.stats(pool, state.progress);

  view.innerHTML = `
    <h2 class="section">Practise</h2>
    <p class="lede">You type the answer and the app marks it, so you never have to grade yourself.</p>

    <div class="statgrid">
      <div class="card stat ${s.due ? 'is-due' : ''}"><b>${s.due}</b><span>due now</span></div>
      <div class="card stat"><b>${s.fresh}</b><span>not started</span></div>
      <div class="card stat"><b>${s.learning}</b><span>learning</span></div>
      <div class="card stat"><b>${s.mature}</b><span>solid</span></div>
    </div>

    <div class="filters" role="group" aria-label="What to practise">
      ${Object.entries(SCOPES).map(([key, cfg]) => `
        <button class="chip" data-scope="${key}" aria-pressed="${state.filter === key}">${cfg.label}</button>`).join('')}
    </div>

    <div class="card block">
      <h3>Session length</h3>
      <div class="row">
        ${[10, 20, 40].map((n) => `<button class="btn ${n === 20 ? '' : 'secondary'}" data-start="${n}">${n} questions</button>`).join('')}
      </div>
      <p class="next-hint">${s.due + s.fresh === 0
        ? 'Everything in this group is scheduled for later. Starting a session will practise it early.'
        : `${s.due} due and ${s.fresh} new in this group. Overdue items come first, then the newest.`}</p>
    </div>

    <div class="card block" style="margin-top:14px">
      <h3>How it works</h3>
      <p class="muted" style="margin:0">Each item climbs three rungs: pick it from four options, then fill it into one
      of your own example sentences, then produce it from the Vietnamese with nothing to copy from. Two clean answers
      move it up; forgetting it moves it back down. Intervals come from FSRS-6, the scheduler Anki itself now uses.</p>
    </div>`;

  view.querySelectorAll('[data-scope]').forEach((b) =>
    b.addEventListener('click', () => { state.filter = b.dataset.scope; renderReview(); }));
  view.querySelectorAll('[data-start]').forEach((b) =>
    b.addEventListener('click', () => startSession(Number(b.dataset.start))));
}

function startSession(limit) {
  const scope = SCOPES[state.filter] || SCOPES.all;
  const pool = scope.types ? state.items.filter((i) => scope.types.includes(i.type)) : state.items;
  const queue = R.buildQueue(pool, state.progress, { limit, kinds: scope.types });
  if (!queue.length) return;

  state.session = { queue, index: 0, right: 0, results: [], answered: false };
  renderQuestion();
}

function renderQuestion() {
  const session = state.session;
  if (session.index >= session.queue.length) return renderSummary();

  const item = session.queue[session.index];
  const q = makeQuestion(item);
  session.current = q;
  session.startedAt = Date.now();
  session.hintUsed = false;

  const top = maxLevelFor(item);
  const ladder = Array.from({ length: top + 1 },
    (_, i) => `<i class="${i <= q.level ? 'on' : ''}"></i>`).join('');

  view.innerHTML = `
    <div class="quizbar">
      <button class="btn small secondary" id="quit">Stop</button>
      <div class="progressbar"><i style="width:${(session.index / session.queue.length) * 100}%"></i></div>
      <span class="quizcount">${session.index + 1} / ${session.queue.length}</span>
    </div>

    <div class="card quiz">
      <div class="quiz-mode">
        <span>${esc(q.mode)}</span>
        <span class="pill">${TYPE_LABEL[item.type] || item.type}</span>
        <span class="ladder" title="Level ${q.level + 1} of ${top + 1}">${ladder}</span>
      </div>

      <p class="prompt">${q.promptHtml}</p>
      ${q.subHtml ? `<p class="prompt-sub">${q.subHtml}</p>` : ''}

      <div id="answer-area">
        ${q.kind === 'choice'
          ? `<div class="options">${q.options.map((o, i) =>
              `<button class="option" data-opt="${i}">${esc(o)}</button>`).join('')}</div>`
          : `<input class="answer" id="typed" autocomplete="off" autocorrect="off"
                    autocapitalize="off" spellcheck="false"
                    placeholder="${q.multiline ? 'Rewrite it correctly' : 'Type your answer'}">
             <div class="row" style="margin-top:12px">
               <button class="btn" id="check">Check</button>
               ${q.hint ? '<button class="btn secondary small" id="hint">Hint</button>' : ''}
               <span class="spacer"></span>
               <button class="btn secondary small" id="dunno">I don't know</button>
             </div>`}
      </div>

      <div id="verdict"></div>
    </div>`;

  document.getElementById('quit').addEventListener('click', () => { state.session = null; renderReview(); });

  if (q.kind === 'choice') {
    view.querySelectorAll('[data-opt]').forEach((btn) => btn.addEventListener('click', () => {
      const chosen = q.options[Number(btn.dataset.opt)];
      answer(chosen === q.correct ? R.Rating.Good : R.Rating.Again,
             chosen === q.correct ? 'exact' : 'wrong', chosen);
    }));
  } else {
    const input = document.getElementById('typed');
    input.focus();
    const submit = () => {
      const typed = input.value.trim();
      if (!typed) return;
      const elapsed = Date.now() - session.startedAt;
      const result = R.grade(typed, q.accepted, session.hintUsed ? null : elapsed, { strict: !!q.strict });
      answer(result.rating, result.verdict, typed);
    };
    document.getElementById('check').addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    document.getElementById('dunno').addEventListener('click', () => answer(R.Rating.Again, 'wrong', ''));
    const hint = document.getElementById('hint');
    if (hint) hint.addEventListener('click', () => {
      session.hintUsed = true;
      const word = q.hint;
      input.placeholder = `${word[0]}${'·'.repeat(Math.max(0, word.replace(/\s/g, '').length - 1))}`;
      input.focus();
      hint.disabled = true;
    });
  }
}

const VERDICT_TEXT = {
  exact: ['Correct', ''],
  typo: ['Almost — just a typo', 'Counted as a shaky recall.'],
  form: ['Right word, wrong form', 'The sentence needs the form shown above.'],
  wrong: ['Not quite', 'Dropped one rung.'],
};

/** Relative wording for the next review: a date alone is hard to feel. */
function formatDue(date) {
  const days = Math.round((date - Date.now()) / 86400000);
  if (days <= 0) return 'later today';
  if (days === 1) return 'tomorrow';
  if (days < 30) return `in ${days} days`;
  if (days < 365) return `in ${Math.round(days / 30)} months`;
  return `in ${(days / 365).toFixed(1)} years`;
}

function answer(rating, verdict, given) {
  const session = state.session;
  const q = session.current;
  const item = q.item;

  R.applyRating(state.progress, item.id, rating, {
    mode: q.mode, verdict, maxLevel: maxLevelFor(item),
  });
  save();

  if (verdict === 'exact') session.right += 1;
  session.results.push({ id: item.id, term: item.term, verdict, given, solution: q.solution });

  // Lock the answer area, then show what was right.
  const area = document.getElementById('answer-area');
  if (q.kind === 'choice') {
    area.querySelectorAll('[data-opt]').forEach((btn, i) => {
      btn.disabled = true;
      if (q.options[i] === q.correct) btn.dataset.state = 'right';
      else if (q.options[i] === given) btn.dataset.state = 'wrong';
    });
  } else {
    const input = document.getElementById('typed');
    input.value = given;
    input.disabled = true;
    input.dataset.state = verdict;
    area.querySelectorAll('button').forEach((b) => b.disabled = true);
  }

  const [head, note] = VERDICT_TEXT[verdict] || VERDICT_TEXT.wrong;
  const showSolution = verdict !== 'exact';
  const nextAt = R.dueDate(state.progress, item.id);
  document.getElementById('verdict').innerHTML = `
    <div class="verdict ${verdict}">
      <div class="verdict-head">${head}</div>
      <div class="verdict-body">
        ${showSolution ? `<div class="solution">${esc(q.solution)}</div>` : ''}
        ${q.after ? `<div class="muted" style="margin-top:6px">${q.after}</div>` : ''}
        ${showSolution && item.meaning ? `<div class="muted" style="margin-top:6px">${esc(item.meaning)}</div>` : ''}
      </div>
      <div class="next-hint">${note} ${nextAt ? `Back ${formatDue(nextAt)}.` : ''}</div>
      ${verdict === 'wrong' || verdict === 'typo' || verdict === 'form'
        ? '<button class="override" id="knew">I actually knew this — count it as correct</button>' : ''}
    </div>
    <div class="row" style="margin-top:16px">
      <button class="btn" id="next">${session.index + 1 >= session.queue.length ? 'Finish' : 'Next'}</button>
      <a class="btn secondary small" href="#/item/${encodeURIComponent(item.id)}">Open the full note</a>
    </div>`;

  const next = document.getElementById('next');
  next.focus();
  next.addEventListener('click', advance);
  document.addEventListener('keydown', onEnterNext);

  const knew = document.getElementById('knew');
  if (knew) knew.addEventListener('click', () => {
    R.applyRating(state.progress, item.id, R.Rating.Good, { mode: q.mode, verdict: 'override', maxLevel: maxLevelFor(item) });
    save();
    knew.textContent = 'Counted as correct.';
    knew.disabled = true;
  });
}

function onEnterNext(e) {
  if (e.key === 'Enter') { e.preventDefault(); advance(); }
}

function advance() {
  document.removeEventListener('keydown', onEnterNext);
  state.session.index += 1;
  renderQuestion();
}

function renderSummary() {
  const session = state.session;
  const total = session.results.length;
  const right = session.results.filter((r) => r.verdict === 'exact').length;
  const shaky = session.results.filter((r) => r.verdict === 'typo' || r.verdict === 'form');
  const missed = session.results.filter((r) => r.verdict === 'wrong');

  const list = (rows, cls) => rows.map((r) => `
    <a class="weak-row" href="#/item/${encodeURIComponent(r.id)}">
      <span class="pill ${cls}">${cls === 'bad' ? 'missed' : 'close'}</span>
      <b>${esc(r.term)}</b>
      <span class="spacer"></span>
      <span class="muted">${esc(r.solution)}</span>
    </a>`).join('');

  view.innerHTML = `
    <h2 class="section">Session done</h2>
    <p class="lede">${right} of ${total} correct first time.</p>
    <div class="statgrid">
      <div class="card stat"><b>${right}</b><span>correct</span></div>
      <div class="card stat"><b>${shaky.length}</b><span>close</span></div>
      <div class="card stat"><b>${missed.length}</b><span>missed</span></div>
      <div class="card stat"><b>${Math.round((right / Math.max(total, 1)) * 100)}%</b><span>accuracy</span></div>
    </div>
    ${missed.length ? `<div class="card block"><h3>Worth another look</h3><div class="weak">${list(missed, 'bad')}</div></div>` : ''}
    ${shaky.length ? `<div class="card block"><h3>Nearly there</h3><div class="weak">${list(shaky, 'warn')}</div></div>` : ''}
    <div class="row" style="margin-top:18px">
      <button class="btn" id="again">Another session</button>
      <button class="btn secondary" id="done">Done for now</button>
    </div>`;

  document.getElementById('again').addEventListener('click', () => { state.session = null; startSession(session.queue.length); });
  document.getElementById('done').addEventListener('click', () => { state.session = null; renderReview(); });
}

// ------------------------------------------------------------ lookup view --

function searchScore(item, q) {
  const term = item.term.toLowerCase();
  if (term === q) return 100;
  if (term.startsWith(q)) return 80;
  if (term.includes(q)) return 60;
  if ((item.meaning || '').toLowerCase().includes(q)) return 40;
  if ((item.vi || '').toLowerCase().includes(q)) return 35;
  if ((item.rule || '').toLowerCase().includes(q)) return 30;
  if ((item.tags || []).some((t) => t.toLowerCase().includes(q))) return 20;
  if ((item.examples || []).some((e) => (e.text || '').toLowerCase().includes(q))) return 15;
  return 0;
}

function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

function renderLookup() {
  const q = state.query.trim().toLowerCase();
  const scope = SCOPES[state.filter] || SCOPES.all;
  let rows = state.items.filter((i) => !scope.types || scope.types.includes(i.type));
  if (q) {
    rows = rows.map((i) => [searchScore(i, q), i]).filter(([s]) => s > 0)
               .sort((a, b) => b[0] - a[0] || a[1].term.localeCompare(b[1].term)).map(([, i]) => i);
  } else {
    rows = [...rows].sort((a, b) => String(b.added).localeCompare(String(a.added)) || a.term.localeCompare(b.term));
  }

  view.innerHTML = `
    <h2 class="section">Look up</h2>
    <p class="lede">Everything recorded in the vault — ${state.items.length} items.</p>
    <div class="searchwrap">
      <input class="search" id="q" placeholder="Search a word, a meaning, or Vietnamese…"
             value="${esc(state.query)}" autocomplete="off" spellcheck="false">
    </div>
    <div class="filters" role="group" aria-label="Filter by type">
      ${Object.entries(SCOPES).map(([key, cfg]) => `
        <button class="chip" data-scope="${key}" aria-pressed="${state.filter === key}">${cfg.label}</button>`).join('')}
    </div>
    <div class="results">
      ${rows.length ? rows.slice(0, 300).map((i) => resultRow(i, q)).join('')
                    : '<p class="empty">Nothing matches that.</p>'}
    </div>
    ${rows.length > 300 ? `<p class="next-hint">Showing the first 300 of ${rows.length}.</p>` : ''}`;

  const input = document.getElementById('q');
  input.addEventListener('input', () => {
    state.query = input.value;
    const start = input.selectionStart;
    renderLookup();
    const again = document.getElementById('q');
    again.focus();
    again.setSelectionRange(start, start);
  });
  view.querySelectorAll('[data-scope]').forEach((b) =>
    b.addEventListener('click', () => { state.filter = b.dataset.scope; renderLookup(); }));
}

function resultRow(item, q) {
  const gloss = item.meaning || (item.rule || '').replace(/\*\*/g, '').replace(/\*/g, '');
  const level = levelOf(item);
  const seen = state.progress.cards[item.id];
  return `
    <a class="result" href="#/item/${encodeURIComponent(item.id)}">
      <div class="result-top">
        <span class="result-term">${highlight(item.term, q)}</span>
        ${item.ipa ? `<span class="result-ipa">${esc(item.ipa)}</span>` : ''}
        <span class="spacer"></span>
        ${seen ? `<span class="pill ${level === maxLevelFor(item) ? 'good' : 'accent'}">${['recognise', 'gap-fill', 'produce'][level]}</span>` : ''}
        <span class="pill">${TYPE_LABEL[item.type] || item.type}</span>
      </div>
      <div class="result-gloss">${highlight(gloss, q)}</div>
      ${item.vi ? `<div class="result-vi">${highlight(item.vi, q)}</div>` : ''}
    </a>`;
}

// -------------------------------------------------------------- item view --

function renderItem(id) {
  const item = state.byId.get(id);
  if (!item) { view.innerHTML = '<p class="empty">No note for that.</p>'; return; }

  const record = state.progress.cards[item.id];
  const due = R.dueDate(state.progress, item.id);
  const recall = R.retrievability(state.progress, item.id);

  const examples = (item.examples || []).filter((e) => e.html);
  const senses = item.senses || [];

  view.innerHTML = `
    <a class="backlink" href="#/lookup">← Back to look up</a>

    <div class="card item-head">
      <h2 class="item-term">${esc(item.term)}</h2>
      ${item.ipa ? `<p class="item-ipa">${esc(item.ipa)}</p>` : ''}
      ${item.meaning ? `<p class="item-meaning">${esc(item.meaning)}</p>` : ''}
      ${item.ruleHtml && !item.meaning ? `<div class="item-meaning">${item.ruleHtml}</div>` : ''}
      ${item.vi ? `<p class="item-vi">${esc(item.vi)}</p>` : ''}
      <div class="item-meta">
        <span class="pill accent">${TYPE_LABEL[item.type] || item.type}</span>
        ${item.cefr ? `<span class="pill">${esc(item.cefr.toUpperCase())}</span>` : ''}
        ${(item.pos || []).filter((p) => p.toLowerCase() !== (TYPE_LABEL[item.type] || '').toLowerCase())
             .map((p) => `<span class="pill">${esc(p)}</span>`).join('')}
        ${item.register ? `<span class="pill">${esc(item.register)}</span>` : ''}
        ${item.frequency ? `<span class="pill warn">${esc(item.frequency)}</span>` : ''}
        ${item.added ? `<span class="pill">added ${esc(item.added)}</span>` : ''}
      </div>
    </div>

    ${senses.length ? `
      <div class="card block"><h3>Senses</h3>
        <ol class="senses">${senses.map((s) => `
          <li>
            <div><span class="sense-gloss">${esc(s.gloss)}</span>
              ${s.vi ? ` — <span class="sense-vi">${esc(s.vi)}</span>` : ''}</div>
            ${s.example && s.example.html ? `<div class="sense-ex">${s.example.html}</div>` : ''}
          </li>`).join('')}</ol>
      </div>` : ''}

    ${examples.length ? `
      <div class="card block"><h3>Examples</h3>
        <ul>${examples.map((e) => `<li>${e.html.replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>
      </div>` : ''}

    ${(item.wrongHtml || []).length ? `
      <div class="card block"><h3>Wrong</h3>
        <ul>${item.wrongHtml.map((h) => `<li class="wrongline">${h.replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>
      </div>` : ''}
    ${(item.correctHtml || []).length ? `
      <div class="card block"><h3>Correct</h3>
        <ul>${item.correctHtml.map((h) => `<li class="rightline">${h.replace(/^<p>|<\/p>$/g, '')}</li>`).join('')}</ul>
      </div>` : ''}

    ${item.notesHtml ? `<div class="card block"><h3>Notes</h3>${item.notesHtml}</div>` : ''}

    ${(item.seeAlso || []).length ? `
      <div class="card block"><h3>See also</h3>
        ${item.seeAlso.map((t) => `<a class="chiplink" href="#/item/${encodeURIComponent(t)}">${esc(t)}</a>`).join('')}
      </div>` : ''}

    <div class="card block">
      <h3>Your progress</h3>
      ${record ? `
        <div class="row" style="gap:16px">
          <span>Level <b>${['recognise', 'gap-fill', 'produce'][levelOf(item)]}</b></span>
          <span class="muted">seen ${record.seen}×</span>
          ${record.lapses ? `<span class="muted">forgotten ${record.lapses}×</span>` : ''}
          ${due ? `<span class="muted">next ${due.toLocaleDateString()}</span>` : ''}
          ${recall != null ? `<span class="muted">recall ${Math.round(recall * 100)}%</span>` : ''}
        </div>` : '<p class="muted" style="margin:0">Not practised yet.</p>'}
      ${item.session ? `<p class="next-hint">From session ${esc(item.session)}</p>` : ''}
    </div>`;

  view.querySelectorAll('a.xref').forEach((a) => {
    a.setAttribute('href', `#/item/${encodeURIComponent(a.dataset.term)}`);
  });
}

// ---------------------------------------------------------- progress view --

function renderProgress() {
  const s = R.stats(state.items, state.progress);
  const cards = state.progress.cards;
  const studied = state.items.filter((i) => cards[i.id]);

  const rungs = [0, 1, 2].map((lvl) => studied.filter((i) => levelOf(i) === lvl).length);
  const rungLabels = ['Recognise', 'Gap-fill', 'Produce'];
  const maxRung = Math.max(1, ...rungs);

  const byType = {};
  for (const item of state.items) {
    const key = TYPE_LABEL[item.type] || item.type;
    byType[key] = byType[key] || { total: 0, done: 0 };
    byType[key].total += 1;
    if (cards[item.id]) byType[key].done += 1;
  }

  const weak = studied
    .map((i) => ({ item: i, record: cards[i.id] }))
    .filter((x) => x.record.lapses > 0)
    .sort((a, b) => b.record.lapses - a.record.lapses || a.record.correct / Math.max(a.record.seen, 1) - b.record.correct / Math.max(b.record.seen, 1))
    .slice(0, 12);

  const reviews = state.progress.history.length;
  const today = new Date().toDateString();
  const todayCount = state.progress.history.filter((h) => new Date(h.at).toDateString() === today).length;

  view.innerHTML = `
    <h2 class="section">Progress</h2>
    <p class="lede">Stored in this browser only — export it if you want it on another device.</p>

    <div class="statgrid">
      <div class="card stat"><b>${studied.length}</b><span>started</span></div>
      <div class="card stat"><b>${s.mature}</b><span>solid</span></div>
      <div class="card stat"><b>${todayCount}</b><span>answered today</span></div>
      <div class="card stat"><b>${reviews}</b><span>answers total</span></div>
    </div>

    <div class="card block">
      <h3>How far each item has climbed</h3>
      <div class="bars">
        ${rungs.map((n, i) => `
          <div class="bar-row">
            <span>${rungLabels[i]}</span>
            <span class="bar"><i style="width:${(n / maxRung) * 100}%"></i></span>
            <span class="bar-num">${n}</span>
          </div>`).join('')}
      </div>
      <p class="next-hint">Producing a word from the Vietnamese is the rung that matters — recognising it is the easy half.</p>
    </div>

    <div class="card block">
      <h3>Coverage by type</h3>
      <div class="bars">
        ${Object.entries(byType).sort((a, b) => b[1].total - a[1].total).map(([label, v]) => `
          <div class="bar-row">
            <span>${esc(label)}</span>
            <span class="bar"><i style="width:${(v.done / v.total) * 100}%"></i></span>
            <span class="bar-num">${v.done}/${v.total}</span>
          </div>`).join('')}
      </div>
    </div>

    ${weak.length ? `
      <div class="card block">
        <h3>Trips you up most</h3>
        <div class="weak">
          ${weak.map((x) => `
            <a class="weak-row" href="#/item/${encodeURIComponent(x.item.id)}">
              <span class="pill bad">${x.record.lapses}×</span>
              <b>${esc(x.item.term)}</b>
              <span class="spacer"></span>
              <span class="muted">${esc(x.item.meaning || '')}</span>
            </a>`).join('')}
        </div>
      </div>` : ''}

    <div class="card block">
      <h3>Backup</h3>
      <div class="row">
        <button class="btn secondary small" id="export">Export progress</button>
        <button class="btn secondary small" id="import">Import progress</button>
        <span class="spacer"></span>
        <button class="btn secondary small" id="reset">Reset everything</button>
      </div>
      <p class="next-hint">Progress lives in this browser's storage. Clearing site data wipes it, and it does not follow you to another device on its own.</p>
      <input type="file" id="file" accept="application/json" hidden>
    </div>`;

  document.getElementById('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.progress)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `english-review-progress-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const file = document.getElementById('file');
  document.getElementById('import').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    if (!file.files.length) return;
    try {
      const data = JSON.parse(await file.files[0].text());
      if (!data.cards) throw new Error('not a progress file');
      state.progress = { ...R.loadProgress(), ...data };
      save();
      renderProgress();
    } catch (err) {
      alert(`Could not read that file: ${err.message}`);
    }
  });

  document.getElementById('reset').addEventListener('click', () => {
    if (!confirm('Delete all progress and scheduling on this device? This cannot be undone.')) return;
    state.progress = { cards: {}, history: [], settings: { retention: 0.9 } };
    save();
    renderProgress();
  });
}

// ----------------------------------------------------------------- theme ---

const themeBtn = document.getElementById('theme-toggle');
const stored = (() => { try { return localStorage.getItem('english-review/theme'); } catch { return null; } })();
if (stored) document.documentElement.dataset.theme = stored;
themeBtn.addEventListener('click', () => {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const current = document.documentElement.dataset.theme || (dark ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('english-review/theme', next); } catch { /* private window */ }
});

boot();

// Exported for the browser test harness.
export { makeQuestion, maxLevelFor, levelOf, state };
