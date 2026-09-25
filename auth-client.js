// Sign in with Google, on the browser side.
//
// Google returns an ID token (a JWT). Every API call carries it, and the Worker
// re-verifies it — the claims decoded here are for showing a name and knowing
// when to refresh, never for deciding what the user may do.

import { CONFIG } from './config.js';

const GSI_SRC = 'https://accounts.google.com/gsi/client';
// Tokens last about an hour. Renew before the end so a long capture session
// doesn't fail on submit.
const RENEW_BEFORE_MS = 5 * 60 * 1000;

let token = null;
let claims = null;
let listeners = [];
let gsiReady = null;

const notify = () => listeners.forEach((fn) => fn(currentUser()));
export const onAuthChange = (fn) => { listeners.push(fn); fn(currentUser()); };

/** Claims for display only. The Worker does the real verification. */
function decode(jwt) {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(decodeURIComponent(escape(atob(part))));
  } catch {
    return null;
  }
}

export function currentUser() {
  if (!token || !claims) return null;
  return { email: claims.email, name: claims.name, picture: claims.picture, expiresAt: claims.exp * 1000 };
}

function setToken(jwt) {
  token = jwt;
  claims = jwt ? decode(jwt) : null;
  try {
    if (jwt) sessionStorage.setItem('knowledge/idtoken', jwt);
    else sessionStorage.removeItem('knowledge/idtoken');
  } catch { /* private window */ }
  notify();
}

function loadGsi() {
  if (gsiReady) return gsiReady;
  gsiReady = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const script = document.createElement('script');
    script.src = GSI_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('could not load Google sign-in'));
    document.head.appendChild(script);
  });
  return gsiReady;
}

export async function initAuth() {
  // A token kept for this tab only: sessionStorage clears when the tab closes,
  // and it is never written to localStorage where it would outlive the visit.
  try {
    const saved = sessionStorage.getItem('knowledge/idtoken');
    if (saved) {
      const parsed = decode(saved);
      if (parsed && parsed.exp * 1000 > Date.now()) { token = saved; claims = parsed; }
    }
  } catch { /* private window */ }

  await loadGsi();
  window.google.accounts.id.initialize({
    client_id: CONFIG.googleClientId,
    callback: ({ credential }) => setToken(credential),
    auto_select: true,
    cancel_on_tap_outside: false,
  });
  notify();
}

export async function renderSignInButton(element) {
  await loadGsi();
  window.google.accounts.id.renderButton(element, {
    theme: 'outline', size: 'large', text: 'signin_with', shape: 'pill', width: 260,
  });
  window.google.accounts.id.prompt();
}

export function signOut() {
  try { window.google?.accounts?.id?.disableAutoSelect(); } catch { /* not loaded */ }
  setToken(null);
}

/** Ask Google for a fresh token without a full sign-in, if it can be silent. */
function renew() {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(currentUser()); } };
    const stop = onAuthChangeOnce(done);
    try {
      window.google.accounts.id.prompt(() => setTimeout(done, 1500));
    } catch { done(); }
    setTimeout(() => { stop(); done(); }, 4000);
  });
}

function onAuthChangeOnce(fn) {
  const wrapped = (user) => { if (user) { listeners = listeners.filter((l) => l !== wrapped); fn(user); } };
  listeners.push(wrapped);
  return () => { listeners = listeners.filter((l) => l !== wrapped); };
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/** Call the API with the current token, renewing it first if it is about to expire. */
export async function api(path, { method = 'GET', body, retryOn401 = true } = {}) {
  if (!token) throw new ApiError('not signed in', 401);
  if (claims && claims.exp * 1000 - Date.now() < RENEW_BEFORE_MS) await renew();

  const res = await fetch(`${CONFIG.apiBase}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && retryOn401) {
    await renew();
    return api(path, { method, body, retryOn401: false });
  }

  let payload = null;
  try { payload = await res.json(); } catch { /* empty body */ }

  if (!res.ok) throw new ApiError(payload?.error || `request failed (${res.status})`, res.status);
  return payload;
}
