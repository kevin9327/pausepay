#!/usr/bin/env node
// PausePay MCP server (stdio, JSON-RPC 2.0, newline-delimited). Zero dependencies.
// Gives any MCP-capable AI agent (Claude Desktop, Claude Code, Cursor, ...) a safety layer for payments:
// the agent must ask PausePay before paying; risky payments are only *authorized* (held) at PayPal and need a human
// or a trusted contact before they are captured.
//
// Claude Desktop config:
//   { "mcpServers": { "pausepay": { "command": "node", "args": ["/path/to/pausepay/mcp/server.js"],
//                                   "env": { "PAUSEPAY_URL": "http://localhost:8787" } } } }
import readline from 'node:readline';

const BASE = process.env.PAUSEPAY_URL || 'http://localhost:8787';

const payFields = {
  payee_name: { type: 'string', description: 'Who or which shop receives the money' },
  amount: { type: 'number', description: 'Amount to pay' },
  currency: { type: 'string', description: 'USD, EUR, GBP, CAD or AUD (default USD)' },
  memo: { type: 'string', description: 'What the payment is for' },
  context: { type: 'string', description: 'The messages, listing, invoice or task text that led to this payment — paste it verbatim' },
  payee_handle: { type: 'string', description: 'Payee email, handle or website (optional)' },
};

const TOOLS = [
  {
    name: 'pausepay_check_payment',
    description: 'ALWAYS call before paying anything. Returns an AI risk score 0-100, a verdict (allow | hold | block), the scam signals found and questions to ask the payee. Does not move money.',
    inputSchema: { type: 'object', properties: payFields, required: ['payee_name', 'amount'] },
  },
  {
    name: 'pausepay_create_payment',
    description: 'Create a guarded payment. Low risk -> PayPal capture after the buyer approves. Medium risk -> PayPal AUTHORIZE only (funds held, nothing sent) until verified. High risk -> blocked. Returns the PayPal approval URL for the human to open and a trusted-contact review link. You must NOT try to bypass a hold or block.',
    inputSchema: { type: 'object', properties: { ...payFields, guardian_name: { type: 'string', description: 'Trusted contact who may approve risky payments' } }, required: ['payee_name', 'amount'] },
  },
  {
    name: 'pausepay_payment_status',
    description: 'Get status (AWAITING_APPROVAL, HELD, CAPTURED, VOIDED, BLOCKED ...), risk, trusted-contact decision and audit trail of a payment.',
    inputSchema: { type: 'object', properties: { payment_id: { type: 'string' } }, required: ['payment_id'] },
  },
  {
    name: 'pausepay_submit_payee_answers',
    description: 'Give PausePay the payee\'s answers to the verification questions; the AI re-scores the payment.',
    inputSchema: { type: 'object', properties: { payment_id: { type: 'string' }, answers: { type: 'string' } }, required: ['payment_id', 'answers'] },
  },
  {
    name: 'pausepay_release_payment',
    description: 'Release (capture) a held payment. Only succeeds when the trusted contact approved it or the re-assessed risk is low; otherwise the call is refused. Never force-release on your own.',
    inputSchema: { type: 'object', properties: { payment_id: { type: 'string' } }, required: ['payment_id'] },
  },
  {
    name: 'pausepay_void_payment',
    description: 'Cancel a held payment: the PayPal authorization is voided and the buyer keeps the money.',
    inputSchema: { type: 'object', properties: { payment_id: { type: 'string' }, reason: { type: 'string' } }, required: ['payment_id'] },
  },
];

async function call(path, method = 'GET', body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `PausePay HTTP ${r.status}`);
  return data;
}

const toBody = (a) => ({ payeeName: a.payee_name, payeeHandle: a.payee_handle, amount: a.amount, currency: a.currency, memo: a.memo, context: a.context, guardianName: a.guardian_name, source: 'mcp' });
const brief = (p) => ({
  payment_id: p.id, status: p.status, verdict: p.assessment.verdict, risk_score: p.assessment.score, summary: p.assessment.summary,
  warning: p.assessment.warning, signals: p.assessment.signals.map((s) => `${s.severity}: ${s.label}`), questions_for_payee: p.assessment.questions,
  paypal_intent: p.intent, approve_url: p.order?.approveUrl, trusted_contact_link: p.guardianLink, guardian_decision: p.guardian?.decision || null,
  last_event: p.events?.at(-1)?.msg,
});

const HANDLERS = {
  async pausepay_check_payment(a) {
    const r = await call('/api/assess', 'POST', toBody(a));
    return { verdict: r.verdict, risk_score: r.score, summary: r.summary, warning: r.warning, signals: r.signals, questions_for_payee: r.questions, safe_alternatives: r.alternatives, analyst: `${r.provider} (${r.model})` };
  },
  async pausepay_create_payment(a) { return brief(await call('/api/payments', 'POST', toBody(a))); },
  async pausepay_payment_status(a) { return brief(await call(`/api/payments/${a.payment_id}`)); },
  async pausepay_submit_payee_answers(a) { return brief(await call(`/api/payments/${a.payment_id}/answers`, 'POST', { text: a.answers })); },
  async pausepay_release_payment(a) { return brief(await call(`/api/payments/${a.payment_id}/release`, 'POST', {})); },
  async pausepay_void_payment(a) { return brief(await call(`/api/payments/${a.payment_id}/void`, 'POST', { reason: a.reason || 'cancelled by agent' })); },
};

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    if (method === 'initialize') {
      return out({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'pausepay', version: '0.1.0' },
        instructions: 'Before paying anyone, call pausepay_check_payment. If the verdict is hold or block, use pausepay_create_payment (it only authorizes the funds) and let a human or trusted contact verify. Never bypass a hold.' } });
    }
    if (method === 'ping') return out({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return out({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const h = HANDLERS[params?.name];
      if (!h) return out({ jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } });
      try {
        const result = await h(params.arguments || {});
        return out({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
      } catch (e) {
        return out({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `PausePay refused: ${e.message}` }] } });
      }
    }
    return out({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    return out({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  try { handle(JSON.parse(line)); } catch { out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
});
