import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const load = (l) => JSON.parse(readFileSync(new URL(`../module/locales/${l}.json`, import.meta.url)));
const de = load('de');
const en = load('en');

test('every locale has the same keys', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort());
});

// Yuvomi baut aus den flachen Schluesseln einen Baum (nestFlatLocaleDict):
// ein Schluessel, der zugleich Praefix eines anderen ist, verschwindet dabei.
test('no key is also the prefix of another key', () => {
  const keys = Object.keys(de);
  const clashes = keys.filter((k) => keys.some((o) => o.startsWith(`${k}.`)));
  assert.deepEqual(clashes, []);
});

test('every key the page and settings use exists', () => {
  const src = ['index.js', 'settings.js', 'widget.js'].map((f) => readFileSync(new URL(`../module/${f}`, import.meta.url), 'utf8')).join('\n');
  const used = [...src.matchAll(/\btr\('([^'`$]+)'/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((k) => !(k in de));
  assert.deepEqual(missing, []);
});
