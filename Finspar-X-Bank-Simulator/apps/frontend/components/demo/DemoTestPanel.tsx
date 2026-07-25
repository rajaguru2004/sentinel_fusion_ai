'use client';

import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Play, Square, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/Button';

/**
 * Login-page panel that runs the Playwright watcher specs server-side and
 * streams the output back, so a presenter can demo each watcher hands-free.
 *
 * NOTE FOR MAINTAINERS: specs 01 and 02 drive this very login page. That is
 * harmless — nothing here auto-runs, and the login form is selected by
 * name/label, so this extra markup cannot break them. Do not "tidy" this away
 * on the assumption it interferes with the tests.
 *
 * Rendered only when NEXT_PUBLIC_DEMO_TEST_RUNNER === 'true', and the backend
 * routes only exist when DEMO_TEST_RUNNER === 'true'. Both are off by default.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

type Status = 'idle' | 'running' | 'passed' | 'failed' | 'cancelled' | 'timeout';

interface SpecButton {
  id: string;
  label: string;
}

/** Fallback list if /specs is unreachable — keeps the panel useful. */
const FALLBACK: SpecButton[] = [
  { id: 'money', label: 'Money Watcher' },
  { id: 'habits', label: 'Habits Watcher' },
  { id: 'intrusion', label: 'Intrusion Watcher' },
  { id: 'quantum', label: 'Future-Proofing Watcher' },
  { id: 'command-center', label: 'Command Center' },
  { id: 'all', label: 'All watchers' },
];

export function DemoTestPanel() {
  const [specs, setSpecs] = useState<SpecButton[]>(FALLBACK);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [activeSpec, setActiveSpec] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [runId, setRunId] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  // Is the runner mounted on the backend? With DEMO_TEST_RUNNER off the routes
  // do not exist, so we hide the panel rather than offering dead buttons.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/demo-tests/specs`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { specs: SpecButton[] }) => {
        if (cancelled) return;
        if (Array.isArray(d.specs) && d.specs.length) setSpecs(d.specs);
        setAvailable(true);
      })
      .catch(() => !cancelled && setAvailable(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => esRef.current?.close(), []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  const run = async (spec: string): Promise<void> => {
    setStatus('running');
    setActiveSpec(spec);
    setLines([]);
    setSummary(null);

    let id: string;
    try {
      const res = await fetch(`${API_URL}/api/demo-tests/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spec }),
      });
      const body = await res.json();
      if (!res.ok) {
        setLines([body?.message ?? `Could not start the run (HTTP ${res.status}).`]);
        setStatus('failed');
        return;
      }
      id = body.runId;
      setRunId(id);
    } catch (err) {
      setLines([
        `Could not reach the test runner at ${API_URL}.`,
        'Start the backend with DEMO_TEST_RUNNER=true.',
        String(err),
      ]);
      setStatus('failed');
      return;
    }

    const es = new EventSource(`${API_URL}/api/demo-tests/stream/${id}`);
    esRef.current = es;
    es.onmessage = (msg) => {
      const evt = JSON.parse(msg.data) as
        | { type: 'line'; text: string }
        | { type: 'done'; status: Status; exitCode: number | null; durationMs: number };
      if (evt.type === 'line') {
        setLines((prev) => [...prev, evt.text]);
      } else if (evt.type === 'done') {
        setStatus(evt.status);
        setSummary(`${evt.status.toUpperCase()} in ${(evt.durationMs / 1000).toFixed(1)}s`);
        es.close();
        esRef.current = null;
      }
    };
    es.onerror = () => {
      // The stream closes normally when the run completes; only treat it as an
      // error if we never reached a terminal state.
      setStatus((s) => (s === 'running' ? 'failed' : s));
      es.close();
      esRef.current = null;
    };
  };

  const cancel = async (): Promise<void> => {
    if (!runId) return;
    await fetch(`${API_URL}/api/demo-tests/cancel/${runId}`, { method: 'POST' }).catch(() => {});
  };

  if (available === false) return null;

  const running = status === 'running';
  const Icon =
    status === 'passed' ? CheckCircle2 : status === 'running' ? Loader2 : status === 'idle' ? FlaskConical : XCircle;
  const tone =
    status === 'passed'
      ? 'text-risk-low'
      : status === 'failed' || status === 'timeout'
        ? 'text-risk-critical'
        : 'text-text-muted';

  return (
    <section
      data-testid="demo-test-panel"
      className="w-full max-w-md space-y-4 rounded-[var(--radius-card)] border border-border bg-surface p-6 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <FlaskConical className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold text-text">Demo test runner</h2>
        <span className="ml-auto text-xs text-text-muted">Playwright · headless</span>
      </div>
      <p className="text-xs text-text-muted">
        Runs the automated watcher scripts against this running system and streams the result back
        live. The UI scripts drive this bank in a real browser on the server.
      </p>

      <div className="grid grid-cols-2 gap-2">
        {specs
          .filter((s) => s.id !== 'all')
          .map((s) => (
            <Button
              key={s.id}
              size="sm"
              variant="outline"
              disabled={running}
              onClick={() => run(s.id)}
              data-testid={`run-${s.id}`}
              className="justify-start"
            >
              <Play className="h-3.5 w-3.5" />
              {s.label}
            </Button>
          ))}
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={running}
          onClick={() => run('all')}
          data-testid="run-all"
          className="flex-1"
        >
          <Play className="h-3.5 w-3.5" />
          Test all scripts
        </Button>
        {running && (
          <Button size="sm" variant="danger" onClick={cancel} data-testid="run-cancel">
            <Square className="h-3.5 w-3.5" />
            Cancel
          </Button>
        )}
      </div>

      {(lines.length > 0 || status !== 'idle') && (
        <div className="space-y-2">
          <div className={`flex items-center gap-2 text-xs font-medium ${tone}`}>
            <Icon className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />
            <span data-testid="run-status">
              {activeSpec ? `${activeSpec} — ` : ''}
              {summary ?? (running ? 'running…' : status)}
            </span>
          </div>
          <div
            ref={logRef}
            data-testid="run-log"
            className="max-h-64 overflow-auto rounded-[var(--radius-input)] border border-border bg-bg p-3 font-mono text-[11px] leading-relaxed text-text"
          >
            {lines.length === 0 ? (
              <span className="text-text-muted">waiting for output…</span>
            ) : (
              lines.map((l, i) => (
                <div key={i} className="whitespace-pre-wrap break-words">
                  {l}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}
