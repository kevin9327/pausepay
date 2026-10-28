// PausePay server — dependency-free Node.js (>=20).
// State machine:  ASSESSED -> AWAITING_APPROVAL -> HELD -> CAPTURED | VOIDED     (BLOCKED / CANCELLED / FAILED on the side)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { store } from './store.js';
import { assess, verdictFor } from './ai.js';
import { paypal } from './paypal.js';
import { mock, mockApprovalPage } from './mockpaypal.js';

const pp = config.paypal.mock ? mock : paypal;
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// ---------- helpers ----------
const send = (res, code, body, type = 'application/json; charset=utf-8', headers = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const redirect = (res, url) => { res.writeHead(302, { Location: url }); res.end(); };

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

const id = (p) => `${p}_${crypto.randomBytes(5).toString('hex')}`;
const now = () => new Date().toISOString();
const event = (p, type, msg) => { (p.events ||= []).push({ at: now(), type, msg }); };
const fail = (code, message) => Object.assign(new Error(message), { code });

function view(p) {
  const guardianLink = p.guardian?.token ? `${config.baseUrl}/guardian/${p.guardian.token}` : null;
  return { ...p, guardianLink, guardian: p.guardian && { ...p.guardian, token: undefined } };
}

// ---------- core operations ----------
export async function createPayment(body) {
  const amount = Number(body.amount);
  const currency = String(body.currency || 'USD').toUpperCase();
  if (!(amount > 0) || amount > 10000) throw fail(400, 'amount must be between 0.01 and 10000');
  if (!CURRENCIES.includes(currency)) throw fail(400, `currency must be one of ${CURRENCIES.join(', ')}`);
  if (!String(body.payeeName || '').trim()) throw fail(400, 'payeeName is required');

  const p = {
    id: id('pay'),
    createdAt: now(),
    status: 'ASSESSED',
    payee: { name: String(body.payeeName).trim().slice(0, 80), handle: String(body.payeeHandle || '').slice(0, 120) },
    amount,
    currency,
    memo: String(body.memo || '').slice(0, 200),
    context: String(body.context || '').slice(0, 6000),
    source: body.source || 'web',
    guardian: { name: String(body.guardianName || '').slice(0, 60), token: crypto.randomBytes(12).toString('hex'), decision: null },
    answers: [],
    history: [],
    events: [],
  };
  const a = await assess({ context: p.context, memo: p.memo, payeeName: p.payee.name, payeeHandle: p.payee.handle, amount, currency });
  p.assessment = a;
  p.history.push({ at: a.at, score: a.score, provider: a.provider });
  event(p, 'assessed', `Risk ${a.score}/100 -> ${a.verdict.toUpperCase()} (${a.provider})`);

  if (a.verdict === 'block') {
    p.status = 'BLOCKED';
    p.requireGuardian = true;
    event(p, 'blocked', 'High-risk payment blocked. Override requires a trusted contact.');
    return store.save(p);
  }
  await openOrder(p, a.verdict === 'allow' ? 'CAPTURE' : 'AUTHORIZE');
  return store.save(p);
}

async function openOrder(p, intent) {
  p.intent = intent;
  const order = await pp.createOrder({
    intent,
    amount: p.amount,
    currency: p.currency,
    description: p.memo || `Payment to ${p.payee.name}`,
    referenceId: p.id,
    returnUrl: `${config.baseUrl}/return?payment=${p.id}`,
    cancelUrl: `${config.baseUrl}/cancel?payment=${p.id}`,
  });
  p.order = { id: order.id, approveUrl: order.approveUrl };
  p.status = 'AWAITING_APPROVAL';
  event(p, 'order', `PayPal order ${order.id} created with intent ${intent}. ${intent === 'AUTHORIZE' ? 'Funds will be held, not sent.' : 'Low risk: immediate capture after approval.'}`);
}

export async function override(paymentId, confirm) {
  const p = mustGet(paymentId);
  if (p.status !== 'BLOCKED') throw fail(409, 'only blocked payments can be overridden');
  if (String(confirm || '').trim().toUpperCase() !== 'I UNDERSTAND') throw fail(400, 'type "I UNDERSTAND" to override');
  event(p, 'override', 'Buyer overrode the block. Payment will be authorized (held) and needs trusted-contact approval.');
  await openOrder(p, 'AUTHORIZE');
  return store.save(p);
}

function mustGet(paymentId) {
  const p = store.get(paymentId);
  if (!p) throw fail(404, 'payment not found');
  return p;
}

async function onBuyerApproved(p) {
  if (p.status !== 'AWAITING_APPROVAL') return p;
  try {
    if (p.intent === 'CAPTURE') {
      const c = await pp.captureOrder(p.order.id);
      p.capture = { id: c.id, at: now() };
      p.status = 'CAPTURED';
      event(p, 'captured', `Payment captured (${c.id}).`);
    } else {
      const a = await pp.authorizeOrder(p.order.id);
      p.authorization = { id: a.id, expiresAt: a.expiresAt };
      p.hold = { until: new Date(Date.now() + config.policy.holdHours * 3600e3).toISOString() };
      p.status = 'HELD';
      event(p, 'held', `Funds placed on hold (authorization ${a.id}). Nothing has reached ${p.payee.name}. Cooling-off until ${p.hold.until}.`);
    }
  } catch (e) {
    p.status = 'FAILED';
    event(p, 'error', e.message);
  }
  return store.save(p);
}

async function doRelease(p, reason) {
  if (p.status !== 'HELD') throw fail(409, `payment is ${p.status}, not HELD`);
  const c = await pp.captureAuthorization(p.authorization.id);
  p.capture = { id: c.id, at: now() };
  p.status = 'CAPTURED';
  event(p, 'captured', `Released to ${p.payee.name}: ${reason} (${c.id}).`);
  return store.save(p);
}

async function doVoid(p, reason) {
  if (p.status !== 'HELD') throw fail(409, `payment is ${p.status}, not HELD`);
  await pp.voidAuthorization(p.authorization.id);
  p.status = 'VOIDED';
  event(p, 'voided', `Hold cancelled, buyer keeps the money: ${reason}.`);
  return store.save(p);
}

export async function release(paymentId, { force, confirm } = {}) {
  const p = mustGet(paymentId);
  if (p.status !== 'HELD') throw fail(409, `payment is ${p.status}, not HELD`);
  if (p.guardian?.decision === 'deny') throw fail(409, 'the trusted contact denied this payment');
  const approved = p.guardian?.decision === 'approve';
  const saferNow = p.assessment.score < config.policy.holdThreshold;
  if (p.requireGuardian && !approved) throw fail(403, 'this payment needs trusted-contact approval');
  if (approved) return doRelease(p, 'approved by trusted contact');
  if (saferNow) return doRelease(p, `re-assessment after payee answers is low risk (${p.assessment.score}/100)`);
  if (force && String(confirm || '').toUpperCase() === 'RELEASE') return doRelease(p, 'released by buyer despite open warnings');
  throw fail(403, 'not yet verified: wait for trusted contact approval, get convincing payee answers, or force-release with confirm="RELEASE"');
}

export async function voidPayment(paymentId, reason = 'cancelled by buyer') {
  return doVoid(mustGet(paymentId), reason);
}

export async function addAnswers(paymentId, text) {
  const p = mustGet(paymentId);
  if (!['HELD', 'AWAITING_APPROVAL', 'BLOCKED'].includes(p.status)) throw fail(409, `payment is ${p.status}`);
  const t = String(text || '').trim().slice(0, 3000);
  if (!t) throw fail(400, 'answers text is required');
  p.answers.push({ at: now(), text: t });
  const a = await assess({
    context: p.context, memo: p.memo, payeeName: p.payee.name, payeeHandle: p.payee.handle, amount: p.amount, currency: p.currency,
    answers: p.answers.map((x) => x.text).join('\n---\n'),
  });
  const before = p.assessment.score;
  p.assessment = a;
  p.history.push({ at: a.at, score: a.score, provider: a.provider, afterAnswers: true });
  event(p, 'reassessed', `Payee answered. Risk ${before} -> ${a.score}/100 (${a.verdict.toUpperCase()}).`);
  return store.save(p);
}

export async function guardianDecision(token, decision, note) {
  const p = store.byToken(token);
  if (!p) throw fail(404, 'unknown link');
  if (p.guardian.decision) throw fail(409, 'a decision was already recorded');
  if (!['approve', 'deny'].includes(decision)) throw fail(400, 'decision must be approve or deny');
  p.guardian.decision = decision;
  p.guardian.note = String(note || '').slice(0, 400);
  p.guardian.decidedAt = now();
  event(p, 'guardian', `${p.guardian.name || 'Trusted contact'} ${decision === 'approve' ? 'approved' : 'denied'} the payment${p.guardian.note ? `: "${p.guardian.note}"` : ''}.`);
  store.save(p);
  if (p.status === 'HELD') {
    if (decision === 'deny') return doVoid(p, 'trusted contact denied');
    return doRelease(p, 'approved by trusted contact');
  }
  return p;
}

// Cooling-off sweep: held payments that were never verified are voided (the safe default).
export async function sweep() {
  for (const p of store.all()) {
    if (p.status === 'HELD' && p.hold && Date.now() > Date.parse(p.hold.until) && p.guardian?.decision !== 'approve') {
      try { await doVoid(p, 'cooling-off window ended without verification (safe default)'); } catch (e) { event(p, 'error', e.message); store.save(p); }
    }
  }
}

// ---------- HTTP ----------
function serveStatic(res, file) {
  const full = path.join(publicDir, file);
  if (!full.startsWith(publicDir) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) return send(res, 404, { error: 'not found' });
  send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, config.baseUrl);
  const p = url.pathname;
  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && p.startsWith('/guardian/')) return serveStatic(res, 'guardian.html');
    if (req.method === 'GET' && /^\/[\w.-]+\.(js|css|svg|png|json)$/.test(p)) return serveStatic(res, p.slice(1));

    if (req.method === 'GET' && p === '/api/config') {
      return send(res, 200, {
        paypal: pp.name, mock: config.paypal.mock, ai: config.ai.provider === 'heuristic' ? 'heuristic (no AI key configured)' : `${config.ai.provider} / ${config.ai[config.ai.provider].model}`,
        policy: config.policy, baseUrl: config.baseUrl,
      });
    }
    if (req.method === 'POST' && p === '/api/assess') {
      const b = await readBody(req);
      return send(res, 200, await assess({ context: b.context, memo: b.memo, payeeName: b.payeeName, payeeHandle: b.payeeHandle, amount: Number(b.amount), currency: b.currency }));
    }
    if (req.method === 'GET' && p === '/api/payments') return send(res, 200, store.all().map(view));
    if (req.method === 'POST' && p === '/api/payments') return send(res, 201, view(await createPayment(await readBody(req))));
    if (req.method === 'POST' && p === '/api/reset') { store.reset(); return send(res, 200, { ok: true }); }

    let m = p.match(/^\/api\/payments\/([\w]+)(?:\/(\w+))?$/);
    if (m) {
      const [, pid, action] = m;
      if (req.method === 'GET' && !action) return send(res, 200, view(mustGet(pid)));
      if (req.method === 'POST') {
        const b = await readBody(req);
        if (action === 'release') return send(res, 200, view(await release(pid, b)));
        if (action === 'void') return send(res, 200, view(await voidPayment(pid, b.reason)));
        if (action === 'answers') return send(res, 200, view(await addAnswers(pid, b.text)));
        if (action === 'override') return send(res, 200, view(await override(pid, b.confirm)));
      }
    }
    m = p.match(/^\/api\/guardian\/(\w+)(?:\/(decision))?$/);
    if (m) {
      const pay = store.byToken(m[1]);
      if (!pay) return send(res, 404, { error: 'unknown link' });
      if (req.method === 'GET') {
        return send(res, 200, {
          id: pay.id, status: pay.status, payee: pay.payee, amount: pay.amount, currency: pay.currency, memo: pay.memo,
          context: pay.context, assessment: pay.assessment, answers: pay.answers, guardian: { name: pay.guardian.name, decision: pay.guardian.decision, note: pay.guardian.note },
          events: pay.events, mock: config.paypal.mock,
        });
      }
      if (req.method === 'POST' && m[2] === 'decision') {
        const b = await readBody(req);
        const r = await guardianDecision(m[1], b.decision, b.note);
        return send(res, 200, { status: r.status });
      }
    }

    // PayPal redirect targets
    if (req.method === 'GET' && p === '/return') {
      const pay = store.get(url.searchParams.get('payment'));
      if (pay) await onBuyerApproved(pay);
      return redirect(res, `/?payment=${url.searchParams.get('payment') || ''}`);
    }
    if (req.method === 'GET' && p === '/cancel') {
      const pay = store.get(url.searchParams.get('payment'));
      if (pay && pay.status === 'AWAITING_APPROVAL') { pay.status = 'CANCELLED'; event(pay, 'cancelled', 'Buyer cancelled at PayPal.'); store.save(pay); }
      return redirect(res, `/?payment=${url.searchParams.get('payment') || ''}`);
    }
    // Mock approval page (only when running without PayPal credentials)
    if (config.paypal.mock && p === '/mock/paypal/approve') {
      if (req.method === 'GET') {
        const html = mockApprovalPage(url.searchParams.get('order'));
        return html ? send(res, 200, html, 'text/html; charset=utf-8') : send(res, 404, 'unknown order', 'text/plain');
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const o = mock.approve(b.order);
        return redirect(res, `${o.returnUrl}&token=${o.id}`);
      }
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    const code = e.code && Number.isInteger(e.code) ? e.code : 500;
    if (code === 500) console.error(e);
    return send(res, code, { error: e.message });
  }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(config.port, () => {
    console.log(`PausePay on ${config.baseUrl}`);
    console.log(`  PayPal : ${pp.name}`);
    console.log(`  AI     : ${config.ai.provider}`);
    console.log(`  Hold   : ${config.policy.holdHours}h cooling-off, hold>=${config.policy.holdThreshold}, block>=${config.policy.blockThreshold}`);
  });
  setInterval(() => sweep().catch(() => {}), 15_000);
}

export { verdictFor };
