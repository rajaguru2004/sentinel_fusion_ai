'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Radar, ShieldAlert, KeyRound, Network, Play } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, RiskBadge, type RiskLevel as BadgeLevel } from '@/components/ui/Badge';
import { PageHeader } from '@/components/PageHeader';
import { VerdictCard } from '@/components/sentinel/VerdictCard';
import { api, apiError } from '@/lib/api';
import {
  COMMAND_CENTER_EVENTS,
  DOMAIN_CONTRIBUTION,
  INTRUSION_PRESETS,
  QUANTUM_PRESETS,
  type Preset,
  type ScoreOut,
} from '@/lib/sentinel';

type Tab = 'intrusion' | 'quantum' | 'command';

const TABS: { id: Tab; label: string; icon: typeof Radar }[] = [
  { id: 'intrusion', label: 'Intrusion Watcher', icon: Network },
  { id: 'quantum', label: 'Future-Proofing Watcher', icon: KeyRound },
  { id: 'command', label: 'Command Center', icon: Radar },
];

/** Fields the console lets you edit, per domain. Everything else rides along unchanged. */
const EDITABLE: Record<'cyber' | 'quantum', { key: string; label: string; type: 'number' | 'text' }[]> = {
  cyber: [
    { key: 'user_id', label: 'Host', type: 'text' },
    { key: 'bytes_in', label: 'Bytes in', type: 'number' },
    { key: 'bytes_out', label: 'Bytes out', type: 'number' },
    { key: 'src_port', label: 'Source port', type: 'number' },
    { key: 'dst_port', label: 'Destination port', type: 'number' },
    { key: 'protocol', label: 'Protocol', type: 'text' },
    { key: 'duration_s', label: 'Duration (s)', type: 'number' },
  ],
  quantum: [
    { key: 'user_id', label: 'Service', type: 'text' },
    { key: 'q_key_exchange', label: 'Key exchange', type: 'text' },
    { key: 'q_cert_key_type', label: 'Certificate key type', type: 'text' },
    { key: 'q_data_class', label: 'Data classification', type: 'text' },
    { key: 'q_cert_age_days', label: 'Certificate age (days)', type: 'number' },
    { key: 'q_cert_validity_days', label: 'Certificate validity (days)', type: 'number' },
  ],
};

