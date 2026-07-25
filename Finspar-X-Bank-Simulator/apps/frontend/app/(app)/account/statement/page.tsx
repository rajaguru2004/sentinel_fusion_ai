'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Search } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { RiskBadge } from '@/components/ui/Badge';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/Table';
import { PageHeader } from '@/components/PageHeader';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatPaise, formatDateDMY, paiseToRupees } from '@/lib/format';
import { exportToExcel } from '@/lib/excel';
import type { AccountBalance, StatementRow } from '@/lib/types';

export default function AccountStatementPage() {
  const { data: accounts } = useQuery<AccountBalance[]>({
    queryKey: ['balances', 'DEPOSIT'],
    queryFn: async () => (await api.get('/accounts/balance?accountType=DEPOSIT')).data,
  });

  const [accountNumber, setAccountNumber] = useState('');
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [applied, setApplied] = useState(false);

  const acc = accountNumber || accounts?.[0]?.accountNumber || '';

  const { data, isLoading, refetch } = useQuery<StatementRow[]>({
    queryKey: ['statement', acc, order, from, to],
    queryFn: async () => {
      const params = new URLSearchParams({ accountNumber: acc, order });
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      return (await api.get(`/accounts/statement?${params}`)).data;
    },
    enabled: applied && !!acc,
  });

  const download = (): void => {
    if (!data?.length) return void toast.error('Load a statement first');
    exportToExcel(
      `statement-${acc}-${new Date().toISOString().slice(0, 10)}`,
      [
        { header: 'Date' },
        { header: 'Description' },
        { header: 'Reference', text: true },
        { header: 'Debit (₹)', numeric: true },
        { header: 'Credit (₹)', numeric: true },
        { header: 'Balance (₹)', numeric: true },
        { header: 'Risk' },
      ],
      data.map((r) => [
        formatDateDMY(r.date),
        r.description,
        r.refNo ?? '',
        r.direction === 'DEBIT' ? paiseToRupees(r.amount) : '',
        r.direction === 'CREDIT' ? paiseToRupees(r.amount) : '',
        paiseToRupees(r.balanceAfter),
        r.riskLevel ?? '',
      ]),
      `Statement ${acc}`,
    );
    toast.success('Statement downloaded');
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Account Statement" description="Transaction history with fraud risk badges." />

      <Card title="Filters">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <Select
            label="Account Number"
            required
            value={acc}
            onChange={(e) => setAccountNumber(e.target.value)}
            options={(accounts ?? []).map((a) => ({ value: a.accountNumber, label: `${a.accountNumber} — ${a.accountName}` }))}
          />
          <Input label="From Date" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          <Input label="To Date" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          <Select
            label="Order"
            value={order}
            onChange={(e) => setOrder(e.target.value as 'desc' | 'asc')}
            options={[
              { value: 'desc', label: 'Descending' },
              { value: 'asc', label: 'Ascending' },
            ]}
          />
        </div>
        <div className="mt-4 flex gap-2">
          <Button onClick={() => { setApplied(true); refetch(); }}>
            <Search className="h-4 w-4" /> View
          </Button>
          <Button variant="outline" onClick={download} disabled={!data?.length}>
            <Download className="h-4 w-4" /> Download
          </Button>
        </div>
      </Card>

      <div className="mt-6">
        {!applied ? (
          <EmptyState message="Choose an account and click View to load the statement." />
        ) : isLoading ? (
          <div className="h-40 animate-pulse rounded-[var(--radius-card)] border border-border bg-surface" />
        ) : !data?.length ? (
          <EmptyState message="No transactions in this period." />
        ) : (
          <Table>
            <THead>
              <TH>Date</TH>
              <TH>Description</TH>
              <TH>Reference</TH>
              <TH numeric>Debit</TH>
              <TH numeric>Credit</TH>
              <TH numeric>Balance</TH>
              <TH numeric>Risk</TH>
            </THead>
            <TBody>
              {data.map((r) => (
                <TR key={r.id}>
                  <TD className="tabular">{formatDateDMY(r.date)}</TD>
                  <TD>{r.description}</TD>
                  <TD className="tabular text-xs text-text-muted">{r.refNo ?? '—'}</TD>
                  <TD numeric>{r.direction === 'DEBIT' ? formatPaise(r.amount) : '—'}</TD>
                  <TD numeric>{r.direction === 'CREDIT' ? formatPaise(r.amount) : '—'}</TD>
                  <TD numeric>{formatPaise(r.balanceAfter)}</TD>
                  <TD numeric>{r.riskLevel ? <RiskBadge level={r.riskLevel} /> : '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </div>
  );
}
