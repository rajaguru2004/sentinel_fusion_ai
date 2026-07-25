'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, AlertTriangle, Pencil, Plus, ArrowLeft } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Badge } from '@/components/ui/Badge';
import { Stepper } from '@/components/ui/Stepper';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/Table';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import type { BeneficiaryRow } from '@/lib/types';

const RAILS = ['IFT', 'RTGS', 'NEFT', 'IMPS'] as const;
type Rail = (typeof RAILS)[number];

interface Form {
  code: string;
  name: string;
  accountNumber: string;
  confirmAccountNumber: string;
  ifsc: string;
  state: string;
  city: string;
  email: string;
  phone: string;
}

const EMPTY: Form = {
  code: '', name: '', accountNumber: '', confirmAccountNumber: '',
  ifsc: '', state: '', city: '', email: '', phone: '',
};

const railOf = (b: BeneficiaryRow): Rail | null =>
  b.allowIFT ? 'IFT' : b.allowRTGS ? 'RTGS' : b.allowNEFT ? 'NEFT' : b.allowIMPS ? 'IMPS' : null;

export default function BeneficiaryMaintenancePage() {
  const qc = useQueryClient();
  const [view, setView] = useState<'list' | 'form'>('list');
  const [step, setStep] = useState(0);
  const [editId, setEditId] = useState<string | null>(null);
  const [rail, setRail] = useState<Rail | null>(null);
  const [form, setForm] = useState<Form>(EMPTY);
  const [fetchedName, setFetchedName] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: existing } = useQuery<BeneficiaryRow[]>({
    queryKey: ['beneficiaries', 'maintenance'],
    queryFn: async () => (await api.get('/beneficiaries')).data,
  });

  const nonIft = rail === 'RTGS' || rail === 'NEFT' || rail === 'IMPS';
  const set = (k: keyof Form, v: string): void => setForm((f) => ({ ...f, [k]: v }));

  const mismatch = fetchedName && form.name && fetchedName.toLowerCase() !== form.name.toLowerCase();

  const reset = (): void => {
    setEditId(null);
    setForm(EMPTY);
    setRail(null);
    setFetchedName(null);
    setStep(0);
    setView('list');
  };

  const startAdd = (): void => {
    setEditId(null);
    setForm(EMPTY);
    setRail(null);
    setFetchedName(null);
    setStep(0);
    setView('form');
  };

  const startEdit = (b: BeneficiaryRow): void => {
    setEditId(b.id);
    setRail(railOf(b));
    setForm({
      code: b.code,
      name: b.name,
      accountNumber: b.accountNumber,
      confirmAccountNumber: b.accountNumber,
      ifsc: b.ifsc ?? '',
      state: b.state ?? '',
      city: b.city ?? '',
      email: b.email ?? '',
      phone: b.phone ?? '',
    });
    setFetchedName(b.nameAsFetched ?? null);
    setStep(0);
    setView('form');
    if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const fetchBeneficiary = async (): Promise<void> => {
    if (!form.accountNumber) return void toast.error('Enter an account number first');
    try {
      const { data } = await api.post('/beneficiaries/fetch-name', {
        accountNumber: form.accountNumber,
        ifsc: form.ifsc,
      });
      setFetchedName(data.nameAsFetched);
    } catch (e) {
      toast.error(apiError(e));
    }
  };

  const validateAndNext = (): void => {
    if (!form.code || !form.name || !form.accountNumber) return void toast.error('Fill required fields');
    if (!rail) return void toast.error('Select a Transaction Type');
    if (nonIft && form.accountNumber !== form.confirmAccountNumber)
      return void toast.error('Account numbers do not match');
    if (nonIft && !form.ifsc) return void toast.error('IFSC is required for non-IFT types');
    setStep(1);
  };

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    const payload = {
      code: form.code,
      name: form.name,
      accountNumber: form.accountNumber,
      ifsc: form.ifsc || undefined,
      isOwnBank: rail === 'IFT',
      allowIFT: rail === 'IFT',
      allowRTGS: rail === 'RTGS',
      allowNEFT: rail === 'NEFT',
      allowIMPS: rail === 'IMPS',
      state: form.state || undefined,
      city: form.city || undefined,
      phone: form.phone || undefined,
      email: form.email || undefined,
      nameAsFetched: fetchedName || undefined,
    };
    try {
      if (editId) {
        await api.put(`/beneficiaries/${editId}`, payload);
        toast.success('Beneficiary updated — re-activation required');
      } else {
        await api.post('/beneficiaries', payload);
        toast.success('Beneficiary added — pending activation');
      }
      qc.invalidateQueries({ queryKey: ['beneficiaries'] });
      reset();
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (view === 'list') {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader
          title="Beneficiary Maintenance"
          description="Manage your payees. Add a new beneficiary or edit an existing one."
          actions={
            <Button onClick={startAdd}>
              <Plus className="h-4 w-4" /> Add New
            </Button>
          }
        />

        <Card title={`Beneficiaries (${existing?.length ?? 0})`}>
          {!existing?.length ? (
            <EmptyState message="No beneficiaries yet. Use “Add New” to create one." />
          ) : (
            <Table>
              <THead>
                <TH>Code</TH>
                <TH>Name</TH>
                <TH>Account</TH>
                <TH>Type</TH>
                <TH>Status</TH>
                <TH></TH>
              </THead>
              <TBody>
                {existing.map((b) => (
                  <TR key={b.id}>
                    <TD className="tabular">{b.code}</TD>
                    <TD>{b.name}</TD>
                    <TD className="tabular">{b.accountNumber}</TD>
                    <TD className="text-xs">{railOf(b) ?? '—'}</TD>
                    <TD>
                      <Badge tone={b.status === 'ACTIVE' ? 'success' : b.status === 'PENDING' ? 'warning' : 'neutral'}>
                        {b.status}
                      </Badge>
                    </TD>
                    <TD>
                      <Button variant="outline" size="sm" onClick={() => startEdit(b)}>
                        <Pencil className="h-3.5 w-3.5" /> Edit
                      </Button>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={editId ? 'Edit Beneficiary' : 'Add Beneficiary'}
        description={
          editId
            ? 'Editing an existing beneficiary. Saving resets it to Pending — it must be re-activated before use.'
            : 'Add a payee. New beneficiaries need activation before use.'
        }
        actions={
          <Button variant="ghost" size="sm" onClick={reset}>
            <ArrowLeft className="h-4 w-4" /> Back to list
          </Button>
        }
      />

      <div className="mb-6">
        <Stepper steps={['Initiate', 'Confirmation']} current={step} />
      </div>

      {step === 0 ? (
        <div className="space-y-6">
          <Card title="Beneficiary Details">
            <div className="grid gap-4 md:grid-cols-2">
              <Input
                label="Beneficiary Code"
                required
                value={form.code}
                disabled={!!editId}
                onChange={(e) => set('code', e.target.value)}
              />
              <Input label="Beneficiary Name" required value={form.name} onChange={(e) => set('name', e.target.value)} />
              <Input label="State" value={form.state} onChange={(e) => set('state', e.target.value)} />
              <Input label="City" value={form.city} onChange={(e) => set('city', e.target.value)} />
              <Input label="Email ID" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
              <Input label="Phone" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
            </div>
          </Card>

          <Card title="Transaction Type">
            <div className="flex flex-wrap gap-4">
              {RAILS.map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm text-text">
                  <input type="radio" name="rail" checked={rail === r} onChange={() => setRail(r)} className="accent-primary" />
                  {r}
                </label>
              ))}
            </div>
          </Card>

          {nonIft && (
            <Card title="Bank Details" actions={<Button variant="outline" size="sm" onClick={fetchBeneficiary}><Search className="h-4 w-4" /> Fetch Beneficiary</Button>}>
              <div className="grid gap-4 md:grid-cols-2">
                <Input label="Account Number" required value={form.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} />
                <Input label="Confirm Account Number" required value={form.confirmAccountNumber} onChange={(e) => set('confirmAccountNumber', e.target.value)} />
                <Input label="IFSC Code" required value={form.ifsc} onChange={(e) => set('ifsc', e.target.value.toUpperCase())} />
                {fetchedName && (
                  <div className="flex flex-col gap-1.5">
                    <span className="text-sm font-medium text-text">Beneficiary Name as Fetched</span>
                    <div className="flex h-10 items-center gap-2 rounded-[var(--radius-input)] border border-border bg-bg px-3 text-sm">
                      {fetchedName}
                      {mismatch && <Badge tone="danger"><AlertTriangle className="h-3 w-3" /> mismatch</Badge>}
                    </div>
                  </div>
                )}
              </div>
              {mismatch && (
                <p className="mt-3 text-xs text-risk-critical">
                  Fetched name differs from the entered name — this is flagged as a fraud signal.
                </p>
              )}
            </Card>
          )}

          {rail === 'IFT' && (
            <Card title="Own-bank Account">
              <div className="grid gap-4 md:grid-cols-2">
                <Input label="Account Number" required value={form.accountNumber} onChange={(e) => set('accountNumber', e.target.value)} />
                <Input label="Confirm Account Number" value={form.confirmAccountNumber} onChange={(e) => set('confirmAccountNumber', e.target.value)} />
              </div>
            </Card>
          )}

          <div className="flex gap-2">
            <Button onClick={validateAndNext}>Next</Button>
            <Button variant="ghost" onClick={reset}>Cancel</Button>
          </div>
        </div>
      ) : (
        <Card title={editId ? 'Confirm changes' : 'Confirm beneficiary'}>
          <dl className="grid gap-3 text-sm md:grid-cols-2">
            <Detail label="Code" value={form.code} />
            <Detail label="Name" value={form.name} />
            <Detail label="Account Number" value={form.accountNumber} />
            <Detail label="IFSC" value={form.ifsc || '—'} />
            <Detail label="Transaction Type" value={rail || '—'} />
            <Detail label="Name as Fetched" value={fetchedName || '—'} />
          </dl>
          {editId && (
            <p className="mt-4 text-xs text-text-muted">
              Saving these changes resets the beneficiary to <strong>Pending</strong> — re-activate it before use.
            </p>
          )}
          <div className="mt-6 flex gap-2">
            <Button variant="outline" onClick={() => setStep(0)}>Back</Button>
            <Button onClick={submit} disabled={submitting}>
              {submitting ? 'Saving…' : editId ? 'Confirm & Update' : 'Confirm & Add'}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-text-muted">{label}</dt>
      <dd className="font-medium text-text">{value}</dd>
    </div>
  );
}
