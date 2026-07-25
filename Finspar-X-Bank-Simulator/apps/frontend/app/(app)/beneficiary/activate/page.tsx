'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/Table';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import type { BeneficiaryRow } from '@/lib/types';

export default function ActivateBeneficiaryPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data } = useQuery<BeneficiaryRow[]>({
    queryKey: ['beneficiaries', 'PENDING'],
    queryFn: async () => (await api.get('/beneficiaries?status=PENDING')).data,
  });

  const toggle = (id: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const act = async (action: 'activate' | 'reject'): Promise<void> => {
    if (selected.size === 0) return void toast.error('Select at least one beneficiary');
    try {
      const { data: res } = await api.post(`/beneficiaries/${action}`, { ids: [...selected] });
      toast.success(action === 'activate' ? `Activated ${res.activated}` : `Rejected ${res.rejected}`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['beneficiaries'] });
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Activate Beneficiary"
        description="Activate pending beneficiaries. Newly activated payees are high-risk for 30 minutes."
        actions={
          <>
            <Button variant="outline" onClick={() => act('reject')}>Reject</Button>
            <Button onClick={() => act('activate')}>Activate</Button>
          </>
        }
      />
      <Card title={`Number of Beneficiaries found: ${data?.length ?? 0}`}>
        {!data?.length ? (
          <EmptyState message="No pending beneficiaries to activate." />
        ) : (
          <Table>
            <THead>
              <TH></TH>
              <TH>Code</TH>
              <TH>Name</TH>
              <TH>Account</TH>
              <TH>IFSC</TH>
              <TH>Rails</TH>
              <TH>Status</TH>
            </THead>
            <TBody>
              {data.map((b) => (
                <TR key={b.id}>
                  <TD>
                    <input type="checkbox" checked={selected.has(b.id)} onChange={() => toggle(b.id)} className="accent-primary" />
                  </TD>
                  <TD className="tabular">{b.code}</TD>
                  <TD>{b.name}</TD>
                  <TD className="tabular">{b.accountNumber}</TD>
                  <TD className="tabular">{b.ifsc ?? '—'}</TD>
                  <TD className="text-xs">{[b.allowIFT && 'IFT', b.allowRTGS && 'RTGS', b.allowNEFT && 'NEFT', b.allowIMPS && 'IMPS'].filter(Boolean).join(', ')}</TD>
                  <TD><Badge tone="warning">{b.status}</Badge></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
