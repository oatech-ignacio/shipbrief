// Seeds the ShipBrief demo data into project TD (Tally Dev) and a Confluence space. Idempotent via label + state file.
import fs from 'node:fs';
import { get, post, put, SITE } from './api.mjs';
const PROJECT = 'TD', LABEL = 'shipbrief-demo', STATE = new URL('./state.json', import.meta.url);
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE)) : { issues: {}, pages: {}, done: {} };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

// --- mini markdown -> ADF ---
const inline = (t) => [{ type: 'text', text: t }];
function adf(md) {
  const content = []; let list = null;
  for (const line of md.trim().split('\n')) {
    if (line.startsWith('- ')) {
      if (!list) { list = { type: 'bulletList', content: [] }; content.push(list); }
      list.content.push({ type: 'listItem', content: [{ type: 'paragraph', content: inline(line.slice(2)) }] });
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    if (line.startsWith('## ')) content.push({ type: 'heading', attrs: { level: 3 }, content: inline(line.slice(3)) });
    else content.push({ type: 'paragraph', content: inline(line) });
  }
  return { type: 'doc', version: 1, content };
}

const project = await get(`/rest/api/3/project/${PROJECT}`);
const typeName = { 大型工作: 'Epic', 故事: 'Story', 任務: 'Task', 漏洞: 'Bug', 子任務: 'Subtask', 'Sub-task': 'Subtask' };
const types = {}; for (const t of project.issueTypes) types[typeName[t.name] || t.name] = t.id;
const users = (await get(`/rest/api/3/user/assignable/search?project=${PROJECT}&maxResults=100`)).filter((u) => u.accountType === 'atlassian');
const uid = (n) => (users.length ? users[n % users.length].accountId : undefined); // assignees are picked by position, not by name
console.log('assignable users:', users.length);

// --- fix version ---
if (!state.versionId) {
  const v = await post('/rest/api/3/version', { name: 'Tally 2.4', projectId: Number(project.id), releaseDate: '2026-12-10', description: 'Self-serve refunds' });
  state.versionId = v.id; save();
}

const ISSUES = [
  { id: 'epic', type: 'Epic', summary: 'Self-serve refunds in Tally checkout', assignee: 0, due: '2026-12-10', to: '進行中',
    desc: `## Goal
Let Tally customers request a full or partial refund from the customer portal without contacting support. Refund tickets are 31% of support volume; target is to cut them by half within one quarter of launch.
## Scope for Tally 2.4
- Partial refund API in the payments service
- Refund request form in the customer portal
- Confirmation emails in all 6 supported locales
- Staged rollout behind the refunds.selfserve feature flag
## Success criteria
- 50% fewer refund tickets within 90 days
- Refund p95 latency under 800 ms at 200 rps
- Zero double refunds` },
  { id: 'api', type: 'Story', summary: 'Partial refund endpoint in payments service', assignee: 5, to: '完成', fix: true,
    desc: `Add POST /v2/payments/{id}/refunds so a refund can cover part of an order (single line items or a custom amount). Today only full refunds are possible and they go through support.
## Acceptance criteria
- Amount cannot exceed the captured amount minus earlier refunds
- Idempotency-Key header is required; a repeated key returns the first response
- Refund events are published to the ledger topic
## Test plan
Unit tests for amount validation, contract tests against the ledger consumer, and an e2e run in staging.`,
    comments: [
      'Decision from API review with Alana and Kevin: we will require the Idempotency-Key header instead of deduplicating on amount + timestamp. Keeps the contract explicit for mobile clients.',
      'Merged and deployed to staging. Verified with the e2e suite: 42 of 42 refund scenarios pass, including the repeated-key case.' ] },
  { id: 'load', type: 'Task', summary: 'Load test refund endpoint at 200 rps', assignee: 3, to: '完成', fix: true,
    desc: `Run a 30 minute k6 soak test against staging at 200 rps with a 70/30 mix of full and partial refunds, and confirm the success criteria on the epic.
## Definition of done
- p95 latency under 800 ms
- Error rate under 0.1%
- Results attached to the design doc`,
    comments: [ 'Tested on staging: p95 612 ms, p99 940 ms, error rate 0.02% over 30 minutes at 200 rps. Results added to the design doc. Confirmed we meet the launch criteria.' ] },
  { id: 'form', type: 'Story', summary: 'Refund request form in customer portal', assignee: 1, to: '測試中', fix: true, due: '2026-12-04',
    desc: `Customers can open an order in the portal, pick the items to refund, choose a reason and submit. The form calls the partial refund endpoint and shows the result inline.
## Acceptance criteria
- Given an order with captured payment, when the customer selects items and submits, then a refund is created and the order shows "Refund requested"
- Orders older than 60 days show a "Contact support" message instead of the form
- The submit button is disabled while the request is in flight
## Test plan
Component tests for the form states, Playwright e2e for the happy path and the 60-day cutoff, manual QA on iOS Safari and Android Chrome.`,
    comments: [
      'Design review outcome: agreed to go with a single-page form rather than a 3-step wizard. Usability test showed 9 of 10 participants finished faster on the single page.',
      'Decided with Legal (Ada): the refund window is 60 days from capture, not from delivery. The cutoff message links to the support form.',
      'QA pass on staging build 2.4.0-rc2: all 18 Playwright scenarios green, manual checks done on iOS Safari 18 and Android Chrome. Ready for release sign-off.' ] },
  { id: 'tpl', type: 'Bug', summary: 'Email template service drops the locale header on retry', assignee: 6, to: '進行中', fix: true, priority: 'High',
    desc: `When the first send attempt times out, the retry is enqueued without the X-Locale header, so the email falls back to en-US. Seen in staging for 4% of sends.
## Expected behaviour
Retries carry the same locale as the original request.
## How to reproduce
Set SMTP latency to 6 s in staging and send any localized template.`,
    comments: [ 'Root cause found: the retry job serializes only the payload, not the headers. Fix needs a change in the shared queue library, which the Platform team owns. Waiting on their review; this is a risk for the 2.4 date.' ] },
  { id: 'email', type: 'Story', summary: 'Send refund confirmation emails in all supported locales', assignee: 2, to: '進行中', fix: true, due: '2026-12-02',
    desc: `Send an email when a refund is requested and another when it is paid out. Templates are needed for en, de, fr, es, ja and zh-TW.
## Acceptance criteria
- Both emails are sent within 1 minute of the event
- The email language matches the customer locale
- Amount and currency are formatted for the locale`,
    comments: [
      'We will reuse the order-confirmation layout for both emails; agreed with Design so we do not need new brand review.',
      'Blocked on the template service bug: retried sends lose the locale, so German and Japanese customers would get English emails. Not safe to ship until that is fixed.',
      'Do we still send the "refund paid" email when the payout fails and is retried the next day, or only after the payout succeeds? Need an answer from Payments before I finish the template.' ] },
  { id: 'flag', type: 'Task', summary: 'Rollout plan and feature flag for self-serve refunds', assignee: 4, to: '進行中', fix: true, due: '2026-11-27',
    desc: `Ship behind refunds.selfserve and roll out in stages: internal, 5%, 25%, 100%. Define the rollback trigger and who is on call for each stage.
## Definition of done
- Flag exists in all environments, default off
- Rollout stages and rollback trigger are written in the release checklist
- Support has the macro for refund questions`,
    comments: [
      'Decision: rollback trigger is a refund error rate above 1% for 10 minutes, or any confirmed double refund. Cassi approved this for Support.',
      'Risk: the 25% stage falls on the Dec 8 billing run. If the ledger lags we could see delayed refund events. Proposed workaround is to hold at 5% until Dec 9.' ],
    subtasks: [ { summary: 'Create refunds.selfserve flag in all environments', to: '完成' }, { summary: 'Write support macro for refund questions', to: null }, { summary: 'Dry-run rollback in staging', to: null } ] },
  { id: 'dbl', type: 'Bug', summary: 'Double refund when the customer double-clicks Submit', assignee: 1, to: '進行中', fix: true, due: '2026-11-20', priority: 'Highest',
    desc: `Two refund requests are created when Submit is clicked twice within about 300 ms on slow connections. The portal generates a new Idempotency-Key per click.
## Expected behaviour
One refund per form submission, no matter how many clicks.`,
    comments: [ 'Found during exploratory testing on a throttled 3G profile. This is a launch blocker: it breaks the "zero double refunds" success criterion on the epic.' ] },
  { id: 'audit', type: 'Story', summary: 'Refund audit log export', assignee: null, to: null, noParent: true, desc: null },
];

const createIssue = async (fields) => (await post('/rest/api/3/issue', { fields })).key;
async function transition(key, toName) {
  if (!toName) return;
  const { transitions } = await get(`/rest/api/3/issue/${key}/transitions`);
  const t = transitions.find((x) => x.to.name === toName);
  if (!t) throw new Error(`no transition to ${toName} for ${key}: ${transitions.map((x) => x.to.name)}`);
  await post(`/rest/api/3/issue/${key}/transitions`, { transition: { id: t.id } });
}

for (const it of ISSUES) {
  if (state.issues[it.id]) continue;
  const fields = { project: { key: PROJECT }, issuetype: { id: types[it.type] }, summary: it.summary, labels: [LABEL] };
  if (it.desc) fields.description = adf(it.desc);
  if (it.assignee != null && uid(it.assignee)) fields.assignee = { accountId: uid(it.assignee) };
  if (it.due) fields.duedate = it.due;
  if (it.fix) fields.fixVersions = [{ id: state.versionId }];
  if (it.priority) fields.priority = { name: it.priority };
  if (it.type !== 'Epic' && !it.noParent) fields.parent = { key: state.issues.epic };
  const key = await createIssue(fields);
  state.issues[it.id] = key; save();
  for (const c of it.comments || []) await post(`/rest/api/3/issue/${key}/comment`, { body: adf(c) });
  for (const [i, s] of (it.subtasks || []).entries()) {
    const sk = await createIssue({ project: { key: PROJECT }, issuetype: { id: types.Subtask }, parent: { key }, summary: s.summary, labels: [LABEL] });
    state.issues[`${it.id}-sub${i + 1}`] = sk; save();
    await transition(sk, s.to);
  }
  await transition(key, it.to);
  console.log('created', it.id, key);
}
const K = state.issues;

// --- links: inwardIssue "is blocked by" outwardIssue?  Jira: outwardIssue is the one that "is blocked", inwardIssue blocks. Verified after creation.
const LINKS = [ ['Blocks', 'tpl', 'email'], ['Blocks', 'load', 'form'], ['Blocks', 'api', 'form'], ['Relates', 'dbl', 'form'], ['Blocks', 'dbl', 'flag'] ];
for (const [type, from, to] of LINKS) {
  const id = `${type}:${from}:${to}`; if (state.done[id]) continue;
  await post('/rest/api/3/issueLink', { type: { name: type }, inwardIssue: { key: K[from] }, outwardIssue: { key: K[to] } }); // from blocks to
  state.done[id] = true; save();
}

// --- Confluence ---
if (!state.spaceId) {
  let sp;
  try { sp = (await get('/wiki/api/v2/spaces?keys=TDEV')).results[0]; } catch {}
  if (!sp) sp = await post('/wiki/rest/api/space', { key: 'TDEV', name: 'Tally Dev', description: { plain: { value: 'Engineering docs for Tally (ShipBrief demo data)', representation: 'plain' } } });
  state.spaceId = String(sp.id); save();
}
const li = (a) => `<ul>${a.map((x) => `<li>${x}</li>`).join('')}</ul>`;
const jl = (id) => `<a href="${SITE}/browse/${K[id]}">${K[id]}</a>`;
const PAGES = [
  { id: 'design', title: 'Self-serve refunds: design doc', body: `
<h2>Summary</h2><p>Design for self-serve refunds in Tally checkout (epic ${jl('epic')}), shipping in Tally 2.4. Customers request full or partial refunds in the portal; the payments service validates and executes them.</p>
<h2>Architecture</h2>${li(['Portal form (' + jl('form') + ') calls <code>POST /v2/payments/{id}/refunds</code> (' + jl('api') + ').', 'Payments service validates the amount, writes the refund and publishes <code>refund.requested</code> / <code>refund.paid</code> to the ledger topic.', 'Notification service consumes both events and sends localized emails (' + jl('email') + ').'])}
<h2>Decisions</h2>${li(['<strong>Idempotency:</strong> clients must send an Idempotency-Key header. Rejected alternative: dedupe on amount + timestamp.', '<strong>Refund window:</strong> 60 days from capture (Legal).', '<strong>UI:</strong> single-page form, not a wizard.'])}
<h2>Load test results</h2><p>${jl('load')}: 200 rps for 30 minutes on staging. p95 612 ms, p99 940 ms, error rate 0.02%.</p>
<h2>Known risks</h2>${li(['Double submit creates two refunds (' + jl('dbl') + ').', 'Template service loses the locale on retry (' + jl('tpl') + ').'])}` },
  { id: 'checklist', title: 'Tally 2.4 release checklist', body: `
<p>Release owner: Max Taylor. Target date: 10 Dec 2026. Rollout tracked in ${jl('flag')}.</p>
<h2>Before rollout</h2>${li(['Partial refund endpoint in production, flag off (' + jl('api') + ')', 'Load test passed (' + jl('load') + ')', 'Portal form QA sign-off (' + jl('form') + ')', 'Confirmation emails verified in 6 locales (' + jl('email') + ')', 'No open launch blockers (' + jl('dbl') + ', ' + jl('tpl') + ')', 'Support macro published'])}
<h2>Rollout stages</h2>${li(['Internal staff: 1 day', '5% of customers: 2 days', '25% of customers: 2 days (avoid the 8 Dec billing run)', '100%'])}
<h2>Rollback trigger</h2><p>Refund error rate above 1% for 10 minutes, or any confirmed double refund. Turn off <code>refunds.selfserve</code>; no deploy needed.</p>` },
  { id: 'runbook', title: 'Runbook: refund incidents', body: `
<p>On-call guide for the refund flow introduced by ${jl('epic')}.</p>
<h2>Double refund reported</h2>${li(['Turn off <code>refunds.selfserve</code>.', 'Find both refunds by order id in the ledger and reverse the later one.', 'Link the incident to ' + jl('dbl') + '.'])}
<h2>Emails in the wrong language</h2><p>Check the retry queue for jobs without <code>X-Locale</code> (see ${jl('tpl')}). Re-send from the notification admin with the locale set.</p>` },
];
for (const p of PAGES) {
  if (state.pages[p.id]) continue;
  const r = await post('/wiki/api/v2/pages', { spaceId: state.spaceId, status: 'current', title: p.title, body: { representation: 'storage', value: p.body.trim() } });
  state.pages[p.id] = { id: r.id, url: `${SITE}/wiki${r._links.webui}`, title: p.title }; save();
  console.log('page', p.id, state.pages[p.id].url);
}
// --- remote links from issues to pages ---
const RL = { epic: ['design', 'checklist'], api: ['design'], load: ['design'], form: ['design', 'checklist'], flag: ['checklist', 'runbook'], dbl: ['runbook'] };
for (const [iss, pages] of Object.entries(RL)) for (const pg of pages) {
  const id = `rl:${iss}:${pg}`; if (state.done[id]) continue;
  const p = state.pages[pg];
  await post(`/rest/api/3/issue/${K[iss]}/remotelink`, { globalId: `shipbrief-demo-${p.id}`, object: { url: p.url, title: p.title } });
  state.done[id] = true; save();
}
console.log(JSON.stringify({ issues: K, pages: state.pages }, null, 1));
