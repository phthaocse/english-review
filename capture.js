// Capture: get a word out of your head (or off a notebook page) and into the
// store, from whatever device you are holding.
//
// The photo path never stores anything on its own. Gemini returns a draft, you
// correct it on the review screen, and only what you confirm is saved — which
// is also what keeps an unverified reading from becoming a finished note.

import { api, ApiError, onAuthChange } from './auth-client.js';

const KINDS = [
  ['word', 'Word'], ['phrasal-verb', 'Phrasal verb'], ['idiom', 'Idiom'],
  ['collocation', 'Collocation'], ['conversational', 'Conversational'],
  ['grammar-pattern', 'Grammar pattern'],
];

// Handwriting needs the pixels: shrunk to 1600px the model read 1 item of 5 and
// took 39s; at 2300px it read all 5 in 26s. The cap only bounds the upload.
const MAX_EDGE = 2400;
const JPEG_QUALITY = 0.85;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let draft = [];      // items awaiting review
let recent = [];
let mode = 'type';
let lastImage = null;   // kept so a failed read can be retried without a second photo

// A read in flight, held here rather than in the DOM. The screen is rebuilt
// whenever you come back to it, so a button marked disabled and a line counting
// seconds both vanish on the way out - and a second photo could be sent while
// the first was still being read, spending another of the day's requests.
let reading = null;     // { since } while a photo is being read

export function renderCapture(view) {
  view.innerHTML = `
    <h2 class="section">Capture</h2>
    <p class="lede">Get it down now; tidy it up on the Mac later.</p>

    <div class="filters" role="group" aria-label="How to capture">
      <button class="chip" data-mode="type" aria-pressed="${mode === 'type'}">Type it</button>
      <button class="chip" data-mode="photo" aria-pressed="${mode === 'photo'}">Photograph a page</button>
    </div>
    ${reading ? '<p class="busy" id="reading-banner">A photo is being read — wait for it rather'
              + ' than sending another, because each one costs a request.</p>' : ''}

    <div id="capture-body"></div>
    <div id="draft-area"></div>
    <div id="recent-area"></div>`;

  view.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => { mode = b.dataset.mode; renderCapture(view); }));

  (mode === 'type' ? renderTypeForm : renderPhotoForm)(view);
  renderDraft(view);
  loadRecent(view);
}

// ------------------------------------------------------------------ typing --

function renderTypeForm(view) {
  view.querySelector('#capture-body').innerHTML = `
    <form class="card block" id="type-form">
      <h3>New item</h3>
      <label class="field"><span>Word or phrase</span>
        <input class="answer" name="term" required autocomplete="off" placeholder="brittle"></label>
      <label class="field"><span>Kind</span>
        <select class="answer" name="kind">
          ${KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
        </select></label>
      <label class="field"><span>Meaning <em class="muted">optional</em></span>
        <input class="answer" name="meaning" autocomplete="off" placeholder="hard but easily broken"></label>
      <label class="field"><span>Vietnamese <em class="muted">optional</em></span>
        <input class="answer" name="vi" autocomplete="off" placeholder="giòn, dễ vỡ"></label>
      <label class="field"><span>Pattern <em class="muted">the preposition or structure it takes</em></span>
        <input class="answer" name="pattern" autocomplete="off"
               placeholder="spend + on / + -ing (not for)"></label>
      <label class="field"><span>Example <em class="muted">wrap the target in **asterisks**</em></span>
        <input class="answer" name="example" autocomplete="off"
               placeholder="The service was **brittle** under load."></label>
      <label class="field"><span>Where you met it <em class="muted">optional</em></span>
        <input class="answer" name="source_note" autocomplete="off" placeholder="OpenAI storage blog"></label>
      <div class="row" style="margin-top:14px">
        <button class="btn" type="submit">Save</button>
        <span id="type-status" class="muted" style="font-size:.88rem"></span>
      </div>
    </form>`;

  const form = view.querySelector('#type-form');
  const status = view.querySelector('#type-status');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    status.textContent = 'Saving…';
    try {
      const { merged } = await api('/api/items', { method: 'POST', body: {
        term: data.term, kind: data.kind, meaning: data.meaning, vi: data.vi,
        pattern: data.pattern, source: 'typed', source_note: data.source_note,
        examples: data.example ? [data.example] : [],
      }});
      form.reset();
      form.querySelector('[name=term]').focus();
      status.textContent = merged ? mergeReport(data.term, merged) : 'Saved.';
      loadRecent(view);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
      setTimeout(() => { if (status.textContent === 'Saved.') status.textContent = ''; }, 2500);
    }
  });
}

