'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Clock, AlertTriangle, Info, PauseCircle, ShieldX } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { api } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';
import { formatDateTimeDMY } from '@/lib/format';

interface Summary {
  pendingCount: number;
  heldCount: number;
  blockedCount: number;
  lastLoginAt: string | null;
  info: { neftRtgsCutoff: string; perTransactionLimit: string; otpValiditySeconds: number };
}

export default function DashboardPage() {
  const user = useAuthStore((s) => s.user);
  const { data } = useQuery<Summary>({
    queryKey: ['dashboard-summary'],
    queryFn: async () => (await api.get('/dashboard/summary')).data,
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text">Dashboard</h1>
        <p className="text-sm text-text-muted">
          {user?.customerName} · Customer <span className="tabular">{user?.customerId}</span>
        </p>
      </div>

      {/* Region 1 — Last successful login (fraud control) */}
      <Card>
        <div className="flex items-center gap-3">
          <Clock className="h-5 w-5 text-accent" />
          <div>
            <p className="text-sm text-text-muted">Last successful login on</p>
            <p className="font-medium text-text tabular">
              {data?.lastLoginAt ? formatDateTimeDMY(data.lastLoginAt) : 'First login on this account'}
            </p>
          </div>
        </div>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Region 2 — Alerts */}
        <Card title="Alerts" actions={<AlertTriangle className="h-4 w-4 text-risk-medium" />}>
          <ul className="space-y-3 text-sm">
            <li className="flex items-center justify-between">
              <Link href="/payments/modify" className="flex items-center gap-2 text-text hover:text-primary">
                <PauseCircle className="h-4 w-4 text-risk-medium" /> Pending transactions
              </Link>
              <Badge tone={data?.pendingCount ? 'warning' : 'neutral'}>{data?.pendingCount ?? 0}</Badge>
            </li>
            <li className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-text">
                <PauseCircle className="h-4 w-4 text-risk-high" /> Transactions on hold
              </span>
              <Badge tone={data?.heldCount ? 'danger' : 'neutral'}>{data?.heldCount ?? 0}</Badge>
            </li>
            <li className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-text">
                <ShieldX className="h-4 w-4 text-risk-critical" /> Blocked transactions
              </span>
              <Badge tone={data?.blockedCount ? 'danger' : 'neutral'}>{data?.blockedCount ?? 0}</Badge>
            </li>
          </ul>
        </Card>

        {/* Region 3 — Information */}
        <Card title="Information" actions={<Info className="h-4 w-4 text-accent" />}>
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-text-muted">NEFT / RTGS cut-off</dt>
              <dd className="font-medium text-text tabular">{data?.info.neftRtgsCutoff ?? '19:30'}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-text-muted">Per-transaction limit</dt>
              <dd className="font-medium text-text tabular">{data?.info.perTransactionLimit ?? '₹25,00,000'}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-text-muted">OTP validity</dt>
              <dd className="font-medium text-text tabular">{data?.info.otpValiditySeconds ?? 100}s</dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}
