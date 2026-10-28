// Records the PausePay demo video: drives the real UI in headless Chrome (CDP screencast), narrates it with
// synthesized speech (edge-tts) and muxes everything with ffmpeg. Nothing on screen is mocked up: the UI,
// the MCP session and every status change come from a running PausePay.
//
//   node tools/demo/make-demo.mjs <outDir>
//   env: PAUSEPAY_URL (default http://localhost:8787)   TTS_PYTHON (python with edge-tts installed)
//        TTS_VOICE (default en-US-AndrewNeural)         TTS_RATE (default +4%)       DRY=1 (screenshots only, no video)
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '../cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.PAUSEPAY_URL || 'http://localhost:8787';
const OUT = path.resolve(process.argv[2] || 'demo-out');
const DRY = !!process.env.DRY;
const TTS_PY = process.env.TTS_PYTHON;
const VOICE = process.env.TTS_VOICE || 'en-US-AndrewNeural';
const RATE = process.env.TTS_RATE || '+4%';
const W = 1440, H = 810, SCALE = 4 / 3; // 1920x1080 frames
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now() / 1000;
const run = (cmd, args, opts = {}) => { const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts }); if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || '').slice(-600)}`); return r.stdout; };

fs.mkdirSync(path.join(OUT, 'audio'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'shots'), { recursive: true });
fs.rmSync(path.join(OUT, 'frames'), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'frames'), { recursive: true });

// ---- 1. real MCP session -> transcript card (before the app data is reset, so it leaves no trace in the UI)
const transcript = path.join(OUT, 'mcp-transcript.json');
run('node', [path.join(here, 'mcp-transcript.mjs'), transcript], { env: { ...process.env, PAUSEPAY_URL: BASE } });
const mcpHtml = path.join(OUT, 'mcp-live.html');
fs.writeFileSync(mcpHtml, fs.readFileSync(path.join(here, 'cards/mcp.html'), 'utf8').replace('/*TRANSCRIPT*/null', fs.readFileSync(transcript, 'utf8')));
await fetch(BASE + '/api/reset', { method: 'POST' });

// ---- 2. page helpers
const CURSOR_JS = `(() => {
  const init = () => {
    if (document.getElementById('__cur')) return;
    const c = document.createElement('div'); c.id = '__cur';
    c.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;z-index:2147483647;pointer-events:none;transition:transform .55s cubic-bezier(.25,.8,.3,1);transform:translate(-100px,-100px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))';
    c.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M3 2l7.5 19 2.6-7.6L21 10.8z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(c);
    let s = null; try { s = sessionStorage.getItem('__cur'); } catch (e) {}
    if (s) { const p = s.split(','); c.style.transition = 'none'; c.style.transform = 'translate(' + p[0] + 'px,' + p[1] + 'px)'; void c.offsetWidth; c.style.transition = ''; }
    window.__pp_mouse = (x, y) => { c.style.transform = 'translate(' + x + 'px,' + y + 'px)'; try { sessionStorage.setItem('__cur', x + ',' + y); } catch (e) {} };
    addEventListener('mousedown', (e) => { const r = document.createElement('div'); r.style.cssText = 'position:fixed;left:' + (e.clientX - 20) + 'px;top:' + (e.clientY - 20) + 'px;width:40px;height:40px;border-radius:50%;border:3px solid #0070e0;z-index:2147483646;pointer-events:none;opacity:.9;transition:transform .5s ease-out,opacity .5s ease-out'; document.documentElement.appendChild(r); requestAnimationFrame(() => { r.style.transform = 'scale(1.8)'; r.style.opacity = '0'; }); setTimeout(() => r.remove(), 600); }, true);
  };
  if (document.documentElement) init(); else document.addEventListener('DOMContentLoaded', init);
})();`;

const page = await launch({ width: W, height: H, scale: SCALE });
await page.send('Page.addScriptToEvaluateOnNewDocument', { source: CURSOR_JS });

async function ev(expr, tries = 6) {
  for (let i = 0; i < tries; i++) { try { return await page.eval(expr); } catch (e) { if (i === tries - 1) throw e; await sleep(300); } }
}
async function waitFor(expr, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await page.eval(expr)) return true; } catch {} await sleep(150); }
  throw new Error('timeout waiting for ' + expr);
}
const rectOf = (sel) => ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.top, bottom: r.bottom }; })()`);
async function scrollTo(y) { await ev(`window.scrollTo({ top: ${y}, behavior: 'smooth' })`); await sleep(900); }
async function reveal(sel) {
  await waitFor(`!!document.querySelector(${JSON.stringify(sel)})`);
  let r = await rectOf(sel);
  if (r.top < 90 || r.bottom > H - 90) { await ev(`window.scrollBy({ top: ${Math.round(r.y - H / 2)}, behavior: 'smooth' })`); await sleep(950); r = await rectOf(sel); }
  return r;
}
async function click(sel, { hold = 350 } = {}) {
  const r = await reveal(sel);
  await page.moveMouse(r.x, r.y); await sleep(700);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  await sleep(hold);
}
async function typeInto(sel, text) {
  await click(sel, { hold: 150 });
  for (const ch of text) { await page.send('Input.insertText', { text: ch }); await sleep(32); }
}
const card = (f) => pathToFileURL(f).href;
const paymentId = () => ev(`new URLSearchParams(location.search).get('payment')`);

