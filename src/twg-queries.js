// Teamwork Graph curated queries. Field names, type names and enum values were checked against the live
// schema on 2026-11-25. The gateway rejects operations whose name is not `[company]_[operation]`
// (company >= 3 chars, operation >= 4 chars), so every query is named shipbrief_<something>.
export const TWG_QUERIES = {
  pullRequests: `query shipbrief_pullRequests($id: ID!) {
    jiraWorkItemLinkedExternalPullRequests(id: $id, first: 25) {
      edges { node { __typename ... on ExternalPullRequest { id title displayName url status lastUpdatedAt } } }
    }
  }`,
  deployments: `query shipbrief_deployments($id: ID!) {
    jiraWorkItemLinkedExternalDeployments(id: $id, first: 25) {
      edges { node { __typename ... on ExternalDeployment { id displayName url state lastUpdatedAt environment { displayName type } } } }
    }
  }`,
  goals: `query shipbrief_goals($id: ID!) {
    jiraWorkItemGoals(id: $id, first: 10) {
      edges { node { __typename ... on AtlassianGoal { id name key url dueDateEndedAt archived } } }
    }
  }`
};
