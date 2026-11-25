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

// ---- Phase 3: fixes from the live browser check on 2026-11-25 ----
import { briefToText, isShipBriefComment, BRIEF_MARKER } from '../src/brief.js';
import { parseDevSummary, friendlyGraphError } from '../src/devinfo.js';

const humanComments = [
  { author: 'Alana', authorId: 'a', created: '2026-11-20T10:00:00Z', text: 'We decided to send plain-text emails for the first release.' },
  { author: 'Ben', authorId: 'b', created: '2026-11-21T10:00:00Z', text: 'Do we need the Japanese template before launch?' }
];

test('a posted ShipBrief comment carries the marker and is recognised', () => {
  const text = briefToText(buildBrief(ctx({ comments: humanComments }), NOW));
  assert.ok(text.includes(BRIEF_MARKER));
  assert.equal(isShipBriefComment(text), true);
  // Briefs posted before the marker existed are recognised by their first line.
  assert.equal(isShipBriefComment('ShipBrief for TD-6: NOT READY (73/100). Not ready: blockers.\n\n⛔ Blockers: Blocked by TD-5 (In Progress).'), true);
  assert.equal(isShipBriefComment('I ran ShipBrief for this and it looks fine. Tested on staging?'), false);
  assert.equal(isShipBriefComment(''), false);
});

test('posting the brief as a comment does not change the next brief', () => {
  const before = buildBrief(ctx({ comments: humanComments }), NOW);
  // The posted brief quotes the open question ("?") and mentions "Test evidence", "risk", "decisions".
  const posted = { author: 'Ignacio', authorId: 'me', created: '2026-11-25T09:00:00Z', text: briefToText(before) };
  const legacy = { ...posted, text: posted.text.replace(BRIEF_MARKER, '') };
  for (const extra of [posted, legacy]) {
    const after = buildBrief(ctx({ comments: [...humanComments, extra] }), NOW);
    assert.equal(after.score, before.score);
    assert.equal(after.verdict, before.verdict);
    assert.deepEqual(after.openQuestions, before.openQuestions);
    assert.deepEqual(after.decisions, before.decisions);
    assert.deepEqual(after.riskSignals, before.riskSignals);
    assert.deepEqual(after.checks, before.checks);
  }
  assert.equal(before.openQuestions.length, 1);
  assert.equal(byId(before, 'testing').status, 'warn', 'the brief text must not count as test evidence');
});

test('Teamwork Graph errors are turned into friendly text', () => {
  const m = friendlyGraphError('User is not permitted to query this organization');
  assert.match(m, /did not allow your account to query this organization/);
  assert.doesNotMatch(m, /^Teamwork Graph: User is not permitted/);
  assert.match(friendlyGraphError('boom'), /could not be read \(boom\)/);
});

// Real value of the development field on PLAT-4148 (demo site, 2026-11-25).
const DEV_BUILDS = '{build={count=2, dataType=build, failedBuildCount=0, successfulBuildCount=2, unknownBuildCount=0}, json={"cachedValue":{"errors":[],"summary":{"build":{"overall":{"count":2,"lastUpdated":null,"failedBuildCount":0,"successfulBuildCount":2,"unknownBuildCount":0,"dataType":"build"},"byInstanceType":{"cloud-providers":{"count":2,"name":"Other providers"}}}}},"isStale":true}}';
// Shape Jira uses when pull requests are linked (not present on the demo site, so this one is hand-written).
const DEV_PR = (state) => `{pullrequest={dataType=pullrequest, state=${state}, stateCount=2}, json={"cachedValue":{"errors":[],"summary":{"pullrequest":{"overall":{"count":2,"lastUpdated":"2026-11-24T10:00:00.000+0800","stateCount":2,"state":"${state}","dataType":"pullrequest","open":${state === 'OPEN'}},"byInstanceType":{"GitHub":{"count":2,"name":"GitHub"}}},"deployment-environment":{"overall":{"count":1,"topEnvironments":[{"title":"staging"}],"successfulCount":1,"dataType":"deployment-environment"},"byInstanceType":{}}}},"isStale":false}}`;

test('parseDevSummary reads the Jira development field', () => {
  const empty = parseDevSummary('{}');
  assert.equal(empty.pullRequests.count, 0);
  assert.equal(empty.builds.count, 0);
  const b = parseDevSummary(DEV_BUILDS);
  assert.deepEqual(b.builds, { count: 2, failed: 0, successful: 2 });
  assert.equal(b.pullRequests.count, 0);
  assert.equal(b.stale, true);
  const p = parseDevSummary(DEV_PR('MERGED'));
  assert.equal(p.pullRequests.count, 2);
  assert.equal(p.pullRequests.state, 'MERGED');
  assert.deepEqual(p.deployments.environments, ['staging']);
  assert.equal(parseDevSummary(null), null);
  assert.equal(parseDevSummary('{pullrequest={x}, json={not json}}'), null);
  assert.equal(parseDevSummary('something else'), null);
});

const fallback = (raw) => {
  const dev = parseDevSummary(raw);
  const source = 'jira-development-summary';
  return {
    pullRequests: { items: [], source, summary: dev.pullRequests },
    deployments: { items: [], source, summary: dev.deployments },
    builds: { source, summary: dev.builds },
    goals: { items: [], unavailable: 'x' }
  };
};

test('brief uses the Jira development summary when the Teamwork Graph is unavailable', () => {
  let b = buildBrief(ctx({ delivery: fallback('{}') }), NOW);
  assert.equal(byId(b, 'code').status, 'unknown');
  assert.match(byId(b, 'code').detail, /No pull requests are linked.*Jira's development panel/);
  assert.equal(byId(b, 'deploy').status, 'unknown');
  assert.equal(byId(b, 'builds'), undefined);

  b = buildBrief(ctx({ delivery: fallback(DEV_BUILDS) }), NOW);
  assert.equal(byId(b, 'builds').status, 'pass');
  assert.match(byId(b, 'builds').detail, /All 2 linked build\(s\) passed/);

  b = buildBrief(ctx({ delivery: fallback(DEV_PR('MERGED')) }), NOW);
  assert.equal(byId(b, 'code').status, 'pass');
  assert.equal(byId(b, 'deploy').status, 'unknown', 'a count without state is never scored');
  assert.match(byId(b, 'deploy').detail, /1 deployment environment\(s\) linked \(staging\)/);
  assert.equal(b.deliverySource.pullRequests, 'jira-development-summary');

  b = buildBrief(ctx({ delivery: fallback(DEV_PR('OPEN')) }), NOW);
  assert.equal(byId(b, 'code').status, 'warn');
});

test('without any development source the checks stay unknown with a friendly reason', () => {
  const unavailable = friendlyGraphError('User is not permitted to query this organization');
  const b = buildBrief(ctx({ delivery: { pullRequests: { items: [], unavailable }, deployments: { items: [], unavailable }, goals: { items: [], unavailable } } }), NOW);
  assert.equal(byId(b, 'code').status, 'unknown');
  assert.equal(byId(b, 'code').detail, unavailable);
});
