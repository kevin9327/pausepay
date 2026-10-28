// MCP server test: a JSON-RPC conversation over stdio against a real PausePay server (mock PayPal).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

process.env.PORT = '8798';
process.env.PAYPAL_CLIENT_ID = '';
process.env.PAYPAL_CLIENT_SECRET = '';
process.env.AI_PROVIDER = 'heuristic';
process.env.GEMINI_API_KEY = process.env.ANTHROPIC_API_KEY = process.env.OPENAI_API_KEY = '';
process.env.BASE_URL = 'http://localhost:8798';

const { server } = await import('../src/server.js');
const { store } = await import('../src/store.js');
store.reset();
await new Promise((r) => server.listen(8798, r));

const child = spawn('node', ['mcp/server.js'], { env: { ...process.env, PAUSEPAY_URL: 'http://localhost:8798' }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiting = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    waiting.get(m.id)?.(m); waiting.delete(m.id);
  }
});
let n = 0;
const rpc = (method, params) => new Promise((r) => { const id = ++n; waiting.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = async (name, args) => JSON.parse((await rpc('tools/call', { name, arguments: args })).result.content[0].text);

let ok = 0;
const test = async (name, fn) => { try { await fn(); ok++; console.log(`  ok   ${name}`); } catch (e) { console.error(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; } };

await test('initialize + tools/list', async () => {
  const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'pausepay');
  const list = await rpc('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['pausepay_check_payment', 'pausepay_create_payment', 'pausepay_payment_status', 'pausepay_submit_payee_answers', 'pausepay_release_payment', 'pausepay_void_payment']);
});

await test('an agent checking a scam purchase gets a block verdict and cannot release it', async () => {
  const check = await tool('pausepay_check_payment', { payee_name: 'BestDeals', amount: 1299, memo: 'laptop', context: 'URGENT, 70% below market, pay by wire transfer or crypto within 30 minutes, do not tell anyone, keep this secret.' });
  assert.equal(check.verdict, 'block');
  const created = await tool('pausepay_create_payment', { payee_name: 'BestDeals', amount: 1299, memo: 'laptop', context: 'URGENT, 70% below market, pay by wire transfer or crypto within 30 minutes, do not tell anyone, keep this secret.' });
  assert.equal(created.status, 'BLOCKED');
  const rel = await rpc('tools/call', { name: 'pausepay_release_payment', arguments: { payment_id: created.payment_id } });
  assert.equal(rel.result.isError, true);
});

await test('an agent paying a friend gets an approval link and a plain capture flow', async () => {
  const p = await tool('pausepay_create_payment', { payee_name: 'Mina', amount: 12, memo: 'coffee', context: 'Thanks for the coffee yesterday, receipt #77' });
  assert.equal(p.status, 'AWAITING_APPROVAL');
  assert.equal(p.paypal_intent, 'CAPTURE');
  assert.ok(p.approve_url.includes('/mock/paypal/approve'));
});

child.kill();
server.close();
store.reset();
console.log(`\n${ok} MCP test(s) passed${process.exitCode ? ' — with failures' : ''}`);
