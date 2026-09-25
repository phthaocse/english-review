// Capture: get a word out of your head (or off a notebook page) and into the
// store, from whatever device you are holding.
//
// The photo path never stores anything on its own. Gemini returns a draft, you
// correct it on the review screen, and only what you confirm is saved — which
// is also what keeps an unverified reading from becoming a finished note.

import { api, ApiError, currentUser, onAuthChange, renderSignInButton, signOut } from './auth-client.js';

const KINDS = [
  ['word', 'Word'], ['phrasal-verb', 'Phrasal verb'], ['idiom', 'Idiom'],
  ['collocation', 'Collocation'], ['conversational', 'Conversational'],
  ['grammar-pattern', 'Grammar pattern'],
];

// Phone photos are far larger than the model needs; a 1600px long edge reads
// handwriting just as well and keeps the upload quick on mobile data.
const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.85;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let draft = [];      // items awaiting review
let recent = [];
let mode = 'type';

export function renderCapture(view) {
  const user = currentUser();
  if (!user) return renderSignedOut(view);

  view.innerHTML = `
    <div class="row" style="margin-bottom:6px">
      <h2 class="section" style="margin:0">Capture</h2>
      <span class="spacer"></span>
      <span class="muted" style="font-size:.85rem">${esc(user.email)}</span>
      <button class="btn secondary small" id="signout">Sign out</button>
    </div>
    <p class="lede">Get it down now; tidy it up on the Mac later.</p>

    <div class="filters" role="group" aria-label="How to capture">
      <button class="chip" data-mode="type" aria-pressed="${mode === 'type'}">Type it</button>
      <button class="chip" data-mode="photo" aria-pressed="${mode === 'photo'}">Photograph a page</button>
    </div>

    <div id="capture-body"></div>
    <div id="draft-area"></div>
    <div id="recent-area"></div>`;

  view.querySelector('#signout').addEventListener('click', () => { signOut(); renderCapture(view); });
  view.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => { mode = b.dataset.mode; renderCapture(view); }));

  (mode === 'type' ? renderTypeForm : renderPhotoForm)(view);
  renderDraft(view);
  loadRecent(view);
}

function renderSignedOut(view) {
  view.innerHTML = `
    <h2 class="section">Capture</h2>
    <p class="lede">Sign in to add to your knowledge base.</p>
    <div class="card block" style="text-align:center; padding:40px 22px">
      <div id="gsi-button" style="display:flex; justify-content:center"></div>
      <p class="next-hint" style="margin-top:18px">Only accounts on the allowlist can sign in.</p>
    </div>`;
  renderSignInButton(view.querySelector('#gsi-button')).catch((e) => {
    view.querySelector('#gsi-button').innerHTML = `<span class="muted">${esc(e.message)}</span>`;
  });
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
      await api('/api/items', { method: 'POST', body: {
        term: data.term, kind: data.kind, meaning: data.meaning, vi: data.vi,
        source: 'typed', source_note: data.source_note,
        examples: data.example ? [data.example] : [],
      }});
      form.reset();
      form.querySelector('[name=term]').focus();
      status.textContent = 'Saved.';
      loadRecent(view);
    } catch (error) {
      status.textContent = error instanceof ApiError && error.status === 409
        ? 'You already have that one.' : error.message;
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
      <div class="row">
        <button class="btn" id="pick">Take or choose a photo</button>
        <span id="photo-status" class="muted" style="font-size:.88rem"></span>
      </div>
      <div id="preview" style="margin-top:14px"></div>
    </div>`;

  const input = view.querySelector('#photo');
  const status = view.querySelector('#photo-status');
  view.querySelector('#pick').addEventListener('click', () => input.click());

  input.addEventListener('change', async () => {
    if (!input.files?.length) return;
    status.textContent = 'Preparing the image…';
    try {
      const image = await prepareImage(input.files[0]);
      view.querySelector('#preview').innerHTML =
        `<img src="${image.preview}" alt="The page you photographed"
              style="max-width:100%; border-radius:10px; border:1px solid var(--border)">`;
      status.textContent = 'Reading the handwriting…';
      const result = await api('/api/vision', { method: 'POST', body: {
        image: image.base64, mimeType: 'image/jpeg',
      }});
      draft = result.items.map((item) => ({ ...item, keep: true }));
      status.textContent = draft.length
        ? `Found ${draft.length} item${draft.length === 1 ? '' : 's'} — check them below.`
        : 'No English study notes found in that photo.';
      renderDraft(view);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      input.value = '';
    }
  });
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
              <span class="spacer"></span>
              <select class="draft-kind" data-field="kind" data-i="${i}">
                ${KINDS.map(([v, l]) => `<option value="${v}" ${v === item.kind ? 'selected' : ''}>${l}</option>`).join('')}
              </select>
            </div>
            <input class="answer" data-field="term" data-i="${i}" value="${esc(item.term)}" placeholder="term">
            <input class="answer" data-field="meaning" data-i="${i}" value="${esc(item.meaning || '')}" placeholder="meaning (optional)">
            <input class="answer" data-field="vi" data-i="${i}" value="${esc(item.vi || '')}" placeholder="Vietnamese (optional)">
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
  const problems = [];

  for (const item of keeping) {
    status.textContent = `Saving ${saved + 1} of ${keeping.length}…`;
    try {
      await api('/api/items', { method: 'POST', body: {
        term: item.term, kind: item.kind, meaning: item.meaning, vi: item.vi,
        source: 'photo', source_note: item.source_note,
        examples: item.example ? [item.example] : [],
      }});
      saved += 1;
    } catch (error) {
      problems.push(`${item.term}: ${error.status === 409 ? 'already saved' : error.message}`);
    }
  }

  draft = problems.length ? draft.filter((d) => problems.some((p) => p.startsWith(`${d.term}:`))) : [];
  renderDraft(view);
  const area = view.querySelector('#draft-status');
  if (area) area.textContent = problems.length ? problems.join('; ') : '';
  if (!problems.length) {
    view.querySelector('#capture-body')?.insertAdjacentHTML('afterbegin',
      `<p class="muted" style="margin:0 0 10px">Saved ${saved} item${saved === 1 ? '' : 's'}.</p>`);
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
