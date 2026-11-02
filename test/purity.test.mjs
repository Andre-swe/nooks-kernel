import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const files = readdirSync(new URL('../src/', import.meta.url)).filter((file) => file.endsWith('.mjs'));
const forbidden = /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(|\b(?:document|window|localStorage|sessionStorage)\s*[.\[]|\bprocess\.env\b|from\s*['\"]node:/;

test('kernel modules have no ambient I/O dependencies', () => {
  for (const file of files) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(source, forbidden, file);
  }
});
