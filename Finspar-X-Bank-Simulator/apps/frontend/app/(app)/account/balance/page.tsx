'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/Table';
import { PageHeader } from '@/components/PageHeader';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatPaise, paiseToRupees } from '@/lib/format';
import { exportToExcel } from '@/lib/excel';
import { useAuthStore } from '@/lib/auth-store';
import type { AccountBalance } from '@/lib/types';

type Filter = 'DEPOSIT' | 'FD';

export default function AccountBalancePage() {
  const user = useAuthStore((s) => s.user);
  const [accountType, setAccountType] = useState<Filter>('DEPOSIT');

  const { data, isLoading } = useQuery<AccountBalance[]>({
    queryKey: ['balances', accountType],
    queryFn: async () => (await api.get(`/accounts/balance?accountType=${accountType}`)).data,
  });

  const download = (): void => {
    if (!data?.length) return void toast.error('No balances to download');
    exportToExcel(
      `account-balance-${accountType}-${new Date().toISOString().slice(0, 10)}`,
      [
        { header: 'Account Number', text: true },
        { header: 'Account Name' },
        { header: 'CCY' },
        { header: 'Available Bal (₹)', numeric: true },
        { header: 'Effective Available (₹)', numeric: true },
        { header: 'Clear Balance (₹)', numeric: true },
        { header: 'Funds in Clearing (₹)', numeric: true },
        { header: 'FD Balance (₹)', numeric: true },
      ],
      data.map((a) => [
        a.accountNumber,
        a.accountName,
        a.currency,
        paiseToRupees(a.availableBalance),
        paiseToRupees(a.effectiveAvailable),
        paiseToRupees(a.clearBalance),
        paiseToRupees(a.fundsInClearing),
        paiseToRupees(a.fdBalance),
      ]),
      `Balance ${accountType}`,
    );
    toast.success('Balances downloaded');
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Account Balance" description="Balances across your accounts." />

      <Card
        title="Filters"
        actions={
          <Button variant="outline" size="sm" onClick={download} disabled={!data?.length}>
            <Download className="h-4 w-4" /> Download Balance
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-6">
          <div className="text-sm">
            <span className="text-text-muted">Customer:</span>{' '}
            <span className="font-medium text-text tabular">{user?.customerId}</span>
          </div>
          <div className="text-sm">
            <span className="text-text-muted">Currency:</span>{' '}
            <span className="font-medium text-text">INR</span>
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-text-muted">Account Type:</span>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={accountType === 'DEPOSIT'} onChange={() => setAccountType('DEPOSIT')} className="accent-primary" />
              Savings / Current
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" checked={accountType === 'FD'} onChange={() => setAccountType('FD')} className="accent-primary" />
              FD / TD
            </label>
          </div>
        </div>
      </Card>

      <div className="mt-6">
        {isLoading ? (
          <div className="h-40 animate-pulse rounded-[var(--radius-card)] border border-border bg-surface" />
        ) : !data?.length ? (
          <EmptyState message="No accounts found for this filter." />
        ) : (
          <Table>
            <THead>
              <TH>Account Number</TH>
              <TH>Account Name</TH>
              <TH>CCY</TH>
              <TH numeric>Available Bal</TH>
              <TH numeric>Effective Available</TH>
              <TH numeric>Clear Balance</TH>
              <TH numeric>Funds in Clearing</TH>
              <TH numeric>FD Balance</TH>
            </THead>
            <TBody>
              {data.map((a) => (
                <TR key={a.id}>
                  <TD className="tabular">{a.accountNumber}</TD>
                  <TD>{a.accountName}</TD>
                  <TD>{a.currency}</TD>
                  <TD numeric>{formatPaise(a.availableBalance)}</TD>
                  <TD numeric>{formatPaise(a.effectiveAvailable)}</TD>
                  <TD numeric>{formatPaise(a.clearBalance)}</TD>
                  <TD numeric>{formatPaise(a.fundsInClearing)}</TD>
                  <TD numeric>{formatPaise(a.fdBalance)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </div>
  );
}
