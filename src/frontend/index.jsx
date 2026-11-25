import React, { useCallback, useEffect, useState } from 'react';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  Heading,
  Inline,
  Link,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Spinner,
  Stack,
  Text
} from '@forge/react';
import { invoke } from '@forge/bridge';

const VERDICT = {
  SHIPPED: { label: 'Shipped', appearance: 'success' },
  READY: { label: 'Ready to ship', appearance: 'success' },
  NEEDS_ATTENTION: { label: 'Needs attention', appearance: 'moved' },
  NOT_READY: { label: 'Not ready', appearance: 'removed' }
};

const STATUS = {
  pass: { label: 'OK', appearance: 'success' },
  warn: { label: 'Check', appearance: 'moved' },
  fail: { label: 'Risk', appearance: 'removed' },
  unknown: { label: 'No data', appearance: 'default' }
};

const Section = ({ title, children }) => (
  <Stack space="space.075">
    <Heading size="xsmall">{title}</Heading>
    {children}
  </Stack>
);

const CheckRow = ({ c }) => {
  const st = STATUS[c.status] || STATUS.unknown;
  return (
    <Inline space="space.100" alignBlock="start">
      <Box xcss={{ minWidth: '64px' }}>
        <Lozenge appearance={st.appearance}>{st.label}</Lozenge>
      </Box>
      <Text><Text as="strong">{c.label}.</Text> {c.detail}</Text>
    </Inline>
  );
};

const MaybeLink = ({ url, children }) => (url ? <Link href={url} openNewTab>{children}</Link> : <Text>{children}</Text>);

