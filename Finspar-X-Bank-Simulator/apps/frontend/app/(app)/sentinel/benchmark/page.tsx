'use client';

import { useState } from 'react';
import { Activity, Braces, CheckCircle2, Gauge, Layers, Loader2, Play, TrendingDown, Wand2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, RiskBadge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import { featureLabel } from '@/lib/reasons';
import {
  BATCH_SIZES,
  CF_SCENARIOS,
  applyCounterfactual,
  buildBatch,
  levelCounts,
  type BatchResult,
  type BatchSize,
  type CfScenario,
  type Counterfactual,
  type CounterfactualResult,
  type ScoreRow,
  type TimedEnvelope,
} from '@/lib/benchmark';
import type { ScoreOut } from '@/lib/sentinel';

type Level = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
const toBadge = (l: string): Level => l.toUpperCase() as Level;

/**
 * Per-tab run state.
 *
 * Held in the PAGE, not inside each tab component, so a finished run survives
 * switching tabs — you can start a batch, read the counterfactual tab while it
 * works, and come back to the completed result. Unmounting the inactive tab
 * would throw that away, which is the one behaviour this screen must not have.
 */
interface RunState<T> {
  status: 'idle' | 'running' | 'done' | 'error';
  result: T | null;
  error: string | null;
  /** Wall time measured in the backend proxy — the model round trip. */
  timing: TimedEnvelope<unknown>['timing'] | null;
  label: string | null;
}

const idle = <T,>(): RunState<T> => ({ status: 'idle', result: null, error: null, timing: null, label: null });

/** Outcome of applying one recommendation and re-scoring it for real. */
export interface ApplyState {
  status: 'running' | 'done' | 'error';
  score: ScoreOut | null;
  changed: string[];
  derived: string[];
  /** False when the run deliberately skipped the dependent-field fix-ups. */
  consistent: boolean;
  error: string | null;
}

export default function BenchmarkPage() {
  const [tab, setTab] = useState<'counterfactual' | 'batch'>('batch');
  const [cf, setCf] = useState<RunState<CounterfactualResult>>(idle);
  const [batch, setBatch] = useState<RunState<BatchResult>>(idle);

  // The EXACT event that was analysed. scenario.build() stamps a fresh event_id
  // on every call, so rebuilding it at apply time would re-score a different
  // event than the one the recommendations describe.
  const [cfEvent, setCfEvent] = useState<Record<string, unknown> | null>(null);
  const [applied, setApplied] = useState<Record<number, ApplyState>>({});

  async function runCounterfactual(scenario: CfScenario): Promise<void> {
    setCf({ status: 'running', result: null, error: null, timing: null, label: scenario.label });
    setApplied({}); // previous scenario's applied results no longer relate to what is on screen
    const event = scenario.build();
    setCfEvent(event);
    try {
      const { data } = await api.post<TimedEnvelope<CounterfactualResult>>('/sentinel/counterfactual', {
        event,
        target_risk_level: scenario.targetRiskLevel,
        max_recommendations: 3,
      });
      setCf({ status: 'done', result: data.data, error: null, timing: data.timing, label: scenario.label });
    } catch (e) {
      setCf({ status: 'error', result: null, error: apiError(e), timing: null, label: scenario.label });
    }
  }

  /** Apply one recommendation to the analysed event and re-score it for real. */
  async function applyRecommendation(c: Counterfactual, deriveDependents: boolean): Promise<void> {
    if (!cfEvent) return;
    const { event, changed, derived } = applyCounterfactual(cfEvent, c, { deriveDependents });
    setApplied((prev) => ({
      ...prev,
      [c.rank]: { status: 'running', score: null, changed, derived, consistent: deriveDependents, error: null },
    }));
    try {
      const { data } = await api.post<ScoreOut>('/sentinel/score', event);
      setApplied((prev) => ({
        ...prev,
        [c.rank]: { status: 'done', score: data, changed, derived, consistent: deriveDependents, error: null },
      }));
    } catch (e) {
      setApplied((prev) => ({
        ...prev,
        [c.rank]: { status: 'error', score: null, changed, derived, consistent: deriveDependents, error: apiError(e) },
      }));
    }
  }

  async function runBatch(size: BatchSize): Promise<void> {
    setBatch({ status: 'running', result: null, error: null, timing: null, label: `${size} events` });
    try {
      const { data } = await api.post<TimedEnvelope<BatchResult>>('/sentinel/batch', {
        events: buildBatch(size),
      });
      setBatch({ status: 'done', result: data.data, error: null, timing: data.timing, label: `${size} events` });
    } catch (e) {
      setBatch({ status: 'error', result: null, error: apiError(e), timing: null, label: `${size} events` });
    }
  }

  const busy = cf.status === 'running' || batch.status === 'running';

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Model Benchmark"
        description="Two questions about the same engine: how deeply can it explain one decision, and how fast can it make many."
      />

      {/* Tabs. Both panels stay mounted — see RunState above. */}
      <div className="mb-4 flex gap-1 rounded-[var(--radius-card)] border border-border bg-surface p-1">
        <TabButton
          active={tab === 'batch'}
          onClick={() => setTab('batch')}
          icon={<Layers className="h-4 w-4" />}
          label="Batch throughput"
          state={batch.status}
        />
        <TabButton
          active={tab === 'counterfactual'}
          onClick={() => setTab('counterfactual')}
          icon={<TrendingDown className="h-4 w-4" />}
          label="Counterfactual analysis"
          state={cf.status}
        />
      </div>

      <div className={tab === 'batch' ? '' : 'hidden'}>
        <BatchTab state={batch} busy={busy} onRun={runBatch} />
      </div>
      <div className={tab === 'counterfactual' ? '' : 'hidden'}>
        <CounterfactualTab
          state={cf}
          busy={busy}
          onRun={runCounterfactual}
          applied={applied}
          onApply={applyRecommendation}
        />
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
  state,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  state: RunState<unknown>['status'];
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 items-center justify-center gap-2 rounded-[var(--radius-input)] px-3 py-2 text-sm font-medium transition-colors ${
        active ? 'bg-primary text-white' : 'text-text-muted hover:bg-bg hover:text-text'
      }`}
    >
      {icon}
      {label}
      {/* Status dot on the INACTIVE tab is the point of the whole layout: a run
          that finishes while you are looking elsewhere announces itself. */}
      {state === 'running' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {state === 'done' && !active && <CheckCircle2 className="h-3.5 w-3.5 text-risk-low" />}
      {state === 'error' && !active && <span className="h-2 w-2 rounded-full bg-risk-critical" />}
    </button>
  );
}

// ------------------------------------------------------------------ batch tab

function BatchTab({
  state,
  busy,
  onRun,
}: {
  state: RunState<BatchResult>;
  busy: boolean;
  onRun: (size: BatchSize) => void;
}) {
  const rows = state.result?.results ?? [];
  const counts = levelCounts(rows);

  return (
    <div className="space-y-4">
      <Card title="Scale — how many events per second">
        <p className="mb-3 text-sm text-text-muted">
          Submits one <code className="text-xs">POST /score/batch</code> call. Events are spread across 50
          users with varied amounts and countries — cloning one event N times would let the feature store
          answer from a single warm entity and make the number meaningless.
        </p>
        <div className="flex flex-wrap gap-2">
          {BATCH_SIZES.map((n) => (
            <Button key={n} size="sm" disabled={busy} onClick={() => onRun(n)}>
              {state.status === 'running' && state.label === `${n} events` ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              {n} events
            </Button>
          ))}
        </div>
        {/* /score/batch is one-shot, not streaming — there is no honest progress
            fraction to show, so this stays indeterminate rather than faking one. */}
        {state.status === 'running' && (
          <p className="mt-3 flex items-center gap-2 text-sm text-text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Scoring {state.label} — one round trip, no partial
            results until it returns.
          </p>
        )}
      </Card>

      {state.status === 'error' && <ErrorCard message={state.error} />}

      {state.status === 'done' && state.timing && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat icon={<Gauge className="h-5 w-5 text-accent" />} label="Events / second" value={state.timing.perSecond.toLocaleString()} />
            <Stat icon={<Activity className="h-5 w-5 text-risk-low" />} label="Total wall time" value={`${state.timing.elapsedMs} ms`} />
            <Stat icon={<Braces className="h-5 w-5 text-text-muted" />} label="Per event" value={`${state.timing.msPerEvent} ms`} />
            <Stat icon={<Layers className="h-5 w-5 text-primary" />} label="Events scored" value={String(state.timing.count)} />
          </div>

          <p className="text-xs text-text-muted">
            Measured {state.timing.measuredAt} — the browser hop and JSON rendering are excluded, so this
            reflects the model rather than the network to your laptop.
          </p>

          <Card title="Risk distribution across the batch">
            <div className="flex h-6 w-full overflow-hidden rounded-full">
              {(['low', 'medium', 'high', 'critical'] as const).map((lvl) =>
                counts[lvl] ? (
                  <div
                    key={lvl}
                    title={`${lvl}: ${counts[lvl]}`}
                    style={{ width: `${(counts[lvl] / rows.length) * 100}%` }}
                    className={
                      lvl === 'critical'
                        ? 'bg-risk-critical'
                        : lvl === 'high'
                          ? 'bg-risk-high'
                          : lvl === 'medium'
                            ? 'bg-risk-medium'
                            : 'bg-risk-low'
                    }
                  />
                ) : null,
              )}
            </div>
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              {(['low', 'medium', 'high', 'critical'] as const).map((lvl) => (
                <span key={lvl} className="flex items-center gap-1.5">
                  <RiskBadge level={toBadge(lvl)} />
                  <span className="tabular text-text">{counts[lvl]}</span>
                </span>
              ))}
            </div>
          </Card>

          <Card title={`Sample of scored events (first 10 of ${rows.length})`}>
            <div className="space-y-1">
              {rows.slice(0, 10).map((r: ScoreRow) => (
                <div
                  key={r.event_id}
                  className="flex flex-wrap items-center gap-2 rounded-[var(--radius-input)] border border-border px-2.5 py-1.5 text-xs"
                >
                  <RiskBadge level={toBadge(r.risk_level)} />
                  <span className="font-mono text-text">{r.risk_score.toFixed(4)}</span>
                  <span className="text-text-muted">{r.model ?? 'unscored'}</span>
                  <span className="ml-auto font-mono text-text-muted">{r.event_id}</span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

// --------------------------------------------------------- counterfactual tab

function CounterfactualTab({
  state,
  busy,
  onRun,
  applied,
  onApply,
}: {
  state: RunState<CounterfactualResult>;
  busy: boolean;
  onRun: (s: CfScenario) => void;
  applied: Record<number, ApplyState>;
  onApply: (c: Counterfactual, deriveDependents: boolean) => void;
}) {
  const r = state.result;

  return (
    <div className="space-y-4">
      <Card title="Depth — what would have made this acceptable">
        <p className="mb-3 text-sm text-text-muted">
          Each run probes the model&apos;s decision boundary: a SHAP explain, then a re-score of every
          candidate scenario. Expect single digits per second — that cost is the feature, not a
          shortcoming. This is the opposite trade from the batch tab.
        </p>
        <div className="space-y-2">
          {CF_SCENARIOS.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-start gap-3 rounded-[var(--radius-input)] border border-border p-3"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-text">{s.label}</p>
                <p className="mt-0.5 text-xs text-text-muted">{s.note}</p>
                <Badge>target: {s.targetRiskLevel}</Badge>
              </div>
              <Button size="sm" disabled={busy} onClick={() => onRun(s)}>
                {state.status === 'running' && state.label === s.label ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Analyse
              </Button>
            </div>
          ))}
        </div>
      </Card>

      {state.status === 'error' && <ErrorCard message={state.error} />}

      {state.status === 'done' && r && (
        <>
          <Card title="Verdict before and after">
            <div className="flex flex-wrap items-center gap-4">
              <div>
                <p className="text-xs text-text-muted">As submitted</p>
                <div className="mt-1 flex items-center gap-2">
                  <RiskBadge level={toBadge(r.original_risk_level)} />
                  <span className="text-xl font-semibold text-text">
                    {r.original_risk_score.toFixed(4)}
                  </span>
                </div>
              </div>
              <TrendingDown className="h-5 w-5 text-text-muted" />
              <div>
                <p className="text-xs text-text-muted">Best achievable ({r.target_risk_level} target)</p>
                <div className="mt-1 flex items-center gap-2">
                  {r.counterfactuals.length ? (
                    <>
                      <RiskBadge level={toBadge(r.counterfactuals[0].predicted_risk_level)} />
                      <span className="text-xl font-semibold text-text">
                        {r.counterfactuals[0].predicted_risk_score.toFixed(4)}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-text-muted">no qualifying change found</span>
                  )}
                </div>
              </div>
              <div className="ml-auto text-right">
                <p className="text-xs text-text-muted">model</p>
                <p className="text-sm font-medium text-text">{r.model ?? '—'}</p>
                {state.timing && (
                  <p className="mt-0.5 text-xs text-text-muted">{state.timing.elapsedMs} ms</p>
                )}
              </div>
            </div>
          </Card>

          {r.counterfactuals.length === 0 ? (
            <Card title="No recommendation">
              <p className="text-sm text-text-muted">
                The model found no single change that brings this event to {r.target_risk_level}. That is a
                real answer, not a failure — some events are risky on every mutable dimension at once.
              </p>
            </Card>
          ) : (
            r.counterfactuals.map((c) => (
              <Card
                key={c.rank}
                title={`Recommendation ${c.rank}`}
                actions={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={applied[c.rank]?.status === 'running'}
                    onClick={() => onApply(c, false)}
                  >
                    {applied[c.rank]?.status === 'running' ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Wand2 className="h-4 w-4" />
                    )}
                    {applied[c.rank] ? 'Re-apply' : 'Apply'}
                  </Button>
                }
              >
                <div className="mb-3 flex flex-wrap gap-3 text-xs">
                  <Meter label="Risk reduction" value={`${c.risk_reduction_pct}%`} />
                  <Meter label="Confidence" value={c.confidence.toFixed(2)} />
                  <Meter label="Actionability" value={c.actionability_score.toFixed(2)} />
                  <Meter label="Predicted score" value={c.predicted_risk_score.toFixed(4)} />
                </div>

                <div className="space-y-2">
                  {c.changes.map((ch) => (
                    <div
                      key={ch.feature}
                      className="rounded-[var(--radius-input)] border border-border bg-surface p-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="font-medium text-text">{featureLabel(ch.feature)}</span>
                        <span className="font-mono text-text-muted">{String(ch.original_value)}</span>
                        <span className="text-text-muted">→</span>
                        <span className="font-mono text-risk-low">{String(ch.recommended_value)}</span>
                        {ch.unit && <Badge>{ch.unit}</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-text-muted">{ch.change_description}</p>
                    </div>
                  ))}
                </div>

                <p className="mt-2 text-xs leading-relaxed text-text-muted">{c.explanation}</p>

                {applied[c.rank] && (
                  <AppliedResult
                    apply={applied[c.rank]}
                    cf={c}
                    originalScore={r.original_risk_score}
                    targetLevel={r.target_risk_level}
                    onRerun={(derive) => onApply(c, derive)}
                  />
                )}
              </Card>
            ))
          )}
        </>
      )}
    </div>
  );
}

/**
 * What actually happened when the recommendation was applied.
 *
 * The point of the panel is the middle column: the counterfactual's PREDICTED
 * score sits next to the score the model really returned for the mutated event.
 * A recommendation that survives being carried out is a much stronger claim
 * than one that is only asserted, and a gap between the two is worth seeing
 * rather than hiding.
 */
function AppliedResult({
  apply,
  cf,
  originalScore,
  targetLevel,
  onRerun,
}: {
  apply: ApplyState;
  cf: Counterfactual;
  originalScore: number;
  targetLevel: string;
  onRerun: (deriveDependents: boolean) => void;
}) {
  if (apply.status === 'running') {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-[var(--radius-input)] border border-border bg-bg p-3 text-xs text-text-muted">
        <Loader2 className="h-4 w-4 animate-spin" /> Re-scoring the modified event…
      </div>
    );
  }
  if (apply.status === 'error' || !apply.score) {
    return (
      <div className="mt-3 rounded-[var(--radius-input)] border border-risk-critical/30 bg-risk-critical/5 p-3 text-xs text-risk-critical">
        Could not re-score: {apply.error ?? 'unknown error'}
      </div>
    );
  }

  const actual = apply.score.risk_score;
  const drop = originalScore > 0 ? ((originalScore - actual) / originalScore) * 100 : 0;
  const hitTarget = apply.score.risk_level.toLowerCase() === targetLevel.toLowerCase();
  // "Close enough" is generous on purpose — the interesting case is a gap you
  // can see, not a rounding difference dressed up as a discrepancy.
  const matchedPrediction = Math.abs(actual - cf.predicted_risk_score) < 0.005;

  return (
    <div className="mt-3 rounded-[var(--radius-input)] border border-border bg-bg p-3">
      <p className="mb-2 text-xs font-medium text-text">Applied &amp; re-scored by the model</p>

      <div className="flex flex-wrap items-center gap-4">
        <Column label="Before" score={originalScore} level={null} muted />
        <span className="text-text-muted">→</span>
        <Column label="Predicted" score={cf.predicted_risk_score} level={cf.predicted_risk_level} muted />
        <span className="text-text-muted">→</span>
        <Column label="Actual" score={actual} level={apply.score.risk_level} />
        <div className="ml-auto text-right">
          <p className="text-xs text-text-muted">real reduction</p>
          <p className={`text-lg font-semibold ${drop > 0 ? 'text-risk-low' : 'text-risk-critical'}`}>
            {drop > 0 ? '−' : '+'}
            {Math.abs(drop).toFixed(1)}%
          </p>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        <Badge tone={hitTarget ? 'success' : 'warning'}>
          {hitTarget ? `reached the ${targetLevel} target` : `still ${apply.score.risk_level}, short of ${targetLevel}`}
        </Badge>
        <Badge tone={matchedPrediction ? 'success' : 'neutral'}>
          {matchedPrediction
            ? 'matches the prediction'
            : `${actual < cf.predicted_risk_score ? 'beat' : 'missed'} the prediction by ${Math.abs(actual - cf.predicted_risk_score).toFixed(4)}`}
        </Badge>
      </div>

      <p className="mt-2 text-xs text-text-muted">
        Changed <span className="font-mono text-text">{apply.changed.join(', ') || '—'}</span>
        {apply.derived.length > 0 && (
          <>
            {' '}
            and adjusted{' '}
            <span className="font-mono text-text">{apply.derived.join(', ')}</span> to keep the event
            internally consistent
          </>
        )}
        .
      </p>

      {/* The default is the bare recommendation. This offers the other view:
          what would really happen once the fields that depend on the changed
          one are brought into line. */}
      <button
        onClick={() => onRerun(!apply.consistent)}
        className="mt-1.5 text-xs font-medium text-accent hover:underline"
      >
        {apply.consistent
          ? 'Re-run with only the recommended field changed'
          : 'Re-run with dependent fields brought into line'}
      </button>

      {apply.score.explanation?.reasons?.length ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-text-muted">
          {apply.score.explanation.reasons.slice(0, 4).map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Column({
  label,
  score,
  level,
  muted,
}: {
  label: string;
  score: number;
  level: string | null;
  muted?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-text-muted">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        {level && <RiskBadge level={toBadge(level)} />}
        <span
          className={`font-semibold ${muted ? 'text-base text-text-muted' : 'text-xl text-text'}`}
        >
          {score.toFixed(4)}
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- fragments

function ErrorCard({ message }: { message: string | null }) {
  return (
    <Card title="Run failed">
      <p className="text-sm text-risk-critical">{message ?? 'Unknown error'}</p>
    </Card>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-xs text-text-muted">
        {icon}
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular text-text">{value}</p>
    </div>
  );
}

function Meter({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-full border border-border bg-surface px-2.5 py-1">
      <span className="text-text-muted">{label}: </span>
      <span className="font-medium text-text">{value}</span>
    </span>
  );
}
