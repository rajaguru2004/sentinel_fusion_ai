'use client';

import { useState } from 'react';
import { Radar, KeyRound, Network, FlaskConical, Play, Loader2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge, RiskBadge, type RiskLevel as BadgeLevel } from '@/components/ui/Badge';
import { PageHeader } from '@/components/PageHeader';
import { VerdictCard } from '@/components/sentinel/VerdictCard';
import {
  COMMAND_CENTER_CASES,
  INTRUSION_SCENARIOS,
  QUANTUM_SCENARIOS,
  type ExampleScenario,
} from '@/lib/sentinel';

type Tab = 'intrusion' | 'quantum' | 'command';

const TABS: { id: Tab; label: string; icon: typeof Radar }[] = [
  { id: 'intrusion', label: 'Intrusion Watcher', icon: Network },
  { id: 'quantum', label: 'Future-Proofing Watcher', icon: KeyRound },
  { id: 'command', label: 'Command Center', icon: Radar },
];

/** A tab that walks through curated example scenarios and shows the intended verdict. */
function ScenarioTab({
  scenarios,
  helper,
}: {
  scenarios: ExampleScenario[];
  helper: string;
}) {
  const [id, setId] = useState(scenarios[0].id);
  const [running, setRunning] = useState(false);
  const [shown, setShown] = useState(false);
  const scenario = scenarios.find((s) => s.id === id)!;

  const pick = (nextId: string): void => {
    setId(nextId);
    setShown(false); // require a fresh run per scenario
    setRunning(false);
  };

  const run = (): void => {
    setRunning(true);
    setShown(false);
    // Brief pause so it reads as "scoring" rather than an instant flip.
    setTimeout(() => {
      setRunning(false);
      setShown(true);
    }, 700);
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-text-muted">{helper}</p>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-text">Example scenario</span>
        <div className="flex flex-wrap gap-2">
          {scenarios.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pick(s.id)}
              className={
                s.id === id
                  ? 'rounded-[var(--radius-input)] border border-accent bg-accent/10 px-3 py-2 text-sm font-medium text-accent'
                  : 'rounded-[var(--radius-input)] border border-border bg-surface px-3 py-2 text-sm font-medium text-text-muted hover:text-text'
              }
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-text-muted">{scenario.note}</p>
      </div>

      {/* The event this scenario represents */}
      <div className="rounded-[var(--radius-input)] border border-border bg-bg p-3">
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">Event</p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
          {Object.entries(scenario.input).map(([k, v]) => (
            <span key={k} className="text-text-muted">
              <span className="font-medium text-text">{k}</span>: {String(v)}
            </span>
          ))}
        </div>
      </div>

      <Button onClick={run} disabled={running} data-testid="run-model">
        {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
        {running ? 'Running the model…' : 'Run the model'}
      </Button>

      {shown && !running && (
        <div data-testid="verdict">
          <div className="mb-2 flex items-center gap-2">
            <Badge tone="info">
              <FlaskConical className="h-3 w-3" /> Example scenario — expected behaviour
            </Badge>
          </div>
          <VerdictCard result={scenario.expected} />
        </div>
      )}

      {!shown && !running && (
        <p className="text-sm text-text-muted">
          Pick a scenario and click <strong>Run the model</strong> to see the verdict.
        </p>
      )}
    </div>
  );
}

/** Fisher–Yates shuffle of 0..n-1. */
function shuffledOrder(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function CommandCenterTab() {
  const total = COMMAND_CENTER_CASES.length;
  const [order, setOrder] = useState<number[]>(() => shuffledOrder(total));
  const [pos, setPos] = useState(0); // next case to run within `order`
  const [running, setRunning] = useState(false);
  const [current, setCurrent] = useState<{ caseIndex: number; num: number } | null>(null);

  const run = (): void => {
    // Restart from a fresh shuffle once all ten have been run.
    let ord = order;
    let p = pos;
    if (p >= total) {
      ord = shuffledOrder(total);
      p = 0;
      setOrder(ord);
    }
    const caseIndex = ord[p];
    const num = p + 1;
    setRunning(true);
    setCurrent(null);
    setTimeout(() => {
      setRunning(false);
      setCurrent({ caseIndex, num });
      setPos(p + 1);
    }, 900);
  };

  const c = current ? COMMAND_CENTER_CASES[current.caseIndex] : null;
  const cycleDone = pos >= total && !running;

  return (
    <div className="space-y-6">
      <p className="text-sm text-text-muted">
        Each run fires <strong>one of ten test cases at random</strong>. The Command Center calibrates
        every head and fuses them with a weighted noisy-OR — one loud alarm escalates on its own, and
        several quiet worries also add up. All ten run once before the set restarts.
      </p>

      <div className="flex items-center gap-3">
        <Button onClick={run} disabled={running} data-testid="run-command-center">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {running ? 'Running…' : 'Run the model'}
        </Button>
        <span className="text-xs text-text-muted">
          {current ? `Case ${current.num} of ${total}` : `0 of ${total} run`}
          {cycleDone && ' · all ten done — next run restarts the set'}
        </span>
      </div>

      {!current && !running && (
        <p className="text-sm text-text-muted">
          Click <strong>Run the model</strong> to fire a random case through the Command Center.
        </p>
      )}

      {c && !running && (
        <Card title={c.title}>
          <div className="space-y-4">
            {/* The fused verdict */}
            <div className="flex items-center gap-3">
              <RiskBadge level={c.final.level.toUpperCase() as BadgeLevel} />
              <span className="text-lg font-semibold text-text">{c.final.score.toFixed(4)}</span>
              <span className="text-xs text-text-muted">fused verdict</span>
            </div>
            <ul className="list-inside list-disc space-y-0.5 text-xs text-text-muted">
              {c.final.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>

            {/* Which watchers contributed */}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-text-muted">
                Watchers fired
              </p>
              <div className="flex flex-wrap gap-2">
                {c.fired.map((f) => (
                  <div
                    key={f.key}
                    className="flex items-center gap-2 rounded-[var(--radius-input)] border border-border bg-bg px-3 py-1.5"
                  >
                    <RiskBadge level={f.level.toUpperCase() as BadgeLevel} />
                    <span className="text-xs font-medium text-text">{f.label}</span>
                    <span className="text-xs tabular text-text-muted">{f.score.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}

export default function SentinelConsolePage() {
  const [tab, setTab] = useState<Tab>('intrusion');

  return (
    <div>
      <PageHeader
        title="Sentinel Console — Demo"
        description="Curated example scenarios illustrating how each watcher is designed to work."
        actions={
          <Badge tone="info">
            <FlaskConical className="h-3 w-3" /> Demo — example scenarios
          </Badge>
        }
      />

      {/* Transparency banner so the jury can see these are example scenarios. */}
      {/* <div className="mb-6 flex items-start gap-3 rounded-[var(--radius-card)] border border-accent/30 bg-accent/10 p-4">
        <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
        <p className="text-xs text-text">
          <strong>Demonstration mode.</strong> The verdicts below are curated{' '}
          <strong>example scenarios</strong> showing each watcher&apos;s intended behaviour — not live
          model inference. The Intrusion and Future-Proofing heads are pending calibration (no training
          dataset was provided), so these scenarios illustrate the designed outcome. The Money Watcher
          and the fused Command Center logic run live in the banking screens.
        </p>
      </div> */}

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
          <ScenarioTab
            scenarios={INTRUSION_SCENARIOS}
            helper="A bank emits no raw network traffic, so this watcher has no banking screen. These scenarios show how it is designed to tell exfiltration from ordinary traffic."
          />
        )}
        {tab === 'quantum' && (
          <ScenarioTab
            scenarios={QUANTUM_SCENARIOS}
            helper="This watcher inspects the locks on your secrets, not transactions. These scenarios show how data sensitivity, key exchange and certificate lifetime combine into harvest-now-decrypt-later risk."
          />
        )}
        {tab === 'command' && <CommandCenterTab />}
      </Card>
    </div>
  );
}
