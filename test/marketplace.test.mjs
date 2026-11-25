import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformManifest, VARIANT_JS } from '../scripts/build-marketplace.mjs';
import { buildBrief } from '../src/brief.js';

const manifest = readFileSync(new URL('../manifest.yml', import.meta.url), 'utf8');
const ID = '00000000-0000-4000-8000-000000000000';

test('marketplace manifest is Jira-only and keeps every module', () => {
  const out = transformManifest(manifest, ID);
  assert.ok(!out.includes('search:confluence'));
  assert.ok(!/confluence/i.test(out.slice(out.indexOf('permissions:'))));
  assert.ok(out.includes(`id: ari:cloud:ecosystem::app/${ID}`));
  assert.ok(!out.includes('licensing'));
  for (const m of ['jira:issuePanel', 'rovo:agent', 'rovo:mcp', 'read:jira-work', 'write:jira-work', 'read:graph:issue:jira']) {
    assert.ok(out.includes(m), m);
  }
  // only the intended lines differ
  assert.equal(out.split('\n').length, manifest.split('\n').length - 1);
});

test('main variant searches Confluence, marketplace variant does not', () => {
  assert.match(readFileSync(new URL('../src/variant.js', import.meta.url), 'utf8'), /CONFLUENCE_SEARCH = true/);
  assert.match(VARIANT_JS, /CONFLUENCE_SEARCH = false/);
});

test('linked-only docs: wording says "linked", unavailable stays unknown', () => {
  const base = { issue: { key: 'A-1', summary: 's', status: { name: 'To Do', category: 'new' }, comments: [], links: [], subtasks: [] } };
  const docsCheck = (docs) => buildBrief({ ...base, docs }, new Date('2026-11-25T00:00:00Z')).checks.find((c) => c.id === 'docs');
  const none = docsCheck({ items: [], linkedOnly: true });
  assert.equal(none.status, 'warn');
  assert.match(none.detail ?? none.evidence ?? JSON.stringify(none), /No Confluence page is linked on this work item/);
  const one = docsCheck({ items: [{ title: 'Spec', url: 'https://x.atlassian.net/wiki/1' }], linkedOnly: true });
  assert.equal(one.status, 'pass');
  assert.match(JSON.stringify(one), /1 linked Confluence page/);
  assert.equal(docsCheck({ items: [], unavailable: 'Linked pages could not be checked.' }).status, 'unknown');
});