const App = () => {
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [posting, setPosting] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    setNotice(null);
    try {
      setBrief(await invoke('getBrief'));
    } catch (e) {
      // Keep the last good brief on screen; only flag that the refresh failed.
      setFailed(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const post = async () => {
    setPosting(true);
    try {
      const res = await invoke('postBrief');
      setNotice(res?.posted ? { ok: true, text: 'Brief posted as a comment. Reload the page to see it in the activity feed.' } : { ok: false, text: res?.error || 'Could not post the comment.' });
    } catch (e) {
      setNotice({ ok: false, text: 'Could not post the comment. Check that you can comment on this work item.' });
    }
    setPosting(false);
  };

  // First load: nothing to show yet.
  if (loading && !brief) {
    return (
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center">
          <Spinner size="small" label="Loading" />
          <Text>Gathering context from Jira, Confluence and the Teamwork Graph…</Text>
        </Inline>
        <Text size="small">Reading the work item, its parent, links, comments, related pages, pull requests and deployments.</Text>
      </Stack>
    );
  }

  // The resolver could not be reached at all (network, timeout).
  if (!brief) {
    return (
      <SectionMessage appearance="error" title="ShipBrief could not load">
        <Stack space="space.100">
          <Text>The request did not complete. Nothing was changed on this work item.</Text>
          <Inline><Button onClick={load}>Try again</Button></Inline>
        </Stack>
      </SectionMessage>
    );
  }

  // The resolver answered, but could not build a brief (not found, no permission, Jira error).
  if (brief.error) {
    return (
      <SectionMessage appearance="warning" title="No brief for this work item">
        <Stack space="space.100">
          <Text>{brief.error}</Text>
          <Inline><Button onClick={load} isDisabled={loading}>{loading ? 'Trying…' : 'Try again'}</Button></Inline>
        </Stack>
      </SectionMessage>
    );
  }

  const v = VERDICT[brief.verdict] || VERDICT.NEEDS_ATTENTION;
  const checks = brief.checks || [];
  const known = checks.filter((c) => c.status !== 'unknown');
  const unknown = checks.filter((c) => c.status === 'unknown');
  const sparse = (brief.missing || []).length >= 4;
  const openChildren = (brief.children || []).filter((c) => c.statusCategory !== 'done');

  return (
    <Stack space="space.200">
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center" spread="space-between">
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={v.appearance} isBold>{v.label}</Lozenge>
            <Text weight="bold">{brief.score}/100</Text>
          </Inline>
          <ButtonGroup>
            <Button onClick={load} isDisabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</Button>
            <Button onClick={post} isDisabled={posting || loading}>{posting ? 'Posting…' : 'Post as comment'}</Button>
          </ButtonGroup>
        </Inline>
        <ProgressBar value={brief.score / 100} appearance={brief.verdict === 'READY' || brief.verdict === 'SHIPPED' ? 'success' : 'default'} ariaLabel={`Readiness ${brief.score} of 100`} />
        <Text>{brief.headline}</Text>
      </Stack>

      {failed && (
        <SectionMessage appearance="warning">
          <Text>Refresh failed. Showing the brief from {new Date(brief.generatedAt).toLocaleTimeString()}.</Text>
        </SectionMessage>
      )}

      {sparse && (
        <SectionMessage appearance="information" title="Not much context yet">
          <Text>This work item has little to go on, so the brief is mostly a to-do list. Fill in the items under "Missing information" and refresh.</Text>
        </SectionMessage>
      )}

      {notice && (
        <SectionMessage appearance={notice.ok ? 'success' : 'error'}>
          <Text>{notice.text}</Text>
        </SectionMessage>
      )}

      <Section title="Checks">
        {known.map((c) => <CheckRow key={c.id} c={c} />)}
      </Section>

      {unknown.length > 0 && (
        <Section title="Could not be checked (not counted in the score)">
          {unknown.map((c) => <CheckRow key={c.id} c={c} />)}
        </Section>
      )}

      {brief.missing.length > 0 && (
        <Section title="Missing information">
          {brief.missing.map((m, i) => <Text key={i}>• {m}</Text>)}
        </Section>
      )}

      {(brief.goal || brief.goals.length > 0) && (
        <Section title="Why this matters">
          {brief.goal && (
            <Stack space="space.050">
              <MaybeLink url={brief.goal.url}>{brief.goal.key} · {brief.goal.summary} ({brief.goal.status})</MaybeLink>
              {brief.goal.description ? <Text>{brief.goal.description}</Text> : null}
            </Stack>
          )}
          {brief.goals.map((g, i) => <MaybeLink key={i} url={g.url}>Goal: {g.name}</MaybeLink>)}
        </Section>
      )}

      {brief.blockers.length > 0 && (
        <Section title="Blocked by">
          {brief.blockers.map((b) => <MaybeLink key={b.key} url={b.url}>{b.key} · {b.summary} ({b.status})</MaybeLink>)}
        </Section>
      )}

      {openChildren.length > 0 && (
        <Section title={`Open child work items (${openChildren.length})`}>
          {openChildren.slice(0, 10).map((c) => (
            <Inline key={c.key} space="space.100" alignBlock="center">
              <MaybeLink url={c.url}>{c.key} · {c.summary} ({c.status})</MaybeLink>
              {c.blockedBy?.length > 0 && <Lozenge appearance="removed">Blocked by {c.blockedBy.join(', ')}</Lozenge>}
            </Inline>
          ))}
          {openChildren.length > 10 && <Text size="small">and {openChildren.length - 10} more.</Text>}
        </Section>
      )}

      {brief.decisions.length > 0 && (
        <Section title="Decisions in comments">
          {brief.decisions.map((d, i) => <Text key={i}><Text as="strong">{d.author}:</Text> {d.text}</Text>)}
        </Section>
      )}

      {(brief.riskSignals || []).length > 0 && (
        <Section title="Risks raised in comments">
          {brief.riskSignals.map((d, i) => <Text key={i}><Text as="strong">{d.author}:</Text> {d.text}</Text>)}
        </Section>
      )}

      {brief.openQuestions.length > 0 && (
        <Section title="Open questions">
          {brief.openQuestions.map((q, i) => <Text key={i}><Text as="strong">{q.author}:</Text> {q.text}</Text>)}
        </Section>
      )}

      {(brief.pullRequests.length > 0 || brief.deployments.length > 0) && (
        <Section title="Delivery">
          {brief.pullRequests.map((p, i) => (
            <Inline key={`pr${i}`} space="space.100" alignBlock="center">
              <Lozenge>{p.status || 'PR'}</Lozenge>
              <MaybeLink url={p.url}>{p.title || 'Pull request'}</MaybeLink>
            </Inline>
          ))}
          {brief.deployments.map((d, i) => (
            <Inline key={`dep${i}`} space="space.100" alignBlock="center">
              <Lozenge>{d.state || 'DEPLOY'}</Lozenge>
              <MaybeLink url={d.url}>{d.name || 'Deployment'}{d.environment ? ` → ${d.environment}` : ''}</MaybeLink>
            </Inline>
          ))}
        </Section>
      )}

      {brief.docs.length > 0 && (
        <Section title="Related pages">
          {brief.docs.map((d, i) => <MaybeLink key={i} url={d.url}>{d.title}</MaybeLink>)}
        </Section>
      )}

      <Text size="small">Checked {new Date(brief.generatedAt).toLocaleString()}. Rule-based, no AI: the same result every time for the same data. Ask the ShipBrief agent in Rovo for a narrative summary.</Text>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
