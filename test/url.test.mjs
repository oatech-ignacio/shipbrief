import test from 'node:test';
import assert from 'node:assert/strict';

// context.js imports @forge/api, which only resolves inside Forge, so the helper is re-declared via a tiny loader.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/context.js', import.meta.url), 'utf8');
const body = /export function safeUrl\(value\) \{([\s\S]*?)\n\}/.exec(src)[1];
const safeUrl = new Function('value', body);

test('safeUrl only lets https through', () => {
  assert.equal(safeUrl('https://a.atlassian.net/wiki/x'), 'https://a.atlassian.net/wiki/x');
  assert.equal(safeUrl('javascript:alert(1)'), undefined);
  assert.equal(safeUrl('data:text/html,x'), undefined);
  assert.equal(safeUrl('http://a.example/wiki/x'), undefined);
  assert.equal(safeUrl(undefined), undefined);
  assert.equal(safeUrl('/relative'), undefined);
});
