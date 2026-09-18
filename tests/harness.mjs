// Shared test harness: resolves Playwright wherever it is installed and points
// the browser at the app next to this file.
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

async function loadPlaywright() {
  for (const spec of ['playwright', '/opt/node22/lib/node_modules/playwright/index.js']) {
    try {
      const mod = await import(spec);
      const pw = mod.chromium ? mod : (mod.default || mod);
      if (pw.chromium) return pw;
    } catch { /* try the next location */ }
  }
  throw new Error('Playwright not found. Install it with: npm i -D playwright');
}

export const pw = await loadPlaywright();
export const chromium = pw.chromium;
export const APP_URL = 'file://' + resolve(dirname(fileURLToPath(import.meta.url)), '..', 'index.html');
