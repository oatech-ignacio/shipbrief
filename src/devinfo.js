// Pure helpers for development data that does not come from the Teamwork Graph. No network.

// Turns a raw Teamwork Graph error into a sentence a Jira user can act on.
export function friendlyGraphError(message = '') {
  if (/not permitted to query this organi[sz]ation/i.test(message)) {
    return 'The Teamwork Graph did not allow your account to query this organization, so linked pull requests, deployments and goals could not be read from it.';
  }
  if (/scope|unauthori[sz]ed|forbidden|permission|not permitted/i.test(message)) {
    return 'The Teamwork Graph refused this request (missing permission or app scope).';
  }
  return `The Teamwork Graph could not be read (${String(message).slice(0, 140) || 'no details'}).`;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// Jira's "development" custom field is a string such as
//   {pullrequest={dataType=pullrequest, state=MERGED, stateCount=1}, json={"cachedValue":{"errors":[],"summary":{...}},"isStale":true}}
// or "{}" when nothing is linked. Returns null when the value cannot be understood (never guesses).
export function parseDevSummary(value) {
  if (value == null) return null;
  const text = String(value).trim();
  const empty = {
    pullRequests: { count: 0 },
    deployments: { count: 0, environments: [] },
    builds: { count: 0, failed: 0, successful: 0 },
    stale: false
  };
  if (text === '' || text === '{}') return empty;
  const at = text.indexOf('json=');
  if (at < 0) return null;
  let data;
  try {
    data = JSON.parse(text.slice(at + 5, text.lastIndexOf('}')));
  } catch (e) {
    return null;
  }
  const summary = data?.cachedValue?.summary;
  if (!summary || typeof summary !== 'object') return null;
  const pr = summary.pullrequest?.overall || {};
  const build = summary.build?.overall || {};
  const dep = (summary['deployment-environment'] || summary.deploymentEnvironment || summary.deployment)?.overall || {};
  return {
    pullRequests: {
      count: num(pr.count),
      // OPEN | MERGED | DECLINED: the state Jira shows on the development panel for all linked pull requests together.
      state: typeof pr.state === 'string' ? pr.state.toUpperCase() : undefined,
      lastUpdated: pr.lastUpdated || undefined
    },
    deployments: {
      count: num(dep.count),
      successful: dep.successfulCount == null ? undefined : num(dep.successfulCount),
      environments: (Array.isArray(dep.topEnvironments) ? dep.topEnvironments : [])
        .map((e) => (typeof e === 'string' ? e : e?.title || e?.name))
        .filter((e) => typeof e === 'string')
        .slice(0, 5)
    },
    builds: { count: num(build.count), failed: num(build.failedBuildCount), successful: num(build.successfulBuildCount) },
    stale: Boolean(data.isStale)
  };
}