// ------------------------------------------------------------------- photo --

/** Shrink and re-encode in the browser, so the upload is small on mobile data. */
async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
  return { base64: dataUrl.split(',')[1], preview: dataUrl, width: canvas.width, height: canvas.height };
}

function renderPhotoForm(view) {
  view.querySelector('#capture-body').innerHTML = `
    <div class="card block">
      <h3>Photograph your notebook</h3>
      <p class="muted" style="margin-top:0">A draft comes back for you to check. Nothing is saved until you confirm it.</p>
      <input type="file" id="photo" accept="image/*" capture="environment" hidden>
      <button class="btn wide" id="pick" ${reading ? 'disabled' : ''}>${
        reading ? 'Reading a photo…' : 'Take or choose a photo'}</button>
      <p class="reading" id="photo-status" ${reading ? '' : 'hidden'}></p>
      <div id="photo-error"></div>
      <div id="preview"></div>
      <details class="diag" id="diag" hidden>
        <summary>Recent reads</summary>
        <div id="diag-body"></div>
      </details>
    </div>`;

  const input = view.querySelector('#photo');
  view.querySelector('#pick').addEventListener('click', () => { if (!reading) input.click(); });

  // Coming back mid-read: pick the count up where it left off.
  reflectReading(view);

  input.addEventListener('change', async () => {
    if (!input.files?.length || reading) return;
    const status = view.querySelector('#photo-status');
    status.hidden = false;
    status.textContent = 'Preparing the image…';
    try {
      lastImage = await prepareImage(input.files[0]);
      showPreview(view, lastImage);
      await readPhoto(view);
    } catch (error) {
      showReadError(view, error);
    } finally {
      input.value = '';      // so picking the same file again still fires
    }
  });

  loadDiagnostics(view);
}

/** Small by default: the draft to check matters more than the photo of it. */
function showPreview(view, image) {
  view.querySelector('#preview').innerHTML = `
    <details class="shot">
      <summary>Photo</summary>
      <img src="${image.preview}" alt="The page you photographed">
    </details>`;
}

/**
 * What a repeat did, in words. "Already saved" was the old answer, and it threw
 * away the reason you photographed the word a second time.
 */
function mergeReport(term, merged) {
  const parts = [];
  if (merged.examples) parts.push(`${merged.examples} new example${merged.examples > 1 ? 's' : ''}`);
  if (merged.fields.length) parts.push(merged.fields.join(', '));
  return parts.length
    ? `Added to ${term}: ${parts.join(' and ')}.`
    : `You already have ${term}, and nothing here was new.`;
}

/** Send the photo already in hand. Separate so a retry costs no second photo. */
/**
 * Put `reading` on the screen: the picker, the counting line and the warning.
 *
 * One function, re-found in the live document each time, because the screen is
 * rebuilt whenever you leave and come back. Holding those nodes in a closure is
 * what used to lose the guard and let a second photo go out.
 */
function reflectReading(view) {
  const pick = view.querySelector('#pick');
  if (pick) {
    pick.disabled = !!reading;
    pick.textContent = reading ? 'Reading a photo…' : 'Take or choose a photo';
  }

  const status = view.querySelector('#photo-status');
  if (status && reading) {
    // A read can take a minute on the free tier, and a line that never changes
    // looks like a hang, so it counts up.
    const seconds = Math.round((Date.now() - reading.since) / 1000);
    status.hidden = false;
    status.textContent = seconds > 25
      ? `Reading the handwriting… ${seconds}s — it is slow when the free tier is busy`
      : `Reading the handwriting… ${seconds}s`;
  }

  const banner = view.querySelector('#reading-banner');
  if (banner && !reading) banner.remove();
}

async function readPhoto(view) {
  view.querySelector('#photo-error').innerHTML = '';
  reading = { since: Date.now() };
  reflectReading(view);
  const tick = setInterval(() => reflectReading(view), 1000);

  // Idempotent, and called before the result is drawn, so whatever renders next
  // renders into an unlocked screen.
  const stop = () => { clearInterval(tick); reading = null; reflectReading(view); };

  try {
    const result = await api('/api/vision', { method: 'POST', body: {
      image: lastImage.base64, mimeType: 'image/jpeg',
    }});
    draft = result.items.map((item) => ({ ...item, keep: true }));
    stop();
    const status = view.querySelector('#photo-status');
    if (status) status.textContent = draft.length
      ? `Found ${draft.length} item${draft.length === 1 ? '' : 's'} — check them below.`
      : 'No English study notes found in that photo.';
    renderDraft(view);
  } catch (error) {
    stop();
    const status = view.querySelector('#photo-status');
    if (status) status.hidden = true;
    showReadError(view, error);
  } finally {
    stop();
    loadDiagnostics(view);
  }
}

