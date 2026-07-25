'use client';

import { useQuery } from '@tanstack/react-query';
import { Fingerprint, Globe, User, X } from 'lucide-react';
import { RiskBadge } from '@/components/ui/Badge';
import { api } from '@/lib/api';
import { formatDateTimeDMY, formatPaise } from '@/lib/format';

type Level = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

interface CorrelationRow {
  id: string;
  createdAt: string;
  eventType: string;
  riskScore: number;
  riskLevel: Level;
  decision: string;
  userId: string | null;
  ip: string | null;
  deviceFingerprint: string | null;
  sharedBy?: string[];
  refNo?: string | null;
  amount?: string | null;
  paymentStatus?: string | null;
}

interface Correlation {
  anchor: CorrelationRow;
  windowHours: number;
  related: CorrelationRow[];
  summary: { user: number; device: number; ip: number };
}

const LINK_META: Record<string, { icon: typeof User; label: string }> = {
  user: { icon: User, label: 'same customer' },
  device: { icon: Fingerprint, label: 'same device' },
  ip: { icon: Globe, label: 'same IP' },
};

/**
 * Entity correlation for one event (ENHANCEMENTS.md §6).
 *
 * Answers "has this actor done anything else?" from the identifiers FraudEvent
 * already stores. The value is in the per-row `sharedBy` tags: a cluster of
 * events on the *same device* across *different customers* is a very different
 * story from the same customer retrying, and only the link type distinguishes them.
 *
 * Doubles as the entity timeline — the sparkline row plots each related event's
 * score in time order, so a slow escalation is visible as a shape.
 */
export function CorrelationPanel({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const { data, isLoading, isError } = useQuery<Correlation>({
    queryKey: ['correlation', eventId],
    queryFn: async () => (await api.get(`/analyst/events/${eventId}/related`)).data,
  });

  return (
    <div className="mt-3 rounded-[var(--radius-card)] border border-accent/40 bg-accent/5 p-3">
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium text-text">Related activity</p>
        {data && (
          <span className="text-xs text-text-muted">
            ±{data.windowHours}h · {data.related.length} event
            {data.related.length === 1 ? '' : 's'}
          </span>
        )}
        <button
          onClick={onClose}
          aria-label="Close related activity"
          className="ml-auto rounded p-1 text-text-muted hover:bg-bg hover:text-text"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {isLoading && <p className="mt-2 text-xs text-text-muted">Searching for linked events…</p>}
      {isError && (
        <p className="mt-2 text-xs text-risk-critical">Could not load related activity.</p>
      )}

      {data && !data.related.length && (
        <p className="mt-2 text-xs text-text-muted">
          Nothing else shares this event&apos;s customer, device or IP in the window. An isolated
          event — which is itself informative.
        </p>
      )}

      {data && data.related.length > 0 && (
        <>
          {/* Link summary — what kind of cluster is this? */}
          <div className="mt-2 flex flex-wrap gap-2">
            {(Object.keys(LINK_META) as (keyof typeof LINK_META)[]).map((k) => {
              const count = data.summary[k as keyof Correlation['summary']];
              if (!count) return null;
              const { icon: Icon, label } = LINK_META[k];
              return (
                <span
                  key={k}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-text"
                >
                  <Icon className="h-3.5 w-3.5 text-text-muted" />
                  {count} × {label}
                </span>
              );
            })}
          </div>

          <Timeline anchor={data.anchor} related={data.related} />

          <div className="mt-3 space-y-1.5">
            {data.related.map((r) => (
              <div
                key={r.id}
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius-input)] border border-border bg-surface px-2.5 py-1.5 text-xs"
              >
                <RiskBadge level={r.riskLevel} />
                <span className="text-text">{r.eventType}</span>
                {r.amount && <span className="tabular text-text-muted">{formatPaise(r.amount)}</span>}
                <span className="text-text-muted">{r.decision}</span>
                <span className="flex gap-1">
                  {r.sharedBy?.map((s) => {
                    const meta = LINK_META[s];
                    if (!meta) return null;
                    const Icon = meta.icon;
                    return (
                      <span
                        key={s}
                        title={meta.label}
                        className="inline-flex items-center rounded-full bg-accent/15 p-1 text-accent"
                      >
                        <Icon className="h-3 w-3" />
                      </span>
                    );
                  })}
                </span>
                <span className="ml-auto tabular text-text-muted">
                  {formatDateTimeDMY(r.createdAt)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Entity timeline: every related event plus the anchor, oldest to newest, bar
 * height proportional to risk score. Reveals escalation patterns — a run of
 * small probes before one large attempt — that a sorted list flattens away.
 */
function Timeline({ anchor, related }: { anchor: CorrelationRow; related: CorrelationRow[] }) {
  const points = [...related, anchor].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  const max = Math.max(...points.map((p) => p.riskScore), 0.0001);

  return (
    <div className="mt-3">
      <p className="mb-1 text-[11px] text-text-muted">
        Risk over time (oldest → newest; the outlined bar is this event)
      </p>
      <div className="flex h-12 items-end gap-1">
        {points.map((p) => (
          <div
            key={p.id}
            title={`${p.eventType} · ${p.riskScore.toFixed(4)} · ${formatDateTimeDMY(p.createdAt)}`}
            className={`min-w-[3px] flex-1 rounded-t ${
              p.id === anchor.id ? 'ring-1 ring-accent ring-offset-1 ring-offset-bg' : ''
            } ${
              p.riskLevel === 'CRITICAL'
                ? 'bg-risk-critical'
                : p.riskLevel === 'HIGH'
                  ? 'bg-risk-high'
                  : p.riskLevel === 'MEDIUM'
                    ? 'bg-risk-medium'
                    : 'bg-risk-low'
            }`}
            style={{ height: `${Math.max(6, (p.riskScore / max) * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}
