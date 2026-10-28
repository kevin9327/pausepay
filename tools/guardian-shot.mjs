// Creates a held payment on the running app and screenshots the trusted-contact page. Usage: node tools/guardian-shot.mjs [outDir]
import fs from 'node:fs';
import { launch } from './cdp.mjs';
const out = process.argv[2] || 'shots';
fs.mkdirSync(out, { recursive: true });
const base = 'http://localhost:8787';
const p = await (await fetch(base + '/api/payments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
  payeeName: 'TicketDeals77', amount: 240, currency: 'USD', memo: '2 concert tickets', guardianName: 'Aunt Rosa',
  context: 'Seller: Only 2 left! Offer ends in 30 minutes. I can only take payment as a gift / friends & family so PayPal fees are lower. Please hurry.' }) })).json();
console.log(p.status, p.assessment.score, p.guardianLink);
const page = await launch({ width: 1000, height: 1300 });
await page.goto(p.guardianLink);
await page.sleep(600);
await page.shot(`${out}/04-guardian.png`);
await page.close();
