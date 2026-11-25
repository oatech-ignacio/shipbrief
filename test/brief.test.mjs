import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, classifyComments, briefToText } from '../src/brief.js';

const NOW = Date.parse('2026-11-25T00:00:00Z');
const none = { items: [] };

const base = () => ({
  issue: {
    id: '10001',
    key: 'ABC-1',
    summary: 'Add retry to payment webhook',
    description:
      'Webhook deliveries fail on transient 5xx. Add exponential backoff.\nAcceptance criteria: retries 3 times, then dead-letters. Test plan: unit tests plus staging replay.',
    status: 'In Review',
    statusCategory: 'indeterminate',
    assignee: 'Dana',
    updated: '2026-11-24T10:00:00Z',
    fixVersions: []
  },
  parent: { key: 'ABC-0', summary: 'Reliable payments', status: 'In Progress', description: 'Cut failed payments by half.' },
  links: [],
  subtasks: [],
  comments: [],
  docs: { items: [{ title: 'Webhook retry design', url: 'https://x/wiki/1' }] },
  delivery: {
    pullRequests: { items: [{ title: 'retry', status: 'MERGED' }] },
    deployments: { items: [{ name: '#12', state: 'SUCCESSFUL', environment: 'staging', environmentType: 'STAGING', updatedAt: '2026-11-24T09:00:00Z' }] },
    goals: none
  }
});

const status = (b, id) => b.checks.find((c) => c.id === id)?.status;

test('healthy issue is READY', () => {
  const b = buildBrief(base(), NOW);
  assert.equal(b.verdict, 'READY');
  assert.equal(b.score, 100);
  assert.deepEqual(b.missing, []);
});

test('open blocker makes it NOT_READY, done blocker does not', () => {
  const ctx = base();
  ctx.links = [{ key: 'ABC-9', status: 'To Do', statusCategory: 'new', blocksThis: true }];
  const b = buildBrief(ctx, NOW);
  assert.equal(b.verdict, 'NOT_READY');
  assert.equal(status(b, 'blockers'), 'fail');
  assert.match(b.risks[0], /ABC-9/);

  ctx.links[0].statusCategory = 'done';
  assert.equal(buildBrief(ctx, NOW).verdict, 'READY');
});

test('failed latest deployment fails, even after an earlier success', () => {
  const ctx = base();
  ctx.delivery.deployments.items.push({ name: '#13', state: 'FAILED', environment: 'prod', environmentType: 'PRODUCTION', updatedAt: '2026-11-24T12:00:00Z' });
  const b = buildBrief(ctx, NOW);
  assert.equal(status(b, 'deploy'), 'fail');
  assert.equal(b.verdict, 'NOT_READY');
});

test('missing data is unknown and excluded from the score', () => {
  const ctx = base();
  ctx.delivery = { pullRequests: { items: [], unavailable: 'no graph' }, deployments: none, goals: none };
  ctx.docs = { items: [], unavailable: 'no confluence' };
  const b = buildBrief(ctx, NOW);
  assert.equal(status(b, 'code'), 'unknown');
  assert.equal(status(b, 'deploy'), 'unknown');
  assert.equal(status(b, 'docs'), 'unknown');
  assert.equal(b.score, 100);
  assert.match(b.confidence, /3 check/);
});

test('bare issue reports what is missing', () => {
  const b = buildBrief(
    {
      issue: { id: '1', key: 'ABC-2', summary: 'x', description: '', status: 'To Do', statusCategory: 'new', assignee: null, updated: '2026-11-20T00:00:00Z' },
      parent: null,
      docs: none,
      delivery: { pullRequests: none, deployments: none, goals: none }
    },
    NOW
  );
  assert.equal(b.verdict, 'NOT_READY');
  assert.ok(b.missing.length >= 4);
  assert.ok(b.score < 50);
});

test('comment classification: decisions and unanswered questions', () => {
  const comments = [
    { author: 'A', authorId: 'a', text: 'Should we retry on 429 too?' },
    { author: 'B', authorId: 'b', text: 'We decided to retry on 429 with jitter.' },
    { author: 'B', authorId: 'b', text: 'Who owns the dead-letter queue?' }
  ];
  const r = classifyComments(comments);
  assert.equal(r.decisions.length, 1);
  assert.equal(r.openQuestions.length, 1);
  assert.equal(r.openQuestions[0].author, 'B');

  const ctx = base();
  ctx.comments = comments;
  assert.equal(status(buildBrief(ctx, NOW), 'questions'), 'warn');
});

test('overdue and stale are flagged; text rendering includes verdict', () => {
  const ctx = base();
  ctx.issue.dueDate = '2026-11-20';
  ctx.issue.updated = '2026-10-01T00:00:00Z';
  const b = buildBrief(ctx, NOW);
  assert.equal(status(b, 'due'), 'fail');
  assert.equal(status(b, 'freshness'), 'warn');
  assert.match(briefToText(b), /ShipBrief for ABC-1: NOT READY/);
});
