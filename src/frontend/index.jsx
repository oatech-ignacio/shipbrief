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

const MaybeLink = ({ url, children }) => (url ? <Link href={url} openNewTab>{children}</Link> : <Text>{children}</Text>);

const App = () => {
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState(false);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      setBrief(await invoke('getBrief'));
    } catch (e) {
      setBrief({ error: 'ShipBrief could not load. Try again.' });
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
      setNotice(res?.posted ? { ok: true, text: 'Brief posted as a comment.' } : { ok: false, text: res?.error || 'Could not post the comment.' });
    } catch (e) {
      setNotice({ ok: false, text: 'Could not post the comment.' });
    }
    setPosting(false);
  };

  if (loading) {
    return (
      <Inline space="space.100" alignBlock="center">
        <Spinner size="small" />
        <Text>Gathering context…</Text>
      </Inline>
    );
  }

  if (!brief || brief.error) {
    return (
      <SectionMessage appearance="warning" title="No brief available">
        <Text>{brief?.error || 'Something went wrong.'}</Text>
        <Button onClick={load}>Try again</Button>
      </SectionMessage>
    );
  }

  const v = VERDICT[brief.verdict] || VERDICT.NEEDS_ATTENTION;

  return (
    <Stack space="space.200">
      <Stack space="space.100">
        <Inline space="space.100" alignBlock="center" spread="space-between">
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={v.appearance} isBold>{v.label}</Lozenge>
            <Text weight="bold">{brief.score}/100</Text>
          </Inline>
          <ButtonGroup>
            <Button onClick={load}>Refresh</Button>
            <Button onClick={post} isDisabled={posting}>{posting ? 'Posting…' : 'Post as comment'}</Button>
          </ButtonGroup>
        </Inline>
        <ProgressBar value={brief.score / 100} appearance={brief.verdict === 'READY' || brief.verdict === 'SHIPPED' ? 'success' : 'default'} ariaLabel={`Readiness ${brief.score} of 100`} />
        <Text>{brief.headline}</Text>
      </Stack>

      {notice && (
        <SectionMessage appearance={notice.ok ? 'success' : 'error'}>
          <Text>{notice.text}</Text>
        </SectionMessage>
      )}

      <Section title="Checks">
        {brief.checks.map((c) => (
          <Inline key={c.id} space="space.100" alignBlock="start">
            <Box xcss={{ minWidth: '64px' }}>
              <Lozenge appearance={STATUS[c.status].appearance}>{STATUS[c.status].label}</Lozenge>
            </Box>
            <Text><Text as="strong">{c.label}.</Text> {c.detail}</Text>
          </Inline>
        ))}
      </Section>

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

      {brief.decisions.length > 0 && (
        <Section title="Decisions in comments">
          {brief.decisions.map((d, i) => <Text key={i}><Text as="strong">{d.author}:</Text> {d.text}</Text>)}
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

      <Text size="small">{brief.confidence} Ask the ShipBrief agent in Rovo for a narrative summary.</Text>
    </Stack>
  );
};

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
