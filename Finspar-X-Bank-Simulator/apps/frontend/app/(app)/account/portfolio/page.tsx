'use client';

import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/Card';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/Table';
import { PageHeader } from '@/components/PageHeader';
import { api } from '@/lib/api';
import { formatPaise } from '@/lib/format';
import { useAuthStore } from '@/lib/auth-store';
import type { PortfolioRow } from '@/lib/types';

export default function PortfolioPage() {
  const user = useAuthStore((s) => s.user);
  const { data } = useQuery<PortfolioRow[]>({
    queryKey: ['portfolio'],
    queryFn: async () => (await api.get('/accounts/portfolio')).data,
  });

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Portfolio Statement" description={`Customer ${user?.customerId}`} />
      <Card title="Portfolio">
        {!data?.length ? (
          <EmptyState message="No accounts found." />
        ) : (
          <Table>
            <THead>
              <TH>Account Name</TH>
              <TH>Account Number</TH>
              <TH numeric>Available Amount</TH>
              <TH>Currency</TH>
              <TH>Scheme Type</TH>
            </THead>
            <TBody>
              {data.map((r) => (
                <TR key={r.accountNumber}>
                  <TD>{r.accountName}</TD>
                  <TD className="tabular">{r.accountNumber}</TD>
                  <TD numeric>{formatPaise(r.availableAmount)}</TD>
                  <TD>{r.currency}</TD>
                  <TD>{r.schemeType ?? '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
