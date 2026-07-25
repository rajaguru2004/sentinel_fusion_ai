'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/Table';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import type { BeneficiaryRow } from '@/lib/types';

const toneFor = (s: string) => (s === 'ACTIVE' ? 'success' : s === 'PENDING' ? 'warning' : 'neutral');

export default function DeleteBeneficiaryPage() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);

  const { data } = useQuery<BeneficiaryRow[]>({
    queryKey: ['beneficiaries', 'all'],
    queryFn: async () => (await api.get('/beneficiaries')).data,
  });

  const toggle = (id: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const remove = async (): Promise<void> => {
    try {
      const { data: res } = await api.post('/beneficiaries/delete', { ids: [...selected] });
      toast.success(`Deleted ${res.deleted}`);
      setSelected(new Set());
      setConfirm(false);
      qc.invalidateQueries({ queryKey: ['beneficiaries'] });
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Delete Beneficiary"
        description="Soft-delete beneficiaries. Historical transactions keep their reference."
        actions={<Button variant="danger" onClick={() => (selected.size ? setConfirm(true) : toast.error('Select at least one'))}>Delete</Button>}
      />
      <Card title={`Beneficiaries: ${data?.length ?? 0}`}>
        {!data?.length ? (
          <EmptyState message="No beneficiaries." />
        ) : (
          <Table>
            <THead>
              <TH></TH>
              <TH>Code</TH>
              <TH>Name</TH>
              <TH>Account</TH>
              <TH>Status</TH>
            </THead>
            <TBody>
              {data.map((b) => (
                <TR key={b.id}>
                  <TD><input type="checkbox" checked={selected.has(b.id)} onChange={() => toggle(b.id)} className="accent-primary" /></TD>
                  <TD className="tabular">{b.code}</TD>
                  <TD>{b.name}</TD>
                  <TD className="tabular">{b.accountNumber}</TD>
                  <TD><Badge tone={toneFor(b.status)}>{b.status}</Badge></TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Delete beneficiaries?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(false)}>Cancel</Button>
            <Button variant="danger" onClick={remove}>Delete {selected.size}</Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">
          This soft-deletes {selected.size} beneficiary(ies). They can no longer receive transfers, but
          historical records are retained.
        </p>
      </Modal>
    </div>
  );
}