// ---- 3. storyboard: narration + the action that happens while it is spoken
// the MCP narration follows what the real session returned (block vs hold), so it can never contradict the screen
const session = JSON.parse(fs.readFileSync(transcript, 'utf8'));
const wasBlocked = session.steps[1].result.some((r) => /BLOCKED/.test(r));
const hadHumanStep = session.steps.some((s) => s.human);
const mcpOutcome = wasBlocked
  ? "Verdict: block. The agent tries to create the payment anyway. Blocked. It tries to release it. Refused. Agents can't approve their own risky payments."
  : hadHumanStep
    ? "Verdict: hold. The agent can only create a held payment. Even after the buyer approves the hold, its attempt to release the money is refused. Agents can't approve their own risky payments."
    : "Verdict: hold. The agent can only create a held payment, and its attempt to release it is refused. Agents can't approve their own risky payments.";
const beats = [
  { id: 'intro', text: "Payment scams cost people billions every year. Soon, AI agents will spend our money too. Once a payment is sent, it's gone. PausePay adds a pause button.",
    act: async () => { await sleep(1200); } },
  { id: 'start', text: 'PausePay sits in front of PayPal. You, or your AI agent, paste the messages behind a payment, and a risk analyst reads them before any money moves.',
    act: async () => { await page.goto(BASE + '/'); await waitFor(`!!document.querySelector('#scenarios .chip')`); await page.moveMouse(380, 250); await sleep(900); await click('#scenarios .chip[data-i="0"]'); await sleep(1500); } },
  { id: 'pizza', text: 'An ordinary payment, like splitting a pizza, scores near zero and goes straight through as a normal PayPal capture.',
    act: async () => {
      await click('#go'); await waitFor(`!!document.querySelector('#right .verdict')`); await sleep(1800);
      await click('button[data-act="approve"]'); await waitFor(`location.pathname === '/mock/paypal/approve'`); await sleep(1300);
      await click('button'); await waitFor(`location.pathname === '/' && !!document.querySelector('#right .warning.ok')`); await sleep(1800);
    } },
  { id: 'ticket-in', text: 'Now, a ticket seller who insists on Friends and Family, and says the offer ends in two hours.',
    act: async () => { await scrollTo(0); await click('#scenarios .chip[data-i="1"]'); await sleep(1500); await click('#go'); await waitFor(`!!document.querySelector('#right .verdict.hold')`); await sleep(800); } },
  { id: 'ticket-signals', text: "The analyst flags the pressure and the unprotected payment method. PausePay doesn't block it. It asks PayPal to authorize only: the funds are reserved, but nothing is sent to the seller.",
    act: async () => { await scrollTo(250); await sleep(2600); await scrollTo(0); await sleep(1800); } },
  { id: 'ticket-hold', text: 'The buyer approves the hold, and a twenty-four hour cooling-off clock starts.',
    act: async () => {
      await click('button[data-act="approve"]'); await waitFor(`location.pathname === '/mock/paypal/approve'`); await sleep(900);
      await click('button'); await waitFor(`!!document.querySelector('#right .hold-box #glink')`); await sleep(1800);
    } },
  { id: 'guardian', text: 'Next, a link goes to a trusted contact. No account needed. She sees the amount, the reasons, and the conversation, and denies it.',
    act: async () => {
      const id = await paymentId(); beats.ctx = { id };
      const link = await ev(`document.querySelector('#glink').value`);
      await click('#glink', { hold: 600 });
      await page.goto(link); await waitFor(`!!document.querySelector('#no')`);
      await sleep(1000); await scrollTo(330); await sleep(1800);
      await typeInto('#note', 'Classic Friends & Family scam. Do not pay.');
      await sleep(500); await click('#no'); await waitFor(`!!document.querySelector('.warning.bad')`); await sleep(1500);
    } },
  { id: 'void', text: 'PausePay voids the authorization. The buyer keeps the money, and every step is in the audit trail.',
    act: async () => {
      await page.goto(`${BASE}/?payment=${beats.ctx.id}`); await waitFor(`!!document.querySelector('#right .warning.ok')`); await sleep(1700);
      await scrollTo(700); await sleep(1800);
    } },
  { id: 'blocked', text: 'Clear scams, like an apartment deposit in gift cards, are blocked before any PayPal order exists. Overriding needs a typed confirmation and a trusted contact.',
    act: async () => {
      await page.goto(BASE + '/'); await waitFor(`!!document.querySelector('#scenarios .chip')`);
      await click('#scenarios .chip[data-i="2"]'); await sleep(1300); await click('#go');
      await waitFor(`!!document.querySelector('#right .verdict.block')`); await sleep(2300); await scrollTo(170); await sleep(1500);
    } },
  { id: 'mcp-1', text: 'PausePay also speaks MCP, so AI agents can use it. This agent is told to buy the cheapest laptop and finds a three-day-old shop. It must check with PausePay first.',
    act: async () => { await page.goto(card(mcpHtml)); await sleep(600); await ev(`window.reveal(3)`); await sleep(1700); await ev(`window.reveal(window.stepEnds[0])`); await sleep(1800); } },
  { id: 'mcp-2', text: mcpOutcome,
    act: async () => { for (let i = 1; i < session.steps.length; i++) { await ev(`window.reveal(window.stepEnds[${i}])`); await sleep(i === session.steps.length - 1 ? 1500 : 2300); } } },
  { id: 'outro', text: 'Under the hood: PayPal Orders and Payments APIs, authorize then capture or void, a risk analyst on Gemini, Claude or OpenAI with a rule-based fallback, and an MCP server. Open source, MIT. PausePay: the pause button for agentic commerce.',
    act: async () => { await page.goto(card(path.join(here, 'cards/outro.html'))); await sleep(2500); } },
];

