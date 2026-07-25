'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import { RiskBadge } from '@/components/ui/Badge';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/Table';
import { PageHeader } from '@/components/PageHeader';
import { api } from '@/lib/api';
import { formatPaise, formatDateDMY } from '@/lib/format';
import type { AccountBalance, StatementRow } from '@/lib/types';

export default function MiniStatementPage() {
  const { data: accounts } = useQuery<AccountBalance[]>({
    queryKey: ['balances', 'DEPOSIT'],
    queryFn: async () => (await api.get('/accounts/balance?accountType=DEPOSIT')).data,
  });
  const [accountNumber, setAccountNumber] = useState('');
  const acc = accountNumber || accounts?.[0]?.accountNumber || '';

  const { data } = useQuery<StatementRow[]>({
    queryKey: ['mini', acc],
    queryFn: async () => (await api.get(`/accounts/mini-statement?accountNumber=${acc}&n=10`)).data,
    enabled: !!acc,
  });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Mini Statement" description="Last 10 transactions. Table view only." />
      <Card title="Account">
        <Select
          value={acc}
          onChange={(e) => setAccountNumber(e.target.value)}
          options={(accounts ?? []).map((a) => ({ value: a.accountNumber, label: `${a.accountNumber} — ${a.accountName}` }))}
        />
      </Card>
      <div className="mt-6">
        {!data?.length ? (
          <EmptyState message="No recent transactions." />
        ) : (
          <Table>
            <THead>
              <TH>Date</TH>
              <TH>Description</TH>
              <TH numeric>Amount</TH>
              <TH>Dir</TH>
              <TH numeric>Balance</TH>
              <TH numeric>Risk</TH>
            </THead>
            <TBody>
              {data.map((r) => (
                <TR key={r.id}>
                  <TD className="tabular">{formatDateDMY(r.date)}</TD>
                  <TD>{r.description}</TD>
                  <TD numeric>{formatPaise(r.amount)}</TD>
                  <TD>{r.direction === 'DEBIT' ? 'Dr' : 'Cr'}</TD>
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
