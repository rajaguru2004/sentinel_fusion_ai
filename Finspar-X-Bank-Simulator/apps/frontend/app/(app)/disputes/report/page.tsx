'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import type { AccountBalance } from '@/lib/types';

const FRAUD_TYPES = ['Unauthorized transaction', 'Phishing', 'Account takeover', 'Card fraud', 'Other'];

export default function ReportFraudPage() {
  const { data: accounts } = useQuery<AccountBalance[]>({
    queryKey: ['balances', 'DEPOSIT'],
    queryFn: async () => (await api.get('/accounts/balance?accountType=DEPOSIT')).data,
  });

  const [f, setF] = useState({ accountNumber: '', transactionRef: '', amount: '', fraudType: FRAUD_TYPES[0], transactionDate: '', additionalDetail: '' });
  const [result, setResult] = useState<{ trackingRef: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF((s) => ({ ...s, [k]: v }));

  const submit = async (): Promise<void> => {
    if (!f.accountNumber || !f.transactionRef || !f.amount || !f.transactionDate || !f.additionalDetail)
      return void toast.error('Fill all required fields');
    setBusy(true);
    try {
      const { data } = await api.post('/disputes/report', {
        applicationName: 'Internet Banking',
        accountNumber: f.accountNumber,
        transactionRef: f.transactionRef,
        currency: 'INR',
        amount: Number(f.amount),
        fraudType: f.fraudType,
        transactionDate: f.transactionDate,
        additionalDetail: f.additionalDetail,
      });
      setResult(data);
      toast.success('Report submitted');
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };

  if (result) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Report Fraudulent Transaction" />
        <Card>
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <CheckCircle2 className="h-10 w-10 text-risk-low" />
            <p className="font-medium text-text">Report submitted — account frozen for investigation</p>
            <p className="tabular text-sm text-text-muted">Tracking Reference: {result.trackingRef}</p>
            <p className="text-xs text-text-muted">Track progress under Dispute Resolution → Track Request.</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Report Fraudulent Transaction" />
      <div className="mb-6 flex items-start gap-3 rounded-[var(--radius-card)] border border-risk-high/30 bg-risk-high/5 p-4">
        <AlertTriangle className="h-5 w-5 shrink-0 text-risk-high" />
        <p className="text-sm text-risk-high">
          Submitting triggers an immediate debit freeze and net-banking deactivation until the
          investigation completes.
        </p>
      </div>
      <Card title="Transaction details">
        <div className="grid gap-4 md:grid-cols-2">
          <Select label="Account" required value={f.accountNumber} onChange={(e) => set('accountNumber', e.target.value)}
            options={[{ value: '', label: 'Select account' }, ...(accounts ?? []).map((a) => ({ value: a.accountNumber, label: a.accountNumber }))]} />
          <Input label="Transaction Ref No." required value={f.transactionRef} onChange={(e) => set('transactionRef', e.target.value)} />
          <Input label="Amount" required type="number" value={f.amount} onChange={(e) => set('amount', e.target.value)} />
          <Select label="Fraud Type" required value={f.fraudType} onChange={(e) => set('fraudType', e.target.value)}
            options={FRAUD_TYPES.map((t) => ({ value: t, label: t }))} />
          <Input label="Transaction Date" required type="date" value={f.transactionDate} onChange={(e) => set('transactionDate', e.target.value)} />
        </div>
        <div className="mt-4">
          <label className="text-sm font-medium text-text">Additional Detail<span className="ml-0.5 text-text-muted">*</span></label>
          <textarea value={f.additionalDetail} onChange={(e) => set('additionalDetail', e.target.value)}
            className="mt-1.5 h-24 w-full rounded-[var(--radius-input)] border border-border bg-surface p-3 text-sm text-text focus:outline-none focus:ring-2 focus:ring-accent" />
        </div>
        <div className="mt-4 flex gap-2">
          <Button variant="danger" onClick={submit} disabled={busy}>Submit report</Button>
        </div>
      </Card>
    </div>
  );
}
