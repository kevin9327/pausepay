// In-process stand-in for the PayPal sandbox so the app (and tests) run without credentials.
// It mimics the same lifecycle: CREATED -> APPROVED -> AUTHORIZED -> CAPTURED | VOIDED.
// Real PayPal sandbox credentials switch the app to src/paypal.js automatically.
import crypto from 'node:crypto';
import { config } from './config.js';

const orders = new Map();
const auths = new Map();
const rid = (p) => `${p}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;

export const mock = {
  name: 'MOCK (no PayPal credentials)',

  async createOrder({ intent, amount, currency, description, referenceId, returnUrl, cancelUrl }) {
    const id = rid('MOCKORDER');
    orders.set(id, { id, intent, amount, currency, description, referenceId, status: 'CREATED', returnUrl, cancelUrl });
    const approveUrl = `${config.baseUrl}/mock/paypal/approve?order=${id}`;
    return { id, status: 'CREATED', approveUrl };
  },

  approve(orderId) {
    const o = orders.get(orderId);
    if (!o) throw new Error('Unknown mock order');
    o.status = 'APPROVED';
    return o;
  },
  peek(orderId) {
    return orders.get(orderId);
  },

  async authorizeOrder(orderId) {
    const o = orders.get(orderId);
    if (!o || o.status !== 'APPROVED') throw new Error('Order not approved');
    const id = rid('MOCKAUTH');
    const a = { id, orderId, status: 'CREATED', amount: { currency_code: o.currency, value: Number(o.amount).toFixed(2) } };
    auths.set(id, a);
    o.status = 'COMPLETED';
    return { id, status: 'CREATED', expiresAt: new Date(Date.now() + 29 * 864e5).toISOString(), amount: a.amount };
  },

  async captureOrder(orderId) {
    const o = orders.get(orderId);
    if (!o || o.status !== 'APPROVED') throw new Error('Order not approved');
    o.status = 'COMPLETED';
    return { id: rid('MOCKCAP'), status: 'COMPLETED', amount: { currency_code: o.currency, value: Number(o.amount).toFixed(2) } };
  },

  async captureAuthorization(authId) {
    const a = auths.get(authId);
    if (!a || a.status !== 'CREATED') throw new Error(`Authorization ${authId} cannot be captured (${a?.status})`);
    a.status = 'CAPTURED';
    return { id: rid('MOCKCAP'), status: 'COMPLETED', amount: a.amount };
  },

  async voidAuthorization(authId) {
    const a = auths.get(authId);
    if (!a || a.status !== 'CREATED') throw new Error(`Authorization ${authId} cannot be voided (${a?.status})`);
    a.status = 'VOIDED';
    return { id: authId, status: 'VOIDED' };
  },

  async getOrder(orderId) {
    return orders.get(orderId);
  },
};

export const mockApprovalPage = (orderId) => {
  const o = orders.get(orderId);
  if (!o) return null;
  const amt = `${o.currency} ${Number(o.amount).toFixed(2)}`;
  return `<!doctype html><meta charset="utf-8"><title>Mock PayPal approval</title>
<body style="font-family:system-ui;max-width:460px;margin:60px auto;text-align:center">
<h2>Mock PayPal checkout</h2>
<p style="color:#666">This stands in for the PayPal sandbox approval page (no credentials configured).</p>
<p style="font-size:22px"><b>${amt}</b> to PausePay merchant</p>
<form method="post" action="/mock/paypal/approve"><input type="hidden" name="order" value="${orderId}">
<button style="padding:12px 22px;font-size:16px;background:#0070e0;color:#fff;border:0;border-radius:24px;cursor:pointer">Approve as sandbox buyer</button></form></body>`;
};
