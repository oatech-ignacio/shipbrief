# ShipBrief

**Is it ready to ship?** ShipBrief gathers the context around a Jira work item (goal, linked work, comments, docs, pull requests, deployments) and turns it into one evidence-backed readiness brief. The same brief is available in three places:

- a **Jira issue panel** with Refresh and "Post as comment",
- a **Rovo agent** ("ShipBrief") that calls the same logic and explains it,
- an **MCP server** (`rovo:mcp`) so external MCP clients and coding agents can ask before they merge or deploy.

Built on Atlassian Forge for Codegeist 2026. No LLM API, no external egress, no storage: the app is eligible for Runs on Atlassian.

## What a brief contains

- A verdict (`READY`, `NEEDS_ATTENTION`, `NOT_READY`, `SHIPPED`) and a score out of 100.
- Up to 16 checks, each with its evidence: description, acceptance criteria, owner, goal context, blockers, subtasks, child work items of an epic, open questions, risks raised in comments, activity, due date, release date, test evidence, pull requests, builds, deployments, documentation.
- Decisions found in comments (with the author), open questions, a list of what is missing, and related Confluence pages.

Rules that keep it honest:

- The analysis is a pure function. The same data always gives the same verdict.
- Anything that cannot be read is reported as "could not be checked" and is left out of the score. It is never counted as good or bad.
- `READY` needs a score of 85 or more, no failed check and at most one warning. An epic is judged by its children.
- Every call runs as the current user, so a brief never shows data the user could not already see.

## Architecture

```
Jira REST v3 ─────────┐
Confluence search ────┼─> src/context.js ──> src/brief.js ──> issue panel   (src/frontend/index.jsx)
Teamwork Graph ───────┤    (gathers, as      (pure rules:     Rovo agent    (rovo:agent, 5 actions)
Jira development field┘     the user)         checks, score,  MCP server    (rovo:mcp, same 5 actions)
                                              verdict)
```

| File | Role |
|---|---|
| `manifest.yml` | Modules: `jira:issuePanel`, `rovo:agent`, `rovo:mcp`, five `action` modules, scopes. |
| `src/index.js` | Action handlers (shared by the Rovo agent and the MCP server) and the panel resolver. |
| `src/context.js` | All network access: Jira issue, parent, links, subtasks, comments, remote links, epic children (enhanced JQL search), Confluence search, Teamwork Graph, comment posting. |
| `src/twg-queries.js` | The three Teamwork Graph curated queries (`jiraWorkItemLinkedExternalPullRequests`, `jiraWorkItemLinkedExternalDeployments`, `jiraWorkItemGoals`). |
| `src/devinfo.js` | Pure helpers: parser for Jira's development field, friendly Teamwork Graph error text. |
| `src/brief.js` | Pure readiness engine: checks, score, verdict, comment classification, text rendering. |
| `src/frontend/index.jsx` | UI Kit issue panel. |
| `test/` | Unit tests (`node --test`), no network. |

### Actions / MCP tools

| Key | What it returns |
|---|---|
| `get-ship-readiness-brief` | The full brief for one work item. |
| `get-issue-context` | Raw context without scoring: fields, parent, links, subtasks, recent comments. |
| `find-related-docs` | Confluence pages linked on the issue or mentioning its key. |
| `get-delivery-status` | Pull requests, deployments and goals. |
| `post-brief-comment` | Posts the brief as a comment on the work item. |

Each takes an optional `issueKey`. In Rovo chat, when it is left empty the work item the user is viewing is used (`context.jira.issueKey`; the site id comes from `context.cloudId`).

### Pull requests and deployments: two sources

1. **Teamwork Graph** (preferred): titles, links and states of linked pull requests and deployments, and goals.
2. **Jira development summary** (fallback): if the graph refuses the query, ShipBrief reads the work item's `development` field through the Jira REST API. This is the cached summary behind Jira's development panel. It gives counts and an overall pull request state (open, merged, declined) and build results, but no titles or links and no per-deployment state. Checks that use it say so in their detail text, and deployment counts from it are shown but never scored.

### One-time Teamwork Graph consent

