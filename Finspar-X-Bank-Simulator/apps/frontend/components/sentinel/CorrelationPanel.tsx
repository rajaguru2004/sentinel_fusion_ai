'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Crosshair, Fingerprint, Globe, User, X } from 'lucide-react';
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
            ±{data.windowHours}h ·{' '}
            {/* Distinct events. A single event can hang off more than one branch
                below, so the branch counts deliberately sum to more than this. */}
            {data.related.length} distinct event{data.related.length === 1 ? '' : 's'}
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
          <Timeline anchor={data.anchor} related={data.related} />
          <CorrelationTree anchor={data.anchor} related={data.related} />
        </>
      )}
    </div>
  );
}

/**
 * The cluster as a tree: this event at the root, one branch per link type, and
 * the events that reach it through that link as leaves.
 *
 * A flat list showed WHICH events are related but buried HOW — the link icons
 * were three small glyphs mid-row. The distinction carries the whole meaning of
 * the panel: nine events on one customer is that customer retrying, while two
 * events on one device across different customers is someone working through a
 * list of victims. Branching on the link makes those two shapes look different
 * at a glance instead of identical.
 *
 * An event that shares more than one identifier appears under each branch it
 * belongs to. That is deliberate — the branch counts then match the link
 * summary, and "same device AND same IP" is exactly the corroboration an
 * analyst is looking for — so the header states the total is de-duplicated.
 */
function CorrelationTree({
  anchor,
  related,
}: {
  anchor: CorrelationRow;
  related: CorrelationRow[];
}) {
  const branches = (Object.keys(LINK_META) as string[])
    .map((key) => ({
      key,
      ...LINK_META[key],
      rows: related
        .filter((r) => r.sharedBy?.includes(key))
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    }))
    .filter((b) => b.rows.length > 0);

  // Any event whose link type we do not recognise still has to appear, or the
  // tree would silently show fewer events than the header counts.
  const orphans = related.filter((r) => !r.sharedBy?.some((s) => s in LINK_META));

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (key: string): void => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  return (
    <div className="mt-3">
      {/* Root — the event being investigated. */}
      <EventRow row={anchor} isAnchor />

      <div className="mt-1">
        {branches.map((b, i) => {
          const Icon = b.icon;
          const isLast = i === branches.length - 1 && orphans.length === 0;
          const isOpen = !collapsed[b.key];
          return (
            <TreeNode key={b.key} isLast={isLast}>
              <button
                onClick={() => toggle(b.key)}
                aria-expanded={isOpen}
                className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-xs text-text hover:bg-bg"
              >
                {isOpen ? (
                  <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 text-text-muted" />
                )}
                <Icon className="h-3.5 w-3.5 text-text-muted" />
                <span className="font-medium">{b.label}</span>
                <span className="text-text-muted">
                  · {b.rows.length} event{b.rows.length === 1 ? '' : 's'}
                </span>
              </button>

              {isOpen && (
                <div className="mt-0.5">
                  {b.rows.map((r, j) => (
                    <TreeNode key={r.id} isLast={j === b.rows.length - 1}>
                      <EventRow row={r} />
                    </TreeNode>
                  ))}
                </div>
              )}
            </TreeNode>
          );
        })}

        {orphans.length > 0 && (
          <TreeNode isLast>
            <p className="px-1 py-1 text-xs text-text-muted">
              {orphans.length} event{orphans.length === 1 ? '' : 's'} with no recognised link type
            </p>
          </TreeNode>
        )}
      </div>
    </div>
  );
}

/**
 * One tree branch: an elbow connector plus the vertical run down to the next
 * sibling. The last child stops its vertical line at the elbow, which is what
 * makes the corner read as a corner rather than a passing line.
 */
function TreeNode({ children, isLast }: { children: React.ReactNode; isLast: boolean }) {
  return (
    <div className="relative pl-5">
      <span
        aria-hidden
        className={`absolute left-1.5 top-0 w-px bg-border ${isLast ? 'h-[15px]' : 'h-full'}`}
      />
      <span aria-hidden className="absolute left-1.5 top-[15px] h-px w-2.5 bg-border" />
      {children}
    </div>
  );
}

/** One event, as a leaf (or the highlighted root). */
function EventRow({ row, isAnchor }: { row: CorrelationRow; isAnchor?: boolean }) {
  return (
    <div
      className={`my-0.5 flex flex-wrap items-center gap-2 rounded-[var(--radius-input)] border px-2.5 py-1.5 text-xs ${
        isAnchor ? 'border-accent/50 bg-accent/10' : 'border-border bg-surface'
      }`}
    >
      {isAnchor && (
        <span className="inline-flex items-center gap-1 text-accent" title="the event being investigated">
          <Crosshair className="h-3.5 w-3.5" />
          <span className="font-medium">this event</span>
        </span>
      )}
      <RiskBadge level={row.riskLevel} />
      <span className="text-text">{row.eventType}</span>
      {row.amount && <span className="tabular text-text-muted">{formatPaise(row.amount)}</span>}
      <span className="text-text-muted">{row.decision}</span>
      {/* Every link this event shares, not just the branch it is sitting under —
          corroboration across two identifiers is the strongest signal here. */}
      <span className="flex gap-1">
        {row.sharedBy?.map((s) => {
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
      <span className="ml-auto tabular text-text-muted">{formatDateTimeDMY(row.createdAt)}</span>
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
