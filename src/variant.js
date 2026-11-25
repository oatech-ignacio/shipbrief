// Build variant switch.
// The main app searches Confluence (scope search:confluence). The Jira-only Marketplace
// build (scripts/build-marketplace.mjs) rewrites this file with CONFLUENCE_SEARCH = false,
// so the documentation check uses only the pages linked on the work item.
export const CONFLUENCE_SEARCH = true;