// ---- 4. narration audio
const audioDur = {};
for (const [i, b] of beats.entries()) {
  const base = path.join(OUT, 'audio', `b${String(i).padStart(2, '0')}`);
  b.mp3 = base + '.mp3';
  if (DRY) { audioDur[b.id] = Math.max(3, b.text.length / 15); continue; }
  if (!TTS_PY) throw new Error('set TTS_PYTHON to a python with edge-tts');
  const key = `${VOICE}|${RATE}|${b.text}`;
  const cached = fs.existsSync(b.mp3) && fs.existsSync(base + '.key') && fs.readFileSync(base + '.key', 'utf8') === key;
  if (!cached) {
    fs.writeFileSync(base + '.txt', b.text);
    for (let attempt = 1; ; attempt++) {
      try { run(TTS_PY, ['-m', 'edge_tts', '--voice', VOICE, `--rate=${RATE}`, '--file', base + '.txt', '--write-media', b.mp3]); break; }
      catch (e) { if (attempt >= 5) throw e; console.log(`tts retry ${attempt} for ${b.id}`); await sleep(2500 * attempt); }
    }
    fs.writeFileSync(base + '.key', key);
  }
  audioDur[b.id] = parseFloat(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', b.mp3]));
}
console.log('narration seconds:', Object.values(audioDur).reduce((a, b) => a + b, 0).toFixed(1));

// ---- 5. record
const frames = [];
let recording = false, T0 = null;
if (!DRY) {
  page.onEvent((d) => {
    if (d.method !== 'Page.screencastFrame') return;
    const t = now();
    page.send('Page.screencastFrameAck', { sessionId: d.params.sessionId }).catch(() => {});
    if (!recording) return;
    const file = path.join(OUT, 'frames', `f${String(frames.length).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(d.params.data, 'base64'));
    frames.push({ t, file });
  });
  await page.goto(card(path.join(here, 'cards/title.html')));
  recording = true;
  await page.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await waitFor(`true`); await sleep(500);
  T0 = now();
}

for (const [i, b] of beats.entries()) {
  b.start = now();
  try { await b.act(); } catch (e) { await page.shot(path.join(OUT, 'shots', `FAIL-${b.id}.png`)); throw new Error(`beat ${b.id}: ${e.message}`); }
  await page.shot(path.join(OUT, 'shots', `${String(i).padStart(2, '0')}-${b.id}.png`));
  const wait = audioDur[b.id] + 0.5 - (now() - b.start);
  if (wait > 0) await sleep(wait * 1000);
  b.end = now();
  console.log(`beat ${b.id}: ${(b.end - b.start).toFixed(1)}s (audio ${audioDur[b.id].toFixed(1)}s)`);
}
if (DRY) { await page.close(); console.log('dry run done; screenshots in', path.join(OUT, 'shots')); process.exit(0); }
await sleep(1200);
const END = now();
await page.send('Page.stopScreencast');
recording = false;
await page.close();

// ---- 6. encode
let start = frames.findLastIndex((f) => f.t <= T0); if (start < 0) start = 0;
const used = frames.slice(start); used[0] = { ...used[0], t: Math.max(used[0].t, T0) };
const list = used.map((f, i) => `file '${f.file.replace(/\\/g, '/')}'\nduration ${Math.max(0.001, ((used[i + 1]?.t ?? END) - f.t)).toFixed(4)}`).join('\n') + `\nfile '${used.at(-1).file.replace(/\\/g, '/')}'\n`;
fs.writeFileSync(path.join(OUT, 'frames.txt'), list);
const videoOnly = path.join(OUT, 'video.mp4');
run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', path.join(OUT, 'frames.txt'), '-vf', 'fps=30,scale=1920:1080:flags=lanczos,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-movflags', '+faststart', videoOnly]);

const inputs = beats.flatMap((b) => ['-i', b.mp3]);
const delays = beats.map((b, i) => { const ms = Math.round((b.start - T0) * 1000); return `[${i}:a]adelay=${ms}|${ms},apad[a${i}]`; });
const mix = `${delays.join(';')};${beats.map((_, i) => `[a${i}]`).join('')}amix=inputs=${beats.length}:normalize=0:duration=longest,loudnorm=I=-16:TP=-1.5:LRA=11[out]`;
const audioOut = path.join(OUT, 'narration.m4a');
run('ffmpeg', ['-y', ...inputs, '-filter_complex', mix, '-map', '[out]', '-t', (END - T0).toFixed(2), '-c:a', 'aac', '-b:a', '192k', audioOut]);
const final = path.join(OUT, 'PausePay-demo.mp4');
run('ffmpeg', ['-y', '-i', videoOnly, '-i', audioOut, '-c:v', 'copy', '-c:a', 'copy', '-t', (END - T0).toFixed(2), '-movflags', '+faststart', final]);

// ---- 7. captions (upload to YouTube as a subtitle track)
const ts = (s) => { const ms = Math.round(s * 1000); const p = (n, w = 2) => String(n).padStart(w, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
let n = 0, srt = '';
for (const b of beats) {
  const sentences = b.text.match(/[^.!?:]+[.!?:]?/g).map((s) => s.trim()).filter(Boolean);
  const total = sentences.reduce((a, s) => a + s.length, 0);
  let t = b.start - T0 + 0.1;
  for (const s of sentences) { const d = (audioDur[b.id] - 0.1) * (s.length / total); srt += `${++n}\n${ts(t)} --> ${ts(t + d)}\n${s}\n\n`; t += d; }
}
fs.writeFileSync(path.join(OUT, 'PausePay-demo.srt'), srt);
const dur = parseFloat(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', final]));
console.log(`done: ${final}  duration ${Math.floor(dur / 60)}:${String(Math.round(dur % 60)).padStart(2, '0')}  frames ${used.length}`);
