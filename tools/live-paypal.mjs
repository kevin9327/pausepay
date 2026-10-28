// Live check against the real PayPal sandbox (needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET in .env).
// Usage: node tools/live-paypal.mjs            -> OAuth + create an AUTHORIZE order, prints the buyer approval link
//        node tools/live-paypal.mjs <orderId>  -> after the buyer approved it: authorize, then capture (or void with VOID=1)
// Never prints credentials.
import { paypal } from '../src/paypal.js';
import { config } from '../src/config.js';

if (config.paypal.mock) { console.error('No PayPal credentials in .env — mock mode.'); process.exit(2); }
const orderId = process.argv[2];

if (!orderId) {
  const o = await paypal.createOrder({ intent: 'AUTHORIZE', amount: '12.50', currency: 'USD', description: 'PausePay live sandbox check', referenceId: 'live-check-1', returnUrl: `${config.baseUrl}/api/return`, cancelUrl: `${config.baseUrl}/api/cancel` });
  console.log(JSON.stringify(o, null, 1));
} else {
  const a = await paypal.authorizeOrder(orderId);
  console.log('authorize ->', JSON.stringify(a));
  const authId = a.id;
  if (process.env.VOID) console.log('void ->', JSON.stringify(await paypal.voidAuthorization(authId)));
  else console.log('capture ->', JSON.stringify(await paypal.captureAuthorization(authId)));
}
