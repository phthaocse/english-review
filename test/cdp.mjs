// Minimal CDP driver: no packages, just node's global WebSocket + fetch.
import { spawn } from 'node:child_process';
import os from 'node:os';

import fs from 'node:fs';

/** Chrome for Testing from the Playwright cache, or a system Chrome. */
function findChrome() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const cache = `${os.homedir()}/Library/Caches/ms-playwright`;
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache).filter((d) => d.startsWith('chromium_headless_shell'))) {
      const bin = `${cache}/${dir}/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
      if (fs.existsSync(bin)) return bin;
    }
  }
  for (const bin of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ]) if (fs.existsSync(bin)) return bin;
  throw new Error('No Chrome found. Set CHROME_BIN to a Chrome/Chromium binary.');
}

const BIN = findChrome();

export async function launch() {
  // Port 0 lets the OS pick a free one, and Chrome writes it to
  // DevToolsActivePort in the profile. A fixed port would silently attach to a
  // browser left over from an earlier run and inherit its localStorage, which
  // makes tests pass or fail depending on what ran before them.
  const profile = `${os.tmpdir()}/cdp-profile-${process.pid}-${Date.now()}`;
  const proc = spawn(BIN, [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  const portFile = `${profile}/DevToolsActivePort`;
  let port = null;
  for (let i = 0; i < 100 && !port; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (fs.existsSync(portFile)) {
      const line = fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
      if (line) port = Number(line);
    }
  }
  if (!port) { proc.kill(); throw new Error('chrome did not report a debugging port'); }

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) { proc.kill(); throw new Error('chrome did not open a page'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  const consoleErrors = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Runtime.exceptionThrown') {
      consoleErrors.push(msg.params.exceptionDetails.exception?.description || 'exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  /** Run a script in every page before its own scripts execute. */
  async function addInitScript(source) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source });
  }

  async function goto(url) {
    await send('Page.navigate', { url });
    await new Promise((r) => setTimeout(r, 1500));
  }

  async function evaluate(expression) {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
    }
    return r.result.value;
  }

  /**
   * `fullPage` captures beyond the viewport, which on a long list produces a
   * 45,000px image nobody can read. Default to what a phone actually shows.
   */
  /** Resize the viewport and give the page a moment to reflow against it. */
  async function setViewport(width, height, { mobile = false, deviceScaleFactor = 2 } = {}) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
    // Setting metrics does not synchronously relayout; capturing immediately
    // photographs the previous layout at the new size.
    await new Promise((r) => setTimeout(r, 350));
  }

  async function screenshot(path, width = 900, height = 1100, { fullPage = false, mobile = false } = {}) {
    await setViewport(width, height, { mobile });
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    (await import('node:fs')).writeFileSync(path, Buffer.from(data, 'base64'));
  }

  return { goto, evaluate, screenshot, setViewport, addInitScript, consoleErrors,
           close: () => { ws.close(); proc.kill('SIGKILL'); } };
}
