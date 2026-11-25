// Pure, deterministic readiness analysis. No network, no LLM: takes the context
// bundle built in context.js and returns checks, a score and a verdict.

const DAY = 24 * 60 * 60 * 1000;

const DECISION_RE =
  /\b(decided|decision|agreed|we will|we'll go with|going with|approved|sign(ed)?[- ]off|confirmed|won't do|will not do|out of scope|descoped)\b/i;
const RISK_RE = /\b(blocked|blocker|risk|regression|rollback|rolled back|outage|incident|waiting on|depends on|workaround|flaky)\b/i;
const AC_RE =
  /(acceptance criteria|definition of done|\bDoD\b|\bAC\s*[:\-]|\bgiven\b[\s\S]{0,200}\bwhen\b[\s\S]{0,200}\bthen\b|success criteria|expected (result|behaviou?r))/i;
const TEST_RE = /\b(test plan|tested|qa|verified|unit tests?|e2e|regression test|how to test)\b/i;

const WEIGHTS = { fail: 0, warn: 0.5, pass: 1 };

export function clip(text, max = 280) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const isDone = (item) => item?.statusCategory === 'done';

function check(id, label, status, detail, weight = 1) {
  return { id, label, status, detail, weight };
}

export function classifyComments(comments = []) {
  const decisions = [];
  const risks = [];
  for (const c of comments) {
    if (DECISION_RE.test(c.text)) decisions.push({ author: c.author, created: c.created, text: clip(c.text) });
    else if (RISK_RE.test(c.text)) risks.push({ author: c.author, created: c.created, text: clip(c.text) });
  }
  // An open question = a question asked in the last comments that nobody else answered afterwards.
  const openQuestions = [];
  comments.forEach((c, i) => {
    if (!/\?(\s|$)/.test(c.text)) return;
    const answered = comments.slice(i + 1).some((later) => later.authorId !== c.authorId);
    if (!answered) openQuestions.push({ author: c.author, created: c.created, text: clip(c.text) });
  });
  return { decisions, risks, openQuestions };
}

