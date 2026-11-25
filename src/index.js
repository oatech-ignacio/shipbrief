import Resolver from '@forge/resolver';
import { buildBrief, briefToText } from './brief';
import { gatherAll, getIssueContext, findRelatedDocs, getDeliveryStatus, postComment } from './context';

const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/i;

// Rovo and MCP calls put inputs at the top level and page context in payload.context.
function resolveTarget(payload = {}) {
  const pc = payload.context || {};
  const issueKey = (payload.issueKey || pc.jira?.issueKey || '').toString().trim().toUpperCase();
  if (!issueKey || !KEY_RE.test(issueKey)) {
    return { error: 'No Jira work item key was provided. Ask the user for a key such as ABC-123.' };
  }
  let siteUrl;
  try {
    siteUrl = pc.jira?.url ? new URL(pc.jira.url).origin : undefined;
  } catch (e) {
    siteUrl = undefined;
  }
  return { issueKey, cloudId: pc.cloudId, siteUrl };
}

function friendly(e, issueKey) {
  if (e.status === 404) return { error: `Work item ${issueKey} was not found, or you do not have permission to see it.` };
  if (e.status === 401 || e.status === 403) return { error: `You do not have permission to read ${issueKey}.` };
  console.error('ShipBrief action failed', e);
  return { error: `ShipBrief could not read ${issueKey}: ${e.message}` };
}

async function withTarget(payload, fn) {
  const t = resolveTarget(payload);
  if (t.error) return t;
  try {
    return await fn(t);
  } catch (e) {
    return friendly(e, t.issueKey);
  }
}

// ---- Rovo actions / MCP tools ----------------------------------------------

export const briefAction = (payload) =>
  withTarget(payload, async ({ issueKey, cloudId, siteUrl }) => buildBrief(await gatherAll(issueKey, { cloudId, siteUrl })));

export const contextAction = (payload) => withTarget(payload, ({ issueKey, siteUrl }) => getIssueContext(issueKey, { siteUrl }));

export const docsAction = (payload) =>
  withTarget(payload, async ({ issueKey, siteUrl }) => {
    const { issue } = await getIssueContext(issueKey, { siteUrl });
    return { issueKey: issue.key, ...(await findRelatedDocs(issue.key, issue.summary)) };
  });

export const deliveryAction = (payload) =>
  withTarget(payload, async ({ issueKey, cloudId, siteUrl }) => {
    const { issue } = await getIssueContext(issueKey, { siteUrl });
    return { issueKey: issue.key, ...(await getDeliveryStatus(issue.id, cloudId)) };
  });

export const postCommentAction = (payload) =>
  withTarget(payload, async ({ issueKey, cloudId, siteUrl }) => {
    const brief = buildBrief(await gatherAll(issueKey, { cloudId, siteUrl }));
    const { id } = await postComment(brief.issueKey, briefToText(brief));
    return { posted: true, commentId: id, issueKey: brief.issueKey, verdict: brief.verdict, score: brief.score };
  });

// ---- Issue panel resolver --------------------------------------------------

const resolver = new Resolver();

function panelTarget(req) {
  const ext = req.context?.extension || {};
  return {
    issueKey: ext.issue?.key,
    cloudId: req.context?.cloudId,
    siteUrl: req.context?.siteUrl
  };
}

resolver.define('getBrief', async (req) => {
  const { issueKey, cloudId, siteUrl } = panelTarget(req);
  if (!issueKey) return { error: 'This panel must be opened on a Jira work item.' };
  try {
    return buildBrief(await gatherAll(issueKey, { cloudId, siteUrl }));
  } catch (e) {
    return friendly(e, issueKey);
  }
});

resolver.define('postBrief', async (req) => {
  const { issueKey, cloudId, siteUrl } = panelTarget(req);
  if (!issueKey) return { error: 'This panel must be opened on a Jira work item.' };
  try {
    const brief = buildBrief(await gatherAll(issueKey, { cloudId, siteUrl }));
    await postComment(issueKey, briefToText(brief));
    return { posted: true };
  } catch (e) {
    return friendly(e, issueKey);
  }
});

export const panelHandler = resolver.getDefinitions();
