import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../', import.meta.url).pathname.replace(/^\/(.:\/)/, '$1');
const blocked = new Set(['.git', 'node_modules']);
const secret = /(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/;
const prohibited = /(^|[\\/])(api|server|vendor|ldraw|deliverables|\.claude|\.community|\.orders)([\\/]|$)/i;
const text = /\.(?:mjs|js|json|md|txt|ya?ml)$/i;
const bad = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (blocked.has(name)) continue;
    const path = join(dir, name), rel = relative(root, path);
    if (prohibited.test(rel)) bad.push(`${rel}: prohibited release path`);
    else if (statSync(path).isDirectory()) walk(path);
    else if (text.test(name) && secret.test(readFileSync(path, 'utf8'))) bad.push(`${rel}: secret-shaped value`);
  }
}
walk(root);
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log('Release audit passed: no prohibited paths or secret-shaped values found.');
