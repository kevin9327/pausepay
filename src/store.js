import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const file = path.join(config.dataDir, 'payments.json');
let db = { payments: {} };

try {
  if (fs.existsSync(file)) db = JSON.parse(fs.readFileSync(file, 'utf8'));
} catch {
  db = { payments: {} };
}

function persist() {
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('persist failed:', e.message);
  }
}

export const store = {
  all: () => Object.values(db.payments).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  get: (id) => db.payments[id],
  byToken: (token) => Object.values(db.payments).find((p) => p.guardian?.token === token),
  save(p) {
    db.payments[p.id] = p;
    persist();
    return p;
  },
  reset() {
    db = { payments: {} };
    persist();
  },
};
