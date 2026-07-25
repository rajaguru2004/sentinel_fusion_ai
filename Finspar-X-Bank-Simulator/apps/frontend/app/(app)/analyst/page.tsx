'use client';

import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ShieldX, PauseCircle, FolderOpen, Link2, Radio } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { RiskBadge, Badge } from '@/components/ui/Badge';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/Table';
import { PageHeader } from '@/components/PageHeader';
import { ScoringHealthBanner } from '@/components/sentinel/ScoringHealthBanner';
import { CorrelationPanel } from '@/components/sentinel/CorrelationPanel';
import { api, apiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { formatPaise, formatDateTimeDMY } from '@/lib/format';
import { humanizeReasons } from '@/lib/reasons';
import { useLiveAlerts, type LiveAlert } from '@/lib/use-live-alerts';

interface Stats {
  totalEvents: number; openCases: number;
  byLevel: Record<'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL', number>;
  heldCount: number; heldAmount: string; blockedCount: number; blockedAmount: string;
}
interface FeedRow {
  id: string; createdAt: string; eventType: string; riskScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; decision: string;
  reasons: string[]; paymentId: string | null; paymentStatus: string | null;
  refNo: string | null; amount: string | null; rail: string | null; beneficiaryName: string | null;
}
interface HeldRow {
  paymentId: string; refNo: string; amount: string; rail: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
  reasons: string[]; beneficiaryName: string | null; createdAt: string;
}

export default function AnalystDashboardPage() {
  const qc = useQueryClient();
  const role = useAuthStore((s) => s.user?.role);
  const isAuthorizer = role === 'AUTHORIZER';

  /** Which feed row has its correlation cluster expanded. */
  const [correlating, setCorrelating] = useState<string | null>(null);

  // Live stream (§6). A verdict now lands the instant confirm() produces it,
  // instead of up to 4s later on the next poll.
  //
  // The queries below keep their (now slower) refetchInterval as a safety net:
  // SSE can drop and silently reconnect, and a console that is subtly stale is
  // worse than one that is openly polling. Belt and braces, cheaply.
  const onAlert = useCallback(
    (alert: LiveAlert) => {
      qc.invalidateQueries({ queryKey: ['analyst-feed'] });
      qc.invalidateQueries({ queryKey: ['analyst-stats'] });
      if (alert.decision === 'HOLD' || alert.decision === 'BLOCK') {
        qc.invalidateQueries({ queryKey: ['analyst-held'] });
        toast.warning(
          `${alert.decision === 'BLOCK' ? 'Blocked' : 'Held'}: ${alert.eventType} scored ${alert.riskScore.toFixed(3)}`,
        );
      }
    },
    [qc],
  );
  const { status: streamStatus } = useLiveAlerts(onAlert);

  const { data: stats } = useQuery<Stats>({
    queryKey: ['analyst-stats'],
    queryFn: async () => (await api.get('/analyst/stats')).data,
    refetchInterval: 15_000,
  });
  const { data: feed } = useQuery<FeedRow[]>({
    queryKey: ['analyst-feed'],
    queryFn: async () => (await api.get('/analyst/feed')).data,
    refetchInterval: 15_000,
  });

  // Authorizer action on a held payment: release back to maker, or reject.
  const act = useMutation({
    mutationFn: async (v: { id: string; action: 'release' | 'reject' }) =>
      (await api.post(`/analyst/payments/${v.id}/${v.action}`)).data,
    onSuccess: (data) => {
      toast.success(data.message);
      qc.invalidateQueries({ queryKey: ['analyst-held'] });
      qc.invalidateQueries({ queryKey: ['analyst-feed'] });
      qc.invalidateQueries({ queryKey: ['analyst-stats'] });
    },
    onError: (e) => toast.error(apiError(e)),
  });
  const { data: held } = useQuery<HeldRow[]>({
    queryKey: ['analyst-held'],
    queryFn: async () => (await api.get('/analyst/held')).data,
    refetchInterval: 15_000,
  });
  const { data: cases } = useQuery<any[]>({
    queryKey: ['analyst-cases'],
    queryFn: async () => (await api.get('/analyst/cases')).data,
    refetchInterval: 30_000,
  });

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Analyst Dashboard"
        description="Live fraud signals from the decision gateway."
        actions={
          // Report the ACTUAL stream state. A hardcoded "live" chip that stays lit
          // through a dropped connection is worse than no chip at all.
          <Badge
            tone={streamStatus === 'live' ? 'success' : streamStatus === 'connecting' ? 'info' : 'warning'}
          >
            {streamStatus === 'live' ? (
              <Radio className="h-3 w-3" />
            ) : (
              <Activity className="h-3 w-3" />
            )}
            {streamStatus === 'live'
              ? 'live'
              : streamStatus === 'connecting'
                ? 'connecting'
                : 'reconnecting — polling'}
          </Badge>
        }
      />

      <ScoringHealthBanner />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={<Activity className="h-5 w-5 text-accent" />} label="Total events" value={stats?.totalEvents ?? 0} />
        <Stat icon={<FolderOpen className="h-5 w-5 text-risk-medium" />} label="Open cases" value={stats?.openCases ?? 0} />
        <Stat icon={<PauseCircle className="h-5 w-5 text-risk-high" />} label="Held" value={stats?.heldCount ?? 0} sub={stats ? formatPaise(stats.heldAmount) : ''} />
        <Stat icon={<ShieldX className="h-5 w-5 text-risk-critical" />} label="Blocked" value={stats?.blockedCount ?? 0} sub={stats ? formatPaise(stats.blockedAmount) : ''} />
      </div>

      <div className="mt-4 grid grid-cols-4 gap-2">
        {(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).map((lvl) => (
          <div key={lvl} className="rounded-[var(--radius-card)] border border-border bg-surface p-3 text-center">
            <RiskBadge level={lvl} />
            <p className="mt-2 text-xl font-semibold tabular text-text">{stats?.byLevel?.[lvl] ?? 0}</p>
          </div>
        ))}
      </div>

      <Card title={`Held payments — awaiting review${held?.length ? ` (${held.length})` : ''}`} className="mt-6">
        {!held?.length ? (
          <EmptyState message="No payments on hold. HIGH-risk payments land here for release or rejection." />
        ) : (
          <div className="space-y-2">
            {held.map((h) => (
              <div key={h.paymentId} className="flex items-start gap-3 rounded-[var(--radius-input)] border border-risk-high/40 bg-risk-high/5 p-3">
                {h.riskLevel && <RiskBadge level={h.riskLevel} />}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-text">{h.beneficiaryName ?? h.refNo}</span>
                    <span className="tabular text-text-muted">{formatPaise(h.amount)}</span>
                    <Badge>{h.rail}</Badge>
                    <span className="tabular text-xs text-text-muted">{h.refNo}</span>
                    <span className="ml-auto tabular text-xs text-text-muted">{formatDateTimeDMY(h.createdAt)}</span>
                  </div>
                  {humanizeReasons(h.reasons).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {humanizeReasons(h.reasons).map((r, i) => (
                        <span key={i} className="rounded-full border border-border px-2 py-0.5 text-xs text-text-muted">{r}</span>
                      ))}
                    </div>
                  )}
                  {isAuthorizer ? (
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" disabled={act.isPending} onClick={() => act.mutate({ id: h.paymentId, action: 'release' })}>
                        Release
                      </Button>
                      <Button size="sm" variant="danger" disabled={act.isPending} onClick={() => act.mutate({ id: h.paymentId, action: 'reject' })}>
                        Reject
                      </Button>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-text-muted">Only an authorizer can release or reject this.</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Live transaction feed" className="mt-6">
        {!feed?.length ? (
          <EmptyState message="No fraud events yet. Initiate a payment to see scoring stream in." />
        ) : (
          <div className="space-y-2">
            {feed.map((e) => (
              <div key={e.id} className="flex items-start gap-3 rounded-[var(--radius-input)] border border-border p-3">
                <RiskBadge level={e.riskLevel} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium text-text">{e.beneficiaryName ?? e.eventType}</span>
                    {e.amount && <span className="tabular text-text-muted">{formatPaise(e.amount)}</span>}
                    {e.rail && <Badge>{e.rail}</Badge>}
                    <Badge tone={e.decision === 'BLOCK' ? 'danger' : e.decision === 'HOLD' ? 'warning' : 'neutral'}>{e.decision}</Badge>
                    <span className="ml-auto tabular text-xs text-text-muted">{formatDateTimeDMY(e.createdAt)}</span>
                  </div>
                  {humanizeReasons(e.reasons).length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {humanizeReasons(e.reasons).map((r, i) => (
                        <span key={i} className="rounded-full border border-border px-2 py-0.5 text-xs text-text-muted">{r}</span>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {e.paymentStatus === 'HELD' && e.paymentId && (
                      isAuthorizer ? (
                        <>
                          <Button
                            size="sm"
                            disabled={act.isPending}
                            onClick={() => act.mutate({ id: e.paymentId!, action: 'release' })}
                          >
                            Release
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={act.isPending}
                            onClick={() => act.mutate({ id: e.paymentId!, action: 'reject' })}
                          >
                            Reject
                          </Button>
                        </>
                      ) : (
                        <p className="text-xs text-text-muted">Held — an authorizer can release or reject this.</p>
                      )
                    )}
                    <button
                      onClick={() => setCorrelating((cur) => (cur === e.id ? null : e.id))}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-text-muted transition-colors hover:border-accent hover:text-accent"
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      {correlating === e.id ? 'Hide related' : 'Related activity'}
                    </button>
                  </div>

                  {correlating === e.id && (
                    <CorrelationPanel eventId={e.id} onClose={() => setCorrelating(null)} />
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Cases" className="mt-6">
        {!cases?.length ? (
          <EmptyState message="No cases raised." />
        ) : (
          <Table>
            <THead>
              <TH>Tracking Ref</TH>
              <TH>Source</TH>
              <TH>Type</TH>
              <TH numeric>Amount</TH>
              <TH>Status</TH>
              <TH>Created</TH>
            </THead>
            <TBody>
              {cases.map((c) => (
                <TR key={c.trackingRef}>
                  <TD className="tabular">{c.trackingRef}</TD>
                  <TD><Badge tone={c.source === 'AI_FLAGGED' ? 'info' : 'neutral'}>{c.source}</Badge></TD>
                  <TD className="text-xs">{c.fraudType ?? '—'}</TD>
                  <TD numeric>{c.amount ? formatPaise(c.amount) : '—'}</TD>
                  <TD><Badge tone={c.status === 'OPEN' ? 'warning' : 'success'}>{c.status}</Badge></TD>
                  <TD className="tabular">{formatDateTimeDMY(c.createdAt)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: number; sub?: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-border bg-surface p-4">
      <div className="flex items-center gap-2 text-sm text-text-muted">{icon}{label}</div>
      <p className="mt-2 text-2xl font-semibold tabular text-text">{value}</p>
      {sub && <p className="text-xs tabular text-text-muted">{sub}</p>}
    </div>
  );
}
