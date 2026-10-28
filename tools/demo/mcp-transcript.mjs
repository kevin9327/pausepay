// Runs a real agent-style session against PausePay's MCP server (stdio) and saves the responses.
// The demo video renders this transcript, so nothing on screen is invented.
// Usage: node tools/demo/mcp-transcript.mjs <out.json>   (PAUSEPAY_URL must point at a running PausePay)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = process.argv[2] || 'mcp-transcript.json';
const child = spawn('node', [path.join(root, 'mcp/server.js')], { env: { ...process.env, PAUSEPAY_URL: process.env.PAUSEPAY_URL || 'http://localhost:8787' }, stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiting = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); waiting.get(m.id)?.(m); waiting.delete(m.id); }
});
let n = 0;
const rpc = (method, params) => new Promise((r) => { const id = ++n; waiting.set(id, r); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });

const task = 'Buy the cheapest ThinkPad X1 you can find.';
const args = {
  payee_name: 'BestDeals Electronics', payee_handle: 'bestdeals-electr0nics.shop', amount: 1299, memo: 'ThinkPad X1 (agent purchase)',
  context: 'Cheapest offer found at bestdeals-electr0nics.shop (domain registered 3 days ago). Price is 70% below market. Checkout only accepts wire transfer or crypto and says the offer ends in 30 minutes. Seller note: "Do not tell anyone about this discount, pay today or the unit is gone."',
};

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'demo-agent', version: '1' } });
const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
const call = async (name, a) => { const r = (await rpc('tools/call', { name, arguments: a })).result; return { isError: !!r.isError, text: r.content[0].text }; };

const check = await call('pausepay_check_payment', args);
const created = await call('pausepay_create_payment', args);
const createdJson = JSON.parse(created.text);
// A held (not blocked) payment only becomes releasable-in-principle once the human buyer approves the hold at PayPal.
// That click is the buyer's, not the agent's; with the mock PayPal it is performed here so the refusal that follows is the real one.
let humanStep = null;
if (createdJson.status === 'AWAITING_APPROVAL' && /\/mock\/paypal\/approve/.test(createdJson.approve_url || '')) {
  const u = new URL(createdJson.approve_url);
  await fetch(`${u.origin}/mock/paypal/approve`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `order=${u.searchParams.get('order')}` });
  humanStep = 'the buyer approves the hold at PayPal (not the agent)';
}
const release = await call('pausepay_release_payment', { payment_id: createdJson.payment_id });
child.kill();

const c = JSON.parse(check.text);
fs.writeFileSync(out, JSON.stringify({
  task, tools,
  steps: [
    { call: 'pausepay_check_payment', args: { payee_name: args.payee_name, amount: args.amount, context: '…listing text…' },
      result: [`verdict: ${c.verdict}`, `risk_score: ${c.risk_score}`, ...c.signals.slice(0, 3).map((s) => `signal: ${s.label}`)] },
    { call: 'pausepay_create_payment', args: { payee_name: args.payee_name, amount: args.amount },
      result: [`status: ${createdJson.status}`, `verdict: ${createdJson.verdict}`, `paypal_intent: ${createdJson.paypal_intent ?? 'none — no PayPal order created'}`] },
    ...(humanStep ? [{ human: humanStep }] : []),
    { call: 'pausepay_release_payment', args: { payment_id: createdJson.payment_id },
      result: [release.text.replace(/^PausePay refused: /, 'PausePay refused: ').split('\n')[0]], isError: release.isError },
  ],
}, null, 2));
console.log('saved', out, '| release refused:', release.isError);
