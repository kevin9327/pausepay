// End-to-end tests against the real HTTP server, using the in-process mock of PayPal and the rule-based analyst.
// Run:  npm test      (no credentials or network needed)
import assert from 'node:assert/strict';

process.env.PORT = '8799';
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.AI_PROVIDER = 'heuristic';
process.env.GEMINI_API_KEY = process.env.ANTHROPIC_API_KEY = process.env.OPENAI_API_KEY = '';
process.env.HOLD_HOURS = '0.0004';
process.env.BASE_URL = 'http://localhost:8799';

const { server, sweep } = await import('../src/server.js');
const { store } = await import('../src/store.js');
store.reset();
await new Promise((r) => server.listen(8799, r));
const B = 'http://localhost:8799';

const post = async (url, body) => {
  const r = await fetch(B + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json() };
};
const get = async (url) => (await fetch(B + url)).json();

// Plays the buyer's click on PayPal's approval page (mock) and follows the return redirect.
async function buyerApproves(payment) {
  const u = new URL(payment.order.approveUrl);
  const r = await fetch(B + '/mock/paypal/approve', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `order=${u.searchParams.get('order')}` });
  assert.equal(r.status, 302);
  const back = new URL(r.headers.get('location'));
  assert.equal(back.pathname, '/return');
  await fetch(B + back.pathname + back.search, { redirect: 'manual' });
  return get(`/api/payments/${payment.id}`);
}

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

await test('ordinary payment is captured immediately after approval', async () => {
  const { body: p } = await post('/api/payments', { payeeName: 'Mina Park', amount: 18.5, currency: 'USD', memo: 'Pizza split', context: 'Hey, splitting the pizza from dinner, receipt #4421 attached, thanks!' });
  assert.equal(p.assessment.verdict, 'allow');
  assert.equal(p.intent, 'CAPTURE');
  const done = await buyerApproves(p);
  assert.equal(done.status, 'CAPTURED');
});

await test('suspicious payment is authorized (held), not captured, and a denied guardian voids it', async () => {
  const { body: p } = await post('/api/payments', { payeeName: 'Ticket Seller 77', amount: 240, currency: 'USD', memo: 'Concert tickets', context: 'Tickets are going fast, pay within 2 hours using Friends & Family or I sell them to someone else.' });
  assert.equal(p.assessment.verdict, 'hold');
  assert.equal(p.intent, 'AUTHORIZE');
  const held = await buyerApproves(p);
  assert.equal(held.status, 'HELD');
  assert.ok(held.authorization.id.startsWith('MOCKAUTH'));
  const token = held.guardianLink.split('/').pop();
  const r = await post(`/api/guardian/${token}/decision`, { decision: 'deny', note: 'Looks like a ticket scam' });
  assert.equal(r.body.status, 'VOIDED');
  const after = await get(`/api/payments/${p.id}`);
  assert.equal(after.status, 'VOIDED');
  assert.ok(after.events.some((e) => e.type === 'voided'));
});

await test('guardian approval releases a held payment', async () => {
  const { body: p } = await post('/api/payments', { payeeName: 'Dan', amount: 320, currency: 'USD', memo: 'Used bike', context: 'Pay me within 1 hour by friends and family and I will drop the bike off.' });
  const held = await buyerApproves(p);
  assert.equal(held.status, 'HELD');
  const r = await post(`/api/guardian/${held.guardianLink.split('/').pop()}/decision`, { decision: 'approve' });
  assert.equal(r.body.status, 'CAPTURED');
});

await test('blocked payment needs explicit override and trusted-contact approval', async () => {
  const { body: p } = await post('/api/payments', { payeeName: 'Landlord Jim', amount: 900, currency: 'USD', memo: 'Deposit', context: 'URGENT: send the deposit before you see the apartment, by gift cards. Do not tell anyone, keep this secret.' });
  assert.equal(p.status, 'BLOCKED');
  assert.equal(p.order, undefined);
  assert.equal((await post(`/api/payments/${p.id}/override`, { confirm: 'yes' })).status, 400);
  const o = await post(`/api/payments/${p.id}/override`, { confirm: 'I UNDERSTAND' });
  assert.equal(o.body.status, 'AWAITING_APPROVAL');
  const held = await buyerApproves(o.body);
  assert.equal(held.status, 'HELD');
  const rel = await post(`/api/payments/${p.id}/release`, { force: true, confirm: 'RELEASE' });
  assert.equal(rel.status, 403);
  const g = await post(`/api/guardian/${held.guardianLink.split('/').pop()}/decision`, { decision: 'approve' });
  assert.equal(g.body.status, 'CAPTURED');
});

await test('payee answers can lower the risk enough to release', async () => {
  const { body: p } = await post('/api/payments', { payeeName: 'Ana', amount: 150, currency: 'USD', memo: 'Sofa', context: 'Please pay today within 2 hours using friends and family, sofa is still available.' });
  const held = await buyerApproves(p);
  assert.equal(held.status, 'HELD');
  const before = held.assessment.score;
  const a = await post(`/api/payments/${p.id}/answers`, { text: 'I live in Austin, you can pick it up in person. Order #5521 receipt and tracking number are on my listing.' });
  assert.ok(a.body.assessment.score < before, `score should drop (${before} -> ${a.body.assessment.score})`);
});

await test('unverified held payments auto-void when the cooling-off window ends', async () => {
  const { body: p } = await post('/api/payments', { payeeName: 'Rick', amount: 99, currency: 'USD', memo: 'Phone', context: 'Pay me within 30 minutes by friends and family or I sell it.' });
  await buyerApproves(p);
  await new Promise((r) => setTimeout(r, 1700));
  await sweep();
  assert.equal((await get(`/api/payments/${p.id}`)).status, 'VOIDED');
});

await test('input validation', async () => {
  assert.equal((await post('/api/payments', { payeeName: 'x', amount: -5 })).status, 400);
  assert.equal((await post('/api/payments', { payeeName: '', amount: 5 })).status, 400);
  assert.equal((await post('/api/payments', { payeeName: 'x', amount: 5, currency: 'XXX' })).status, 400);
});

server.close();
store.reset();
console.log(`\n${passed} test(s) passed${process.exitCode ? ' — with failures' : ''}`);
