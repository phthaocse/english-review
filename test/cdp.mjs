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
const PORT = 9333;

export async function launch() {
  const proc = spawn(BIN, [
    '--headless', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${os.tmpdir()}/cdp-profile-${Date.now()}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) { proc.kill(); throw new Error('chrome did not start'); }

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

  async function screenshot(path, width = 900, height = 1100) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 2, mobile: false });
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    (await import('node:fs')).writeFileSync(path, Buffer.from(data, 'base64'));
  }

  return { goto, evaluate, screenshot, consoleErrors, close: () => { ws.close(); proc.kill(); } };
}