function showReadError(view, error) {
  const box = view.querySelector('#photo-error');
  if (!box) return;
  const spent = /quota/i.test(error.message);
  box.innerHTML = `
    <div class="alert" role="alert">
      <p class="alert-msg">${esc(error.message)}</p>
      <div class="row">
        ${lastImage && !spent ? '<button class="btn" id="retry">Try again</button>' : ''}
        <button class="btn secondary" id="type-instead">Type it instead</button>
        ${error.trace ? `<span class="muted mono">log #${esc(error.trace)}</span>` : ''}
      </div>
    </div>`;

  box.querySelector('#retry')?.addEventListener('click', () => readPhoto(view));
  box.querySelector('#type-instead')?.addEventListener('click', () => {
    mode = 'type';
    renderCapture(view);
  });
}

// -------------------------------------------------------------- what happened --

/** The last few reads, so a failure can be explained without the terminal. */
async function loadDiagnostics(view) {
  const panel = view.querySelector('#diag');
  const body = view.querySelector('#diag-body');
  if (!panel || !body) return;

  let logs = [];
  try {
    ({ logs } = await api('/api/logs?limit=8'));
  } catch {
    panel.hidden = true;
    return;
  }
  if (!logs.length) { panel.hidden = true; return; }

  panel.hidden = false;
  body.innerHTML = `
    <table class="log">
      <tbody>${logs.map((log) => `
        <tr class="${log.ok ? '' : 'bad'}">
          <td>${log.ok ? '✓' : '✕'}</td>
          <td class="mono">${esc(when(log.at))}</td>
          <td class="mono">${(log.duration_ms / 1000).toFixed(1)}s</td>
          <td>${esc(log.ok ? `${log.model} · ${log.items} item${log.items === 1 ? '' : 's'}` : log.error)}</td>
        </tr>
        <tr class="log-detail"><td></td><td colspan="3" class="mono muted">
          #${log.id} · ${log.image_kb ?? '?'}KB · ${esc(log.attempts.map(
            (a) => `${a.model.replace('gemini-', '')} ${a.status || 'timeout'} ${Math.round(a.ms / 1000)}s`
                   + (a.colo ? ` @${a.colo}` : '') + (a.detail ? ` (${a.detail})` : '')).join(' → '))}
        </td></tr>`).join('')}
      </tbody>
    </table>
    <button class="btn secondary small" id="copy-log">Copy for support</button>`;

  body.querySelector('#copy-log').addEventListener('click', async (e) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
      e.target.textContent = 'Copied';
    } catch {
      e.target.textContent = 'Could not copy';
    }
  });
}

/** Times come back as UTC from SQLite; show them in the reader's own clock. */
function when(at) {
  const parsed = new Date(`${String(at).replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? String(at)
    : parsed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ------------------------------------------------------------ review screen --

function renderDraft(view) {
  const area = view.querySelector('#draft-area');
  if (!area) return;
  if (!draft.length) { area.innerHTML = ''; return; }

  area.innerHTML = `
    <div class="card block">
      <h3>Check before saving</h3>
      <p class="muted" style="margin-top:0">Edit anything that was misread. Untick what you don't want.</p>
      <div class="drafts">
        ${draft.map((item, i) => `
          <div class="draft ${item.keep ? '' : 'dropped'}" data-i="${i}">
            <div class="draft-head">
              <label class="draft-keep">
                <input type="checkbox" data-keep="${i}" ${item.keep ? 'checked' : ''}>
                <span>keep</span>
              </label>
              <span class="pill ${item.confidence === 'high' ? 'good' : item.confidence === 'low' ? 'bad' : 'warn'}">
                read ${esc(item.confidence)}</span>
              <!-- Whose definition you are looking at. Without this the model's
                   wording and Oxford's are indistinguishable on the screen. -->
              <span class="pill ${item.verified ? 'good' : ''}" title="${item.verified
                  ? 'meaning, pronunciation and level taken from Oxford'
                  : 'Oxford has no entry for this one - the meaning below is a draft'}">${
                item.verified ? 'Oxford' : 'unverified'}</span>
              <span class="spacer"></span>
              <select class="draft-kind" data-field="kind" data-i="${i}">
                ${KINDS.map(([v, l]) => `<option value="${v}" ${v === item.kind ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <input class="answer" data-field="term" data-i="${i}" value="${esc(item.term)}" placeholder="term">
            <input class="answer" data-field="meaning" data-i="${i}" value="${esc(item.meaning || '')}"
                   placeholder="${item.verified ? 'meaning' : 'meaning — no Oxford entry, so check this one'}">
            ${item.ipa || item.cefr ? `<p class="draft-dict">${item.ipa ? esc(item.ipa) : ''}${
              item.ipa && item.cefr ? ' · ' : ''}${item.cefr ? esc(item.cefr.toUpperCase()) : ''}</p>` : ''}
            <input class="answer" data-field="vi" data-i="${i}" value="${esc(item.vi || '')}" placeholder="Vietnamese (optional)">
            <input class="answer" data-field="pattern" data-i="${i}" value="${esc(item.pattern || '')}" placeholder="pattern, e.g. spend + on / + -ing (optional)">
            <input class="answer" data-field="example" data-i="${i}" value="${esc(item.example || '')}" placeholder="example (optional)">
          </div>`).join('')}
      </div>
      <div class="row" style="margin-top:16px">
        <button class="btn" id="save-draft">Save ${draft.filter((d) => d.keep).length} item(s)</button>
        <button class="btn secondary" id="discard-draft">Discard</button>
        <span id="draft-status" class="muted" style="font-size:.88rem"></span>
      </div>
    </div>`;

  area.querySelectorAll('[data-field]').forEach((el) =>
    el.addEventListener('input', () => { draft[Number(el.dataset.i)][el.dataset.field] = el.value; }));
  area.querySelectorAll('[data-keep]').forEach((el) =>
    el.addEventListener('change', () => {
      draft[Number(el.dataset.keep)].keep = el.checked;
      renderDraft(view);
    }));
  area.querySelector('#discard-draft').addEventListener('click', () => { draft = []; renderDraft(view); });
  area.querySelector('#save-draft').addEventListener('click', () => saveDraft(view));
}

async function saveDraft(view) {
  const status = view.querySelector('#draft-status');
  const button = view.querySelector('#save-draft');
  button.disabled = true;

  const keeping = draft.filter((d) => d.keep && d.term.trim());
  let saved = 0;
  const merges = [];
  const problems = [];

  for (const item of keeping) {
    status.textContent = `Saving ${saved + 1} of ${keeping.length}…`;
    try {
      const { merged } = await api('/api/items', { method: 'POST', body: {
        term: item.term, kind: item.kind, meaning: item.meaning, vi: item.vi,
        pattern: item.pattern, source: 'photo', source_note: item.source_note,
        examples: item.example ? [item.example] : [],
      }});
      saved += 1;
      if (merged) merges.push(mergeReport(item.term, merged));
    } catch (error) {
      problems.push(`${item.term}: ${error.message}`);
    }
  }

  draft = problems.length ? draft.filter((d) => problems.some((p) => p.startsWith(`${d.term}:`))) : [];
  renderDraft(view);
  const area = view.querySelector('#draft-status');
  if (area) area.textContent = problems.length ? problems.join('; ') : '';
  if (!problems.length) {
    // A word you already had is not a failure worth hiding: say what it gained.
    const note = `Saved ${saved} item${saved === 1 ? '' : 's'}.`
      + (merges.length ? ` ${merges.join(' ')}` : '');
    view.querySelector('#capture-body')?.insertAdjacentHTML('afterbegin',
      `<p class="muted" style="margin:0 0 10px">${esc(note)}</p>`);
  }
  loadRecent(view);
}

// ------------------------------------------------------------------ recent --

async function loadRecent(view) {
  const area = view.querySelector('#recent-area');
  if (!area) return;
  try {
    const { items } = await api('/api/items?limit=15');
    recent = items;
  } catch {
    area.innerHTML = '';
    return;
  }
  area.innerHTML = recent.length ? `
    <div class="card block">
      <h3>Recently captured</h3>
      <div class="weak">
        ${recent.map((i) => `
          <div class="weak-row">
            <span class="pill">${esc(i.kind)}</span>
            <b>${esc(i.term)}</b>
            <span class="spacer"></span>
            <span class="muted">${esc(i.meaning || '')}</span>
          </div>`).join('')}
      </div>
      <p class="next-hint">These stay as drafts until the Mac enriches them with pronunciation and level.</p>
    </div>` : '';
}

export { onAuthChange };