export function buildBrief(ctx, now = Date.now()) {
  const { issue, parent, links = [], subtasks = [], comments = [], children, docs, delivery } = ctx;
  const checks = [];
  const missing = [];
  const inFlight = issue.statusCategory === 'indeterminate';
  const { decisions, risks, openQuestions } = classifyComments(comments);

  // 1. Is the work described?
  const descLen = (issue.description || '').trim().length;
  if (descLen >= 80) checks.push(check('description', 'Description', 'pass', `${descLen} characters of description.`, 2));
  else {
    checks.push(check('description', 'Description', descLen ? 'warn' : 'fail', descLen ? 'Description is very short.' : 'No description.', 2));
    missing.push('A description that explains what is changing and why.');
  }

  // 2. Acceptance criteria
  if (AC_RE.test(issue.description || '')) {
    checks.push(check('acceptance', 'Acceptance criteria', 'pass', 'Acceptance criteria found in the description.'));
  } else {
    checks.push(check('acceptance', 'Acceptance criteria', 'warn', 'No acceptance criteria or definition of done found in the description.'));
    missing.push('Acceptance criteria / definition of done.');
  }

  // 3. Owner
  if (issue.assignee) checks.push(check('owner', 'Owner', 'pass', `Assigned to ${issue.assignee}.`, 2));
  else {
    checks.push(check('owner', 'Owner', 'fail', 'Nobody is assigned.', 2));
    missing.push('An assignee.');
  }

  // 4. Goal context (parent / epic, Teamwork Graph goals)
  const goals = delivery?.goals?.items || [];
  if (parent || goals.length) {
    const bits = [];
    if (parent) bits.push(`${parent.key} "${clip(parent.summary, 80)}" (${parent.status})`);
    if (goals.length) bits.push(`goal: ${goals.map((g) => g.name).join(', ')}`);
    const thinParent = parent && !goals.length && !(parent.description || '').trim();
    checks.push(
      check('goal', 'Goal context', thinParent ? 'warn' : 'pass', `${bits.join('; ')}${thinParent ? ' — the parent has no description of the goal.' : ''}`)
    );
    if (thinParent) missing.push(`A goal description on parent ${parent.key}.`);
  } else if (issue.isEpic) {
    checks.push(check('goal', 'Goal context', 'pass', 'This work item is itself an epic.'));
  } else {
    checks.push(check('goal', 'Goal context', 'warn', 'Not linked to a parent, epic or goal.'));
    missing.push('A parent epic or goal that explains why this work matters.');
  }

  // 5. Blockers
  const blockers = links.filter((l) => l.blocksThis && !isDone(l));
  if (blockers.length) {
    checks.push(
      check('blockers', 'Blockers', 'fail', `Blocked by ${blockers.map((b) => `${b.key} (${b.status})`).join(', ')}.`, 2)
    );
  } else {
    const n = links.filter((l) => l.blocksThis).length;
    checks.push(check('blockers', 'Blockers', 'pass', n ? `All ${n} blocking work item(s) are done.` : 'No blocking links.', n ? 2 : 1));
  }

  // 6. Subtasks
  if (subtasks.length) {
    const open = subtasks.filter((s) => !isDone(s));
    checks.push(
      open.length
        ? check('subtasks', 'Subtasks', 'warn', `${open.length} of ${subtasks.length} subtasks still open: ${open.slice(0, 5).map((s) => s.key).join(', ')}.`)
        : check('subtasks', 'Subtasks', 'pass', `All ${subtasks.length} subtasks are done.`)
    );
  }

  // 6b. Child work items (epics): an epic is only as ready as its children.
  const childItems = children?.items || [];
  if (children?.unavailable) {
    checks.push(check('children', 'Child work items', 'unknown', children.unavailable));
  } else if (childItems.length) {
    const open = childItems.filter((c) => !isDone(c));
    const blocked = open.filter((c) => c.blockedBy?.length);
    const overdue = open.filter((c) => c.dueDate && Date.parse(c.dueDate) < now - DAY);
    const more = children.truncated ? ' (first 100 shown)' : '';
    if (!open.length) checks.push(check('children', 'Child work items', 'pass', `All ${childItems.length} child work items are done${more}.`, 2));
    else {
      const bits = [`${open.length} of ${childItems.length} child work items are not done${more}`];
      if (blocked.length) bits.push(`${blocked.length} blocked (${blocked.slice(0, 5).map((c) => c.key).join(', ')})`);
      if (overdue.length) bits.push(`${overdue.length} overdue (${overdue.slice(0, 5).map((c) => c.key).join(', ')})`);
      checks.push(check('children', 'Child work items', blocked.length || overdue.length ? 'fail' : 'warn', `${bits.join('; ')}.`, 2));
    }
  } else if (issue.isEpic && children) {
    checks.push(check('children', 'Child work items', 'warn', 'This epic has no child work items yet.'));
    missing.push('Child work items that break the epic down.');
  }

  // 7. Open questions
  if (openQuestions.length) {
    checks.push(
      check('questions', 'Open questions', 'warn', `${openQuestions.length} unanswered question(s) in recent comments, latest from ${openQuestions[openQuestions.length - 1].author}.`)
    );
    missing.push('Answers to the open questions in the comments.');
  } else {
    checks.push(check('questions', 'Open questions', 'pass', comments.length ? 'No unanswered questions in recent comments.' : 'No comments yet.', comments.length ? 1 : 0.5));
  }

  // 7b. Risks people raised in comments. Only counts while the work is still open.
  if (risks.length && !isDone(issue)) {
    const last = risks[risks.length - 1];
    checks.push(check('risks', 'Raised risks', 'warn', `${risks.length} comment(s) mention a risk or blocker, latest from ${last.author}: "${clip(last.text, 120)}"`, 2));
  }

  // 8. Freshness and dates
  const ageDays = issue.updated ? Math.floor((now - Date.parse(issue.updated)) / DAY) : null;
  if (inFlight && ageDays !== null && ageDays > 14) {
    checks.push(check('freshness', 'Activity', 'warn', `In progress but not updated for ${ageDays} days.`));
  } else if (ageDays !== null) {
    checks.push(check('freshness', 'Activity', 'pass', `Last updated ${ageDays} day(s) ago.`));
  }
  if (issue.dueDate && !isDone(issue)) {
    const late = Math.floor((now - Date.parse(issue.dueDate)) / DAY);
    if (late > 0) checks.push(check('due', 'Due date', 'fail', `Overdue by ${late} day(s) (due ${issue.dueDate}).`));
    else checks.push(check('due', 'Due date', -late <= 3 ? 'warn' : 'pass', `Due ${issue.dueDate} (${-late} day(s) left).`));
  }
  const lateVersions = (issue.fixVersions || []).filter((v) => !v.released && v.releaseDate && Date.parse(v.releaseDate) < now);
  if (lateVersions.length) {
    checks.push(check('release', 'Release', 'warn', `Fix version ${lateVersions.map((v) => v.name).join(', ')} is past its release date and not released.`));
  }

  // 9. Verification evidence
  const allText = `${issue.description || ''}\n${comments.map((c) => c.text).join('\n')}`;
  if (TEST_RE.test(allText)) checks.push(check('testing', 'Test evidence', 'pass', 'Testing is mentioned in the description or comments.'));
  else if (childItems.length) {
    // Parents are verified through their children, so no test note is expected here.
  } else {
    checks.push(check('testing', 'Test evidence', 'warn', 'No mention of a test plan or verification.'));
    missing.push('A note on how this was (or will be) tested.');
  }

  // 10. Code: pull requests (Teamwork Graph)
  const prs = delivery?.pullRequests;
  if (!prs || prs.unavailable) {
    checks.push(check('code', 'Pull requests', 'unknown', prs?.unavailable || 'Development data was not requested.'));
  } else if (!prs.items.length) {
    checks.push(check('code', 'Pull requests', 'unknown', 'No pull requests are linked to this work item in the Teamwork Graph.'));
  } else {
    const open = prs.items.filter((p) => p.status === 'OPEN' || p.status === 'DRAFT');
    const merged = prs.items.filter((p) => p.status === 'MERGED');
    if (open.length) checks.push(check('code', 'Pull requests', 'warn', `${open.length} pull request(s) still open, ${merged.length} merged.`, 2));
    else if (merged.length) checks.push(check('code', 'Pull requests', 'pass', `${merged.length} pull request(s) merged, none open.`, 2));
    else if (prs.items.some((p) => p.status === 'DECLINED')) checks.push(check('code', 'Pull requests', 'warn', 'Linked pull requests were declined; nothing merged.', 2));
    else checks.push(check('code', 'Pull requests', 'unknown', `${prs.items.length} linked pull request(s) with unknown status.`));
  }

  // 11. Deployments (Teamwork Graph)
  const deps = delivery?.deployments;
  if (!deps || deps.unavailable) {
    checks.push(check('deploy', 'Deployments', 'unknown', deps?.unavailable || 'Deployment data was not requested.'));
  } else if (!deps.items.length) {
    checks.push(check('deploy', 'Deployments', 'unknown', 'No deployments are linked to this work item in the Teamwork Graph.'));
  } else {
    const sorted = [...deps.items].sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    const latest = sorted[0];
    const bad = ['FAILED', 'ROLLED_BACK', 'CANCELLED'].includes(latest.state);
    const where = latest.environment || latest.environmentType || 'unknown environment';
    if (bad) checks.push(check('deploy', 'Deployments', 'fail', `Latest deployment to ${where} is ${latest.state}.`, 2));
    else if (latest.state === 'SUCCESSFUL') {
      const prod = sorted.some((d) => d.environmentType === 'PRODUCTION' && d.state === 'SUCCESSFUL');
      checks.push(check('deploy', 'Deployments', 'pass', `Latest deployment to ${where} succeeded${prod ? '; already in production' : ''}.`, 2));
    } else checks.push(check('deploy', 'Deployments', 'warn', `Latest deployment to ${where} is ${latest.state}.`, 2));
  }

  // 12. Documentation
  if (!docs || docs.unavailable) {
    checks.push(check('docs', 'Documentation', 'unknown', docs?.unavailable || 'Documentation was not searched.'));
  } else if (docs.items.length) {
    checks.push(check('docs', 'Documentation', 'pass', `${docs.items.length} related Confluence page(s), e.g. "${clip(docs.items[0].title, 80)}".`));
  } else {
    checks.push(check('docs', 'Documentation', 'warn', 'No Confluence page links to or mentions this work item.'));
    missing.push('A linked spec, design or runbook page.');
  }

  // Score: weighted mean of the checks we could actually evaluate.
  const scored = checks.filter((c) => c.status !== 'unknown');
  const total = scored.reduce((s, c) => s + c.weight, 0);
  const got = scored.reduce((s, c) => s + c.weight * WEIGHTS[c.status], 0);
  const score = total ? Math.round((got / total) * 100) : 0;
  const fails = checks.filter((c) => c.status === 'fail');
  const warns = checks.filter((c) => c.status === 'warn');
  const unknowns = checks.filter((c) => c.status === 'unknown');

  let verdict;
  if (isDone(issue) && !fails.length) verdict = 'SHIPPED';
  else if (fails.length) verdict = 'NOT_READY';
  else if (score >= 85 && warns.length <= 1) verdict = 'READY';
  else verdict = 'NEEDS_ATTENTION';

  const headline = {
    SHIPPED: 'Done. No failed checks.',
    READY: 'Looks ready to ship.',
    NEEDS_ATTENTION: `${warns.length} thing(s) to look at before shipping.`,
    NOT_READY: `Not ready: ${fails.map((f) => f.label.toLowerCase()).join(', ')}.`
  }[verdict];

  return {
    issueKey: issue.key,
    summary: issue.summary,
    url: issue.url,
    status: issue.status,
    verdict,
    score,
    headline,
    confidence: unknowns.length ? `${unknowns.length} check(s) could not be evaluated: ${unknowns.map((u) => u.label).join(', ')}.` : 'All checks evaluated.',
    checks: checks.map(({ weight, ...c }) => c),
    risks: [...fails, ...warns].map((c) => `${c.label}: ${c.detail}`),
    missing,
    goal: parent ? { key: parent.key, summary: parent.summary, status: parent.status, description: clip(parent.description, 400), url: parent.url } : null,
    goals,
    blockers,
    children: childItems,
    decisions,
    riskSignals: risks,
    openQuestions,
    pullRequests: prs?.items || [],
    deployments: deps?.items || [],
    docs: docs?.items || [],
    generatedAt: new Date(now).toISOString()
  };
}

export function briefToText(b) {
  const icon = { pass: '✅', warn: '⚠️', fail: '⛔', unknown: '❔' };
  const lines = [`ShipBrief for ${b.issueKey}: ${b.verdict.replace('_', ' ')} (${b.score}/100). ${b.headline}`, ''];
  for (const c of b.checks) lines.push(`${icon[c.status]} ${c.label}: ${c.detail}`);
  if (b.missing.length) lines.push('', 'Missing information:', ...b.missing.map((m) => `• ${m}`));
  if (b.decisions.length) lines.push('', 'Decisions found in comments:', ...b.decisions.map((d) => `• ${d.author}: ${d.text}`));
  if (b.openQuestions.length) lines.push('', 'Open questions:', ...b.openQuestions.map((q) => `• ${q.author}: ${q.text}`));
  lines.push('', b.confidence);
  return lines.join('\n');
}