The Teamwork Graph may answer "User is not permitted to query this organization" even with all scopes granted. On our demo site this was a missing one-time consent, not an organization block: after the user opened the [Teamwork Graph query builder](https://teamwork-graph.atlassian.com/query-builder) once with the same account, went through its authorize redirect and picked the site, the same queries from ShipBrief started to work.

If the pull request and deployment rows say "The Teamwork Graph did not allow your account to query this organization":

1. Open https://teamwork-graph.atlassian.com/query-builder with the account you use in Jira.
2. Approve the authorization prompt and select your site.
3. Go back to the work item and press **Refresh** in the ShipBrief panel.

Until then ShipBrief uses the Jira development summary and says which source it used. We have only seen this on one site, so we do not know whether every user has to do it or once per organization is enough.

### ShipBrief ignores its own comments

A posted brief ends with the marker `[shipbrief-brief]`. Comments with that marker (and briefs posted by earlier versions, recognised by their first line) are removed before any analysis, in the panel, the Rovo actions and the MCP tools alike. Posting a brief therefore never changes the next brief.

## Install

Requirements: Node.js 22 or newer, the [Forge CLI](https://developer.atlassian.com/platform/forge/getting-started/), and an Atlassian site where you are an admin. Installing an app with Teamwork Graph scopes needs **organization admin** permission.

```bash
npm install
forge login                      # once
forge register                   # only if you want your own copy; writes a new app id into manifest.yml
npm test
forge lint
forge deploy -e development
forge install -e development --product jira --site <your-site>.atlassian.net
forge install -e development --product confluence --site <your-site>.atlassian.net   # optional
```

After a change to scopes, run `forge install --upgrade` for each product.

Then:

1. Open any Jira work item and click **ShipBrief** under the summary.
2. In Rovo chat, pick the **ShipBrief** agent and ask "Is ABC-123 ready to ship?".

Confluence is optional. Without it the documentation check uses only the pages linked on the issue, or reports "could not be checked".

## Jira-only Marketplace build

The Marketplace listing uses a separate Forge app generated from this repo, so that the main app keeps its installation link and the listing can be free (an app that needs both Jira and Confluence scopes can only be listed as paid).

```bash
node scripts/build-marketplace.mjs            # writes ../app-marketplace
cd ../app-marketplace && npm ci && npm test && forge lint && forge deploy -e production
```

The script copies `src`, `assets` and `test`, removes the `search:confluence` scope, sets the variant's app id, and writes `src/variant.js` with `CONFLUENCE_SEARCH = false`. In that build the documentation check and `find-related-docs` report only the Confluence pages linked on the work item; if the links cannot be read, the check is shown as "could not be checked". Set `SHIPBRIEF_MARKETPLACE_APP_ID` to build for your own registered copy.

## MCP server toggle

The `rovo:mcp` module exposes the five actions as MCP tools at

```
https://mcp.atlassian.com/forge/<app id>
```

where `<app id>` is the UUID at the end of `app.id` in `manifest.yml`.

- External access is **off by default**. An organization admin turns it on in Atlassian Administration → Rovo → MCP server settings, by allowing external access for ShipBrief.
- The endpoint accepts OAuth only. An MCP client connects to the URL, the user signs in and consents, and every tool call then runs as that user.
- Without authorization the endpoint answers 401 and points at the app's OAuth metadata.
- To remove the MCP surface entirely, delete the `rovo:mcp` block from `manifest.yml` and redeploy. The panel and the Rovo agent are not affected.

`rovo:mcp` is a Preview feature and may change.

## Scopes

| Scope | Why |
|---|---|
| `read:jira-work` | Read the work item, its parent, links, subtasks, comments, remote links, child work items, the development field and the field list. |
| `write:jira-work` | Post the brief as a comment. Used only by "Post as comment" and `post-brief-comment`. |
| `search:confluence` | Search Confluence for pages that mention the work item. Not present in the Jira-only Marketplace build. |
| `read:graph:issue:jira` | Starting point of every Teamwork Graph query. |
| `read:graph:pull-request:external` | Linked pull requests from connected development tools. |
| `read:graph:deployment:external` | Linked deployments. |
| `read:graph:goal:atlassian` | Goals connected to the work item. |

The app has no storage, no remote backend and no external fetch permissions.

## Limits

- **Language**: decisions, risks, questions, acceptance criteria and test notes are found with English keywords only.
- **Comments**: the 15 most recent comments (not counting ShipBrief's own) are analysed.
- **Epics**: the first 100 child work items are read.
- **Teamwork Graph**: Preview API. Curated queries return at most 25 items. A user may have to grant a one-time consent first (see above); while access is refused the Jira development summary is used instead, with less detail.
- **Jira development summary**: a cache maintained by Jira that can be stale, and it needs a development tool connected to Jira. The pull request shape was implemented from Jira's known format and unit-tested; on the demo site only build data was available to check it against.
- **Dates**: due-date and release-date checks depend on the day the brief is generated.
- **Related pages**: at most 5 search results, plus pages linked on the issue. Only `https` links are passed to the UI and the agent.
- **Rovo agent**: the model explains the brief; all facts come from the actions. It handles at most 5 work items per question.
- No per-project settings yet: check weights and the 14-day stale threshold are fixed.

## Development

```bash
npm test            # unit tests, no network
forge lint
forge tunnel        # local development against your site
forge logs -e development
```

Actions log the key names (never the values) of the payload they receive, which is useful when Atlassian changes the Rovo context shape.

## Demo data

`scripts/seed/` holds the script that created the demo data for the video. See `scripts/seed/README.md`.

## License

[MIT](LICENSE)
