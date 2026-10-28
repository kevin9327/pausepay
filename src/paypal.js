// PayPal REST client (sandbox by default). Orders v2 + Payments v2 only — no SDK needed.
// Flow used by PausePay:  create order (intent=AUTHORIZE) -> buyer approves -> authorize (funds on hold)
//                         -> capture authorization (release to payee)  OR  void authorization (money back to buyer)
import crypto from 'node:crypto';
import { config } from './config.js';

let cached = { token: null, exp: 0 };

async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 30_000) return cached.token;
  const basic = Buffer.from(`${config.paypal.clientId}:${config.paypal.secret}`).toString('base64');
  const res = await fetch(`${config.paypal.base}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`PayPal auth failed (${res.status}): ${data.error_description || data.error || 'unknown error'}`);
  cached = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return cached.token;
}

async function api(method, path, body) {
  const token = await accessToken();
  const res = await fetch(`${config.paypal.base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': crypto.randomUUID(),
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = (data.details || []).map((d) => d.description || d.issue).join('; ');
    const err = new Error(`PayPal ${method} ${path} -> ${res.status} ${data.name || ''} ${data.message || ''} ${detail}`.trim());
    err.status = res.status;
    err.paypal = data;
    throw err;
  }
  return data;
}

const money = (v) => Number(v).toFixed(2);
const link = (data, ...rels) => (data.links || []).find((l) => rels.includes(l.rel))?.href;

export const paypal = {
  name: 'PayPal sandbox',

  async createOrder({ intent, amount, currency, description, referenceId, returnUrl, cancelUrl }) {
    const data = await api('POST', '/v2/checkout/orders', {
      intent,
      purchase_units: [
        {
          reference_id: referenceId,
          custom_id: referenceId,
          description: (description || 'PausePay guarded payment').slice(0, 120),
          amount: { currency_code: currency, value: money(amount) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'PausePay',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    });
    return { id: data.id, status: data.status, approveUrl: link(data, 'payer-action', 'approve') };
  },

  // Buyer approved -> place the funds on hold.
  async authorizeOrder(orderId) {
    const data = await api('POST', `/v2/checkout/orders/${orderId}/authorize`, {});
    const a = data.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!a) throw new Error('PayPal returned no authorization');
    return { id: a.id, status: a.status, expiresAt: a.expiration_time, amount: a.amount };
  },

  // Buyer approved an immediate-capture order (low-risk payments).
  async captureOrder(orderId) {
    const data = await api('POST', `/v2/checkout/orders/${orderId}/capture`, {});
    const c = data.purchase_units?.[0]?.payments?.captures?.[0];
    if (!c) throw new Error('PayPal returned no capture');
    return { id: c.id, status: c.status, amount: c.amount };
  },

  async captureAuthorization(authId) {
    const c = await api('POST', `/v2/payments/authorizations/${authId}/capture`, { final_capture: true });
    return { id: c.id, status: c.status, amount: c.amount };
  },

  async voidAuthorization(authId) {
    await api('POST', `/v2/payments/authorizations/${authId}/void`, undefined);
    return { id: authId, status: 'VOIDED' };
  },

  async getOrder(orderId) {
    return api('GET', `/v2/checkout/orders/${orderId}`);
  },
};
