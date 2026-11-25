# Demo data seed

`seed.mjs` creates the demo data used in the ShipBrief video: one epic, eight work items, three subtasks, a fix version, issue links, comments, a Confluence space `TDEV` with three pages, and remote links.

It was written for one demo site and is included for reference. Before running it elsewhere, check:

- It expects an existing, empty Jira software project with key `TD`.
- Status names in the script are the zh-TW names of that site (`進行中`, `測試中`, `完成`). Change them to your site's status names.
- Assignees are picked by position from the project's assignable users.

Run (Node.js 22+). Credentials are read from the environment only:

```bash
export SHIPBRIEF_SITE=https://<your-site>.atlassian.net
export FORGE_EMAIL=<your Atlassian account email>
export FORGE_API_TOKEN=<an Atlassian API token>
node scripts/seed/seed.mjs
```

The script is idempotent: it records what it created in `scripts/seed/state.json` (git-ignored) and skips those on the next run. Everything it creates in Jira carries the label `shipbrief-demo`.
