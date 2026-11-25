// Gathers context around a Jira work item. Every call runs as the current user,
// so the brief never shows anything the user could not already see.
import api, { route } from '@forge/api';
import { TWG_QUERIES } from './twg-queries';
import { isShipBriefComment } from './brief';
import { parseDevSummary, friendlyGraphError } from './devinfo';
import { CONFLUENCE_SEARCH } from './variant';

const ISSUE_FIELDS =
  'summary,description,status,issuetype,priority,assignee,reporter,labels,fixVersions,duedate,parent,issuelinks,subtasks,comment,updated,created,components';
const MAX_COMMENTS = 15;
// Fetch a few extra so that briefs posted by ShipBrief itself (which are skipped) do not crowd out real comments.
const COMMENT_FETCH = 30;
const MAX_CHILDREN = 100;

// Atlassian Document Format -> plain text
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfToText).join('');
  let out = '';
  if (node.type === 'text') out += node.text || '';
  else if (node.type === 'mention') out += node.attrs?.text || '@user';
  else if (node.type === 'hardBreak') out += '\n';
  else if (node.type === 'inlineCard' || node.type === 'blockCard') out += node.attrs?.url || '';
  else if (node.type === 'emoji') out += node.attrs?.text || '';
  if (node.content) out += adfToText(node.content);
  if (['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'tableRow'].includes(node.type)) out += '\n';
  return out;
}

async function jiraGet(path) {
  const res = await api.asUser().requestJira(path, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`Jira responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Links come from user-editable data (remote links, PR and deployment providers).
// Only https URLs are passed on, so a javascript: or data: link can never reach the UI or the agent.
export function safeUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' ? u.href : undefined;
  } catch (e) {
    return undefined;
  }
}

const browseUrl = (base, key) => (base && key ? `${base}/browse/${key}` : undefined);

function siteBase(selfUrl) {
  // issue.self looks like https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/issue/10001 on Forge,
  // so the site URL is taken from context when available instead.
  const m = /^(https:\/\/[^/]+\.atlassian\.net)/.exec(selfUrl || '');
  return m ? m[1] : undefined;
}

function slimLinked(i, base) {
  return {
    key: i.key,
    summary: i.fields?.summary,
    status: i.fields?.status?.name,
    statusCategory: i.fields?.status?.statusCategory?.key,
    type: i.fields?.issuetype?.name,
    url: browseUrl(base, i.key)
  };
}

export async function getIssueContext(issueKey, { siteUrl } = {}) {
  const raw = await jiraGet(route`/rest/api/3/issue/${issueKey}?fields=${ISSUE_FIELDS}`);
  const f = raw.fields;
  let base = siteUrl || siteBase(raw.self);
  if (!base) {
    // On Forge, issue.self points at api.atlassian.com, so ask Jira for the site URL when the caller did not supply it.
    try {
      base = siteBase((await jiraGet(route`/rest/api/3/serverInfo`)).baseUrl);
    } catch (e) {
      /* links are simply omitted */
    }
  }

  const issue = {
    id: raw.id,
    key: raw.key,
    url: browseUrl(base, raw.key),
    summary: f.summary,
    description: adfToText(f.description).trim(),
    status: f.status?.name,
    statusCategory: f.status?.statusCategory?.key, // new | indeterminate | done
    type: f.issuetype?.name,
    isEpic: f.issuetype?.hierarchyLevel === 1,
    priority: f.priority?.name,
    assignee: f.assignee?.displayName || null,
    reporter: f.reporter?.displayName || null,
    labels: f.labels || [],
    components: (f.components || []).map((c) => c.name),
    fixVersions: (f.fixVersions || []).map((v) => ({ name: v.name, released: v.released, releaseDate: v.releaseDate })),
    dueDate: f.duedate || null,
    created: f.created,
    updated: f.updated
  };

  const links = (f.issuelinks || []).map((l) => {
    const other = l.inwardIssue || l.outwardIssue;
    const relation = l.inwardIssue ? l.type?.inward : l.type?.outward;
    return {
      ...slimLinked(other, base),
      relation,
      // "is blocked by X" (inward side of a Blocks link) means X blocks this work item.
      blocksThis: Boolean(l.inwardIssue) && /block/i.test(l.type?.name || relation || '')
    };
  });

  const subtasks = (f.subtasks || []).map((s) => slimLinked(s, base));

  // The embedded comment page is oldest-first; fetch the newest page explicitly when there are more.
  let rawComments = f.comment?.comments || [];
  if ((f.comment?.total || 0) > rawComments.length) {
    try {
      const page = await jiraGet(route`/rest/api/3/issue/${issueKey}/comment?orderBy=-created&maxResults=${COMMENT_FETCH}`);
      rawComments = (page.comments || []).reverse();
    } catch (e) {
      /* keep the embedded page */
    }
  }
  // Briefs that ShipBrief posted earlier are not evidence: analysing them would feed the brief back into itself.
  const { comments, ignoredBriefComments } = selectComments(rawComments);

  let parent = null;
  if (f.parent?.key) {
    try {
      const p = await jiraGet(route`/rest/api/3/issue/${f.parent.key}?fields=summary,description,status,issuetype,duedate`);
      parent = {
        key: p.key,
        url: browseUrl(base, p.key),
        summary: p.fields.summary,
        description: adfToText(p.fields.description).trim(),
        status: p.fields.status?.name,
        statusCategory: p.fields.status?.statusCategory?.key,
        type: p.fields.issuetype?.name,
        dueDate: p.fields.duedate || null
      };
    } catch (e) {
      parent = { ...slimLinked(f.parent, base), description: '' };
    }
  }

  // Epics (and anything above them) are judged by their children, so load those too.
  let children = null;
  if ((f.issuetype?.hierarchyLevel || 0) >= 1) {
    try {
      children = await getChildren(raw.key, base);
    } catch (e) {
      children = { items: [], unavailable: `Child work items could not be read (${e.message}).` };
    }
  }

  return { issue, parent, links, subtasks, comments, ignoredBriefComments, children };
}

export function selectComments(rawComments = []) {
  const all = rawComments.map((c) => ({
    author: c.author?.displayName || 'Unknown',
    authorId: c.author?.accountId,
    created: c.created,
    text: adfToText(c.body).trim()
  }));
  const human = all.filter((c) => !isShipBriefComment(c.text));
  return { comments: human.slice(-MAX_COMMENTS), ignoredBriefComments: all.length - human.length };
}

// Enhanced JQL search (POST /rest/api/3/search/jql): returns { issues, nextPageToken }, no total.
export async function getChildren(parentKey, base) {
  const res = await api.asUser().requestJira(route`/rest/api/3/search/jql`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jql: `parent = "${parentKey}" ORDER BY created ASC`,
      maxResults: MAX_CHILDREN,
      fields: ['summary', 'status', 'issuetype', 'assignee', 'duedate', 'issuelinks']
    })
  });
  if (!res.ok) {
    const err = new Error(`Jira responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const items = (data.issues || []).map((i) => ({
    ...slimLinked(i, base),
    assignee: i.fields?.assignee?.displayName || null,
    dueDate: i.fields?.duedate || null,
    blockedBy: (i.fields?.issuelinks || [])
      .filter((l) => l.inwardIssue && /block/i.test(l.type?.name || '') && l.inwardIssue.fields?.status?.statusCategory?.key !== 'done')
      .map((l) => l.inwardIssue.key)
  }));
  return { items, truncated: Boolean(data.nextPageToken) };
}

// ---- Confluence -----------------------------------------------------------

const cqlEscape = (s) => s.replace(/["\\]/g, ' ');

export async function findRelatedDocs(issueKey, summary = '') {
  const items = new Map();
  const notes = [];

  // 1. Pages explicitly linked on the issue (remote links). Works without Confluence access.
  try {
    const remote = await jiraGet(route`/rest/api/3/issue/${issueKey}/remotelink`);
    for (const r of remote) {
      const url = safeUrl(r.object?.url);
      if (!url) continue;
      if (new URL(url).pathname.startsWith('/wiki/') || /confluence/i.test(r.application?.type || '')) {
        items.set(url, { title: r.object?.title || url, url, source: 'linked on issue' });
      }
    }
  } catch (e) {
    notes.push(`Issue links could not be read (${e.message}).`);
  }

  // Jira-only build: no Confluence scope, so only the linked pages are reported.
  if (!CONFLUENCE_SEARCH) {
    if (notes.length && items.size === 0) {
      return { items: [], unavailable: `Linked pages could not be checked. ${notes.join(' ')}`.trim() };
    }
    return { items: [...items.values()], notes, linkedOnly: true };
  }

  // 2. Pages that mention the key or match the summary.
  const words = cqlEscape(summary)
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6)
    .join(' ');
  const cql = `type = page AND (text ~ "\\"${cqlEscape(issueKey)}\\""${words ? ` OR title ~ "${words}"` : ''}) ORDER BY lastmodified DESC`;
  let searched = false;
  try {
    const res = await api.asUser().requestConfluence(route`/wiki/rest/api/search?cql=${cql}&limit=5`, {
      headers: { Accept: 'application/json' }
    });
    if (res.ok) {
      searched = true;
      const data = await res.json();
      const base = data._links?.base || '';
      for (const r of data.results || []) {
        const url = safeUrl(`${base}${r.url || r.content?._links?.webui || ''}`);
        if (url && !items.has(url)) {
          items.set(url, {
            title: r.title || r.content?.title,
            url,
            space: r.resultGlobalContainer?.title,
            lastModified: r.lastModified,
            excerpt: (r.excerpt || '').replace(/@@@(end)?hl@@@/g, '').slice(0, 200),
            source: 'search'
          });
        }
      }
    } else {
      notes.push(`Confluence search responded ${res.status}.`);
    }
  } catch (e) {
    notes.push('Confluence is not available to this app on this site.');
  }

  if (!searched && items.size === 0) {
    return { items: [], unavailable: `Confluence could not be searched. ${notes.join(' ')}`.trim() };
  }
  return { items: [...items.values()], notes };
}

// ---- Teamwork Graph -------------------------------------------------------

async function twg(name, id) {
  try {
    const query = TWG_QUERIES[name];
    const res = await api.asUser().requestTeamworkGraph(query, { id }, /query (\w+)/.exec(query)[1]);
    const body = await res.json();
    if (body.errors?.length) {
      console.warn('ShipBrief Teamwork Graph error', name, body.errors[0].message);
      return { items: [], unavailable: friendlyGraphError(body.errors[0].message) };
    }
    const field = Object.values(body.data || {})[0];
    return { items: (field?.edges || []).map((e) => e.node).filter(Boolean) };
  } catch (e) {
    console.warn('ShipBrief Teamwork Graph call failed', name, e.message);
    return { items: [], unavailable: friendlyGraphError(e.message) };
  }
}

// Fallback when the Teamwork Graph cannot be queried: Jira's own "development" field (the data behind the
// development panel). It only holds a cached summary (counts and overall state, no titles or links), but it is
// readable with read:jira-work on every site. The field id differs per site, so it is looked up by its type.
const DEV_FIELD_TYPE = 'com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf';
const devFieldIds = new Map();

async function getDevSummary(issueId, cloudId) {
  try {
    if (!devFieldIds.has(cloudId)) {
      const fields = await jiraGet(route`/rest/api/3/field`);
      devFieldIds.set(cloudId, fields.find((f) => f.schema?.custom === DEV_FIELD_TYPE)?.id || null);
    }
    const fieldId = devFieldIds.get(cloudId);
    if (!fieldId) return null;
    const raw = await jiraGet(route`/rest/api/3/issue/${issueId}?fields=${fieldId}`);
    return parseDevSummary(raw.fields?.[fieldId]);
  } catch (e) {
    console.warn('ShipBrief development summary fallback failed', e.message);
    return null;
  }
}

export async function getDeliveryStatus(issueId, cloudId) {
  if (!issueId) {
    const unavailable = 'The work item id is not known, so development data was not read.';
    return { pullRequests: { items: [], unavailable }, deployments: { items: [], unavailable }, goals: { items: [], unavailable } };
  }
  const noSite = { items: [], unavailable: 'The site id is not known in this context, so the Teamwork Graph was not queried.' };
  const ari = `ari:cloud:jira:${cloudId}:issue/${issueId}`;
  const [prs, deps, goals] = cloudId
    ? await Promise.all([twg('pullRequests', ari), twg('deployments', ari), twg('goals', ari)])
    : [noSite, noSite, noSite];

  const out = {
    pullRequests: {
      ...prs,
      source: 'teamwork-graph',
      items: prs.items.map((p) => ({ title: p.title || p.displayName, url: safeUrl(p.url), status: p.status, updatedAt: p.lastUpdatedAt }))
    },
    deployments: {
      ...deps,
      source: 'teamwork-graph',
      items: deps.items.map((d) => ({
        name: d.displayName,
        url: safeUrl(d.url),
        state: d.state,
        environment: d.environment?.displayName,
        environmentType: d.environment?.type,
        updatedAt: d.lastUpdatedAt
      }))
    },
    goals: {
      ...goals,
      items: goals.items.filter((g) => g.name && !g.archived).map((g) => ({ name: g.name, key: g.key, url: safeUrl(g.url), due: g.dueDateEndedAt }))
    }
  };

  if (prs.unavailable || deps.unavailable) {
    const dev = await getDevSummary(issueId, cloudId || 'site');
    if (dev) {
      const source = 'jira-development-summary';
      if (prs.unavailable) out.pullRequests = { items: [], source, summary: dev.pullRequests, graphNote: prs.unavailable };
      if (deps.unavailable) out.deployments = { items: [], source, summary: dev.deployments, graphNote: deps.unavailable };
      out.builds = { source, summary: dev.builds };
    }
  }
  return out;
}

export async function gatherAll(issueKey, { cloudId, siteUrl } = {}) {
  const ctx = await getIssueContext(issueKey, { siteUrl });
  const [docs, delivery] = await Promise.all([
    findRelatedDocs(ctx.issue.key, ctx.issue.summary),
    getDeliveryStatus(ctx.issue.id, cloudId)
  ]);
  return { ...ctx, docs, delivery };
}

// ---- Write back -----------------------------------------------------------

export async function postComment(issueKey, text) {
  const paragraphs = text.split('\n').map((line) => ({
    type: 'paragraph',
    content: line ? [{ type: 'text', text: line }] : []
  }));
  const res = await api.asUser().requestJira(route`/rest/api/3/issue/${issueKey}/comment`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { type: 'doc', version: 1, content: paragraphs } })
  });
  if (!res.ok) throw new Error(`Jira responded ${res.status} when posting the comment`);
  const data = await res.json();
  return { id: data.id };
}
