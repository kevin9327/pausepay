// Minimal Chrome DevTools Protocol client (no dependencies) used to take screenshots and record the demo.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch({ port = 9333, width = 1440, height = 900, scale = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-chrome-'));
  const proc = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--headless=new', '--hide-scrollbars', '--no-first-run',
    '--disable-gpu', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break; } catch {}
    await sleep(250);
  }
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const tab = tabs.find((t) => t.type === 'page');
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let n = 0;
  const waits = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waits.has(d.id)) { const { r, j } = waits.get(d.id); waits.delete(d.id); d.error ? j(new Error(d.error.message)) : r(d.result); }
    else if (d.method) listeners.forEach((f) => f(d));
  };
  const send = (method, params = {}) => new Promise((r, j) => { const id = ++n; waits.set(id, { r, j }); ws.send(JSON.stringify({ id, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });

  const page = {
    send, sleep, width, height,
    async goto(url) { await send('Page.navigate', { url }); await sleep(900); },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async rect(sel) { return page.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2, w:r.width, h:r.height}; })()`); },
    async click(sel) {
      const r = await page.rect(sel); if (!r) throw new Error('no element ' + sel);
      await page.moveMouse(r.x, r.y);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
      await sleep(250);
    },
    async moveMouse(x, y) { page.mouse = { x, y }; await page.eval(`window.__pp_mouse && window.__pp_mouse(${x},${y})`); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); },
    async type(sel, text, delay = 18) {
      await page.click(sel);
      await page.eval(`document.querySelector(${JSON.stringify(sel)}).select && document.querySelector(${JSON.stringify(sel)}).select()`);
      for (const ch of text) { await send('Input.insertText', { text: ch }); await sleep(delay); }
    },
    async shot(file, opts = {}) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...opts });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    onEvent(f) { listeners.push(f); },
    async close() { try { ws.close(); } catch {} proc.kill(); },
  };
  return page;
}
