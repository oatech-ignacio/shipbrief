import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief } from '../src/brief.js';
import { TWG_QUERIES } from '../src/twg-queries.js';

const NOW = Date.parse('2026-11-25T00:00:00Z');
const none = { items: [] };
const ctx = ({ issue, ...over } = {}) => ({
  issue: {
    id: '1', key: 'TD-1', summary: 'Self-serve refunds', status: 'In Progress', statusCategory: 'indeterminate', assignee: 'Alana',
    description: 'Let customers request refunds in the portal without contacting support, to halve refund tickets.\nSuccess criteria: 50% fewer tickets.',
    updated: '2026-11-24T10:00:00Z', fixVersions: [], ...issue
  },
  parent: null, links: [], subtasks: [], comments: [],
  docs: { items: [{ title: 'Design doc', url: 'https://x.atlassian.net/wiki/x' }] },
  delivery: { pullRequests: none, deployments: none, goals: none },
  ...over
});
const byId = (b, id) => b.checks.find((c) => c.id === id);

test('Teamwork Graph operation names follow the gateway rule [company]_[operation]', () => {
  for (const q of Object.values(TWG_QUERIES)) {
    const name = /^query (\w+)\(/.exec(q)?.[1];
    assert.match(name || '', /^[a-z]{3,}_[A-Za-z]{4,}$/, `bad operation name in: ${q.slice(0, 40)}`);
    assert.ok(name.length <= 100);
  }
});

test('epic with blocked or overdue children is not ready', () => {
  const children = { items: [
    { key: 'TD-2', statusCategory: 'done' },
    { key: 'TD-6', statusCategory: 'indeterminate', blockedBy: ['TD-5'] },
    { key: 'TD-11', statusCategory: 'indeterminate', dueDate: '2026-11-20', blockedBy: [] }
  ] };
  const b = buildBrief(ctx({ issue: { isEpic: true }, children }), NOW);
  const c = byId(b, 'children');
  assert.equal(c.status, 'fail');
  assert.match(c.detail, /2 of 3 child work items are not done; 1 blocked \(TD-6\); 1 overdue \(TD-11\)/);
  assert.equal(b.verdict, 'NOT_READY');
  assert.equal(byId(b, 'testing'), undefined, 'parents are not asked for their own test note');
  assert.equal(b.children.length, 3);
});

test('epic children: open without trouble warns, all done passes, none warns, unreadable is unknown', () => {
  const open = buildBrief(ctx({ issue: { isEpic: true }, children: { items: [{ key: 'A-1', statusCategory: 'new' }] } }), NOW);
  assert.equal(byId(open, 'children').status, 'warn');
  const done = buildBrief(ctx({ issue: { isEpic: true }, children: { items: [{ key: 'A-1', statusCategory: 'done' }] } }), NOW);
  assert.equal(byId(done, 'children').status, 'pass');
  assert.equal(done.verdict, 'READY');
  const empty = buildBrief(ctx({ issue: { isEpic: true }, children: { items: [] } }), NOW);
  assert.equal(byId(empty, 'children').status, 'warn');
  const err = buildBrief(ctx({ issue: { isEpic: true }, children: { items: [], unavailable: 'Jira responded 400' } }), NOW);
  assert.equal(byId(err, 'children').status, 'unknown');
  const story = buildBrief(ctx(), NOW);
  assert.equal(byId(story, 'children'), undefined);
});

test('a risk raised in comments lowers an open item but not a finished one', () => {
  const comments = [{ author: 'Ryan', authorId: 'r', created: '2026-11-24', text: 'Fix needs the Platform team. Waiting on their review; this is a risk for the date. Tested locally.' }];
  const open = buildBrief(ctx({ comments }), NOW);
  assert.equal(byId(open, 'risks').status, 'warn');
  assert.match(byId(open, 'risks').detail, /latest from Ryan/);
  const closed = buildBrief(ctx({ comments, issue: { statusCategory: 'done' } }), NOW);
  assert.equal(byId(closed, 'risks'), undefined);
  assert.equal(closed.verdict, 'SHIPPED');
});

test('two warnings are enough to hold back READY', () => {
  const parent = { key: 'TD-1', summary: 'Epic', status: 'In Progress', description: 'Goal text' };
  const b = buildBrief(ctx({ parent, docs: { items: [] } }), NOW); // no docs + no test evidence
  assert.equal(b.checks.filter((c) => c.status === 'warn').length, 2);
  assert.equal(b.verdict, 'NEEDS_ATTENTION');
});

test('pull requests with UNKNOWN status are reported as unknown, not as declined', () => {
  const delivery = { pullRequests: { items: [{ title: 'x', status: 'UNKNOWN' }] }, deployments: none, goals: none };
  const c = byId(buildBrief(ctx({ delivery }), NOW), 'code');
  assert.equal(c.status, 'unknown');
  const declined = { pullRequests: { items: [{ title: 'x', status: 'DECLINED' }] }, deployments: none, goals: none };
  assert.match(byId(buildBrief(ctx({ delivery: declined }), NOW), 'code').detail, /declined/);
});