function EventForm({
  domain,
  presets,
  helper,
}: {
  domain: 'cyber' | 'quantum';
  presets: Preset[];
  helper: string;
}) {
  const [presetId, setPresetId] = useState(presets[0].id);
  const [event, setEvent] = useState<Record<string, unknown>>(() => presets[0].build());
  const [result, setResult] = useState<ScoreOut | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preset = presets.find((p) => p.id === presetId)!;

  const applyPreset = (id: string): void => {
    const next = presets.find((p) => p.id === id);
    if (!next) return;
    setPresetId(id);
    setEvent(next.build());
    setResult(null);
    setError(null);
  };

  const send = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // Rebuild the id/time on every send so the model's event_id idempotency
      // guard doesn't collapse repeated demo sends into one logical event.
      const body = { ...event, event_id: `${domain}-${Date.now().toString(36)}`, event_time: new Date().toISOString() };
      const { data } = await api.post<ScoreOut>('/sentinel/score', body);
      setResult(data);
    } catch (err) {
      setError(apiError(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-text-muted">{helper}</p>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`preset-${domain}`} className="text-sm font-medium text-text">
          Scenario
        </label>
        <select
          id={`preset-${domain}`}
          value={presetId}
          onChange={(e) => applyPreset(e.target.value)}
          className="h-10 w-full rounded-[var(--radius-input)] border border-border bg-surface px-3 text-sm text-text focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-text-muted">{preset.note}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {EDITABLE[domain].map((f) => (
          <div key={f.key} className="flex flex-col gap-1.5">
            <label htmlFor={`${domain}-${f.key}`} className="text-sm font-medium text-text">
              {f.label}
            </label>
            <input
              id={`${domain}-${f.key}`}
              type={f.type}
              value={String(event[f.key] ?? '')}
              onChange={(e) =>
                setEvent((prev) => ({
                  ...prev,
                  [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value,
                }))
              }
              className="h-10 w-full rounded-[var(--radius-input)] border border-border bg-surface px-3 text-sm text-text focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
        ))}
      </div>

      <Button onClick={send} disabled={busy} data-testid={`send-${domain}`}>
        <Play className="h-4 w-4" />
        {busy ? 'Scoring…' : 'Send event to the model'}
      </Button>

      {error && (
        <div className="rounded-[var(--radius-input)] border border-risk-critical/30 bg-risk-critical/10 p-4 text-sm text-risk-critical">
          {error}
        </div>
      )}

      {result && (
        <div data-testid={`verdict-${domain}`}>
          <VerdictCard result={result} />
        </div>
      )}
    </div>
  );
}

function CommandCenterTab() {
  const [results, setResults] = useState<Record<string, ScoreOut | { error: string }>>({});
  const [busy, setBusy] = useState(false);

  const { data: metrics } = useQuery<{
    rows: { model: string; riskLevel: string; count: number }[];
    total: number;
  }>({
    queryKey: ['sentinel-metrics'],
    queryFn: async () => (await api.get('/sentinel/metrics')).data,
    refetchInterval: 4000,
  });

  const runAll = async (): Promise<void> => {
    setBusy(true);
    setResults({});
    for (const ev of COMMAND_CENTER_EVENTS) {
      try {
        const { data } = await api.post<ScoreOut>('/sentinel/score', ev.build());
        setResults((prev) => ({ ...prev, [ev.key]: data }));
      } catch (err) {
        setResults((prev) => ({ ...prev, [ev.key]: { error: apiError(err) } }));
      }
    }
    setBusy(false);
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted">
        One event per domain, fired in sequence. The point is the <strong>routing</strong>: for each
        event exactly one watcher contributes a probability and the rest stay null. The Command
        Center calibrates each head (isotonic regression) so the numbers are comparable, then fuses
        them with a weighted noisy-OR — one loud alarm escalates on its own, and several quiet
        worries also add up.
      </p>

      <Button onClick={runAll} disabled={busy} data-testid="send-command-center">
        <Play className="h-4 w-4" />
        {busy ? 'Running all four…' : 'Fire one event at each watcher'}
      </Button>

      <div className="grid gap-4 lg:grid-cols-2">
        {COMMAND_CENTER_EVENTS.map((ev) => {
          const r = results[ev.key];
          const expected = DOMAIN_CONTRIBUTION[ev.key];
          return (
            <Card key={ev.key} title={ev.label}>
              {!r && <p className="text-sm text-text-muted">Not run yet.</p>}
              {r && 'error' in r && <p className="text-sm text-risk-critical">{r.error}</p>}
              {r && !('error' in r) && (
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <RiskBadge level={r.risk_level.toUpperCase() as BadgeLevel} />
                    <span className="text-lg font-semibold text-text">{r.risk_score.toFixed(4)}</span>
                    <span className="text-xs text-text-muted">{r.model ?? 'unscored'}</span>
                  </div>
                  <p className="text-xs text-text-muted">
                    Fired: <span className="font-medium text-text">{expected}</span> ={' '}
                    {typeof r.contributions[expected] === 'number'
                      ? (r.contributions[expected] as number).toFixed(4)
                      : '—'}
                  </p>
                  {r.explanation?.reasons?.length ? (
                    <ul className="list-inside list-disc space-y-0.5 text-xs text-text-muted">
                      {r.explanation.reasons.slice(0, 3).map((x) => (
                        <li key={x}>{x}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <Card title="Live scoring counter (from the model's own /metrics)">
        <p className="mb-3 text-sm text-text-muted">
          <code className="text-xs">sentinel_scored_total</code> is incremented inside the model&apos;s
          scoring path, so it is proof the models are really being called — the UI cannot fake it.
        </p>
        {!metrics?.rows.length ? (
          <p className="text-sm text-text-muted">No scores recorded yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {metrics.rows.map((row) => (
              <Badge key={`${row.model}-${row.riskLevel}`} tone="info">
                {row.model} · {row.riskLevel} · {row.count}
              </Badge>
            ))}
            <Badge tone="neutral">total {metrics.total}</Badge>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function SentinelConsolePage() {
  const [tab, setTab] = useState<Tab>('intrusion');

  const { data: ready } = useQuery<{ ready: boolean; model_version: string; store_breaker: string }>({
    queryKey: ['sentinel-ready'],
    queryFn: async () => (await api.get('/sentinel/ready')).data,
    refetchInterval: 10_000,
    retry: false,
  });

  return (
    <div>
      <PageHeader
        title="Sentinel Console"
        description="The two watchers that have no banking surface — plus the Command Center that fuses all four."
        actions={
          ready ? (
            <Badge tone={ready.ready ? 'success' : 'danger'}>
              model {ready.ready ? 'ready' : 'not ready'} · v{ready.model_version}
            </Badge>
          ) : (
            <Badge tone="danger">model unreachable</Badge>
          )
        }
      />

      <div className="mb-6 flex flex-wrap gap-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              data-testid={`tab-${t.id}`}
              className={
                active
                  ? 'inline-flex items-center gap-2 rounded-[var(--radius-input)] border border-accent bg-accent/10 px-4 py-2 text-sm font-medium text-accent'
                  : 'inline-flex items-center gap-2 rounded-[var(--radius-input)] border border-border bg-surface px-4 py-2 text-sm font-medium text-text-muted hover:text-text'
              }
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      <Card>
        {tab === 'intrusion' && (
          <EventForm
            domain="cyber"
            presets={INTRUSION_PRESETS}
            helper="A bank emits no raw network traffic, so this watcher has no banking screen. Here you send it a network event directly and see the verdict come back."
          />
        )}
        {tab === 'quantum' && (
          <EventForm
            domain="quantum"
            presets={QUANTUM_PRESETS}
            helper="This watcher inspects the locks on your secrets, not transactions. Send it a certificate inventory record and see how exposed that service is to harvest-now-decrypt-later."
          />
        )}
        {tab === 'command' && <CommandCenterTab />}
      </Card>

      {tab === 'intrusion' && (
        <div className="mt-4 flex items-start gap-3 rounded-[var(--radius-card)] border border-risk-medium/30 bg-risk-medium/10 p-4">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-risk-medium" />
          <p className="text-xs text-risk-medium">
            <strong>Known limitation, stated honestly.</strong> The current <code>cyber</code> bundle
            returns <code>critical</code> for effectively every single event we have tried, including
            ordinary HTTPS on port 443 — measured with a fully warmed feature store. Its fitted
            critical threshold is 0.1837 and benign traffic scores ~0.996. Treat this tab as
            &ldquo;the watcher is wired and answering&rdquo;, not as evidence of discrimination.
            The Future-Proofing tab has a contrast that genuinely works.
          </p>
        </div>
      )}
    </div>
  );
}
