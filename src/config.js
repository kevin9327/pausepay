import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Tiny .env loader (no dependencies).
function loadEnv() {
  const p = path.join(root, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
    }
  }
}
loadEnv();

const env = (k, d = '') => (process.env[k] ?? d);
const num = (k, d) => (env(k) === '' ? d : Number(env(k)));

const port = num('PORT', 8787);
const geminiKey = env('GEMINI_API_KEY');
const anthropicKey = env('ANTHROPIC_API_KEY');
const openaiKey = env('OPENAI_API_KEY');
const wanted = env('AI_PROVIDER');
const provider = wanted || (geminiKey ? 'gemini' : anthropicKey ? 'anthropic' : openaiKey ? 'openai' : 'heuristic');

export const config = {
  root,
  port,
  baseUrl: env('BASE_URL', `http://localhost:${port}`),
  paypal: {
    clientId: env('PAYPAL_CLIENT_ID'),
    secret: env('PAYPAL_CLIENT_SECRET'),
    base: env('PAYPAL_BASE', 'https://api-m.sandbox.paypal.com'),
    mock: !(env('PAYPAL_CLIENT_ID') && env('PAYPAL_CLIENT_SECRET')),
  },
  ai: {
    provider,
    gemini: { key: geminiKey, model: env('GEMINI_MODEL', 'gemini-3.8-flash'), custom: !!env('GEMINI_MODEL') },
    anthropic: { key: anthropicKey, model: env('ANTHROPIC_MODEL', 'claude-sonnet-5-5') },
    openai: { key: openaiKey, model: env('OPENAI_MODEL', 'gpt-4o-mini') },
  },
  policy: {
    holdThreshold: num('HOLD_THRESHOLD', 35),
    blockThreshold: num('BLOCK_THRESHOLD', 75),
    holdHours: num('HOLD_HOURS', 24),
  },
  dataDir: path.join(root, 'data'),
};
