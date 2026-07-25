'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Building2, Landmark, Send, Zap, PauseCircle, ShieldX, CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Stepper } from '@/components/ui/Stepper';
import { RiskMeter } from '@/components/RiskMeter';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import { formatPaise, formatINR } from '@/lib/format';
import type { AccountBalance, BeneficiaryRow } from '@/lib/types';

type Rail = 'IFT' | 'RTGS' | 'NEFT' | 'IMPS';
const MODES: { rail: Rail; label: string; icon: typeof Send }[] = [
  { rail: 'IFT', label: 'Fund Transfer - Own Bank Account', icon: Building2 },
  { rail: 'RTGS', label: 'Fund Transfer - Other Bank (RTGS)', icon: Landmark },
  { rail: 'NEFT', label: 'Fund Transfer - Other Bank (NEFT)', icon: Send },
  { rail: 'IMPS', label: 'IMPS', icon: Zap },
];

const RAIL_FIELD: Record<Rail, keyof BeneficiaryRow> = {
  IFT: 'allowIFT', RTGS: 'allowRTGS', NEFT: 'allowNEFT', IMPS: 'allowIMPS',
};

interface Risk { riskScore: number; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; reasons: string[] }
interface ConfirmResult extends Risk { outcome: string; otpRequestId?: string }

export default function InitiatePaymentsPage() {
  const [rail, setRail] = useState<Rail | null>(null);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<any>(null);
  const [confirmRes, setConfirmRes] = useState<ConfirmResult | null>(null);
  const [otpOpen, setOtpOpen] = useState(false);
  const [finalRes, setFinalRes] = useState<any>(null);

  const [custRef, setCustRef] = useState('');
  const [amount, setAmount] = useState('');
  const [debitAccountId, setDebitAccountId] = useState('');
  const [beneficiaryId, setBeneficiaryId] = useState('');
  const [remarks, setRemarks] = useState('');
  const [txnPassword, setTxnPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: accounts } = useQuery<AccountBalance[]>({
    queryKey: ['balances', 'DEPOSIT'],
    queryFn: async () => (await api.get('/accounts/balance?accountType=DEPOSIT')).data,
  });
  const { data: benes } = useQuery<BeneficiaryRow[]>({
    queryKey: ['beneficiaries', 'ACTIVE'],
    queryFn: async () => (await api.get('/beneficiaries?status=ACTIVE')).data,
  });

  const eligibleBenes = (benes ?? []).filter((b) => rail && b[RAIL_FIELD[rail]]);
  const selectedBene = benes?.find((b) => b.id === beneficiaryId);
  const selectedAccount = accounts?.find((a) => a.id === debitAccountId);

  const reset = (): void => {
    setStep(0); setDraft(null); setConfirmRes(null); setFinalRes(null);
    setCustRef(''); setAmount(''); setBeneficiaryId(''); setRemarks(''); setTxnPassword(''); setOtp('');
  };

  const initiate = async (): Promise<void> => {
    if (!custRef || !amount || !debitAccountId || !beneficiaryId) return void toast.error('Fill all required fields');
    setBusy(true);
    try {
      const { data } = await api.post('/payments', {
        custRefNo: custRef, amount: Number(amount), debitAccountId, beneficiaryId, rail, remarks,
      });
      setDraft(data);
      setStep(1);
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };

  const confirm = async (): Promise<void> => {
    setBusy(true);
    try {
      const { data } = await api.post<ConfirmResult>(`/payments/${draft.id}/confirm`, {});
      setConfirmRes(data);
      if (data.outcome === 'OTP' || data.outcome === 'CHALLENGE') setOtpOpen(true);
      else { setFinalRes(data); setStep(2); } // HELD / BLOCKED
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const { data } = await api.post(`/payments/${draft.id}/submit`, {
        txnPassword, otpRequestId: confirmRes!.otpRequestId, code: otp,
      });
      setFinalRes({ ...data, ...confirmRes });
      setOtpOpen(false);
      setStep(2);
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };

  const resend = async (): Promise<void> => {
    try {
      const { data } = await api.post('/auth/recovery/resend', { requestId: confirmRes!.otpRequestId });
      setConfirmRes((r) => (r ? { ...r, otpRequestId: data.requestId } : r));
      toast.success('OTP resent');
    } catch (e) { toast.error(apiError(e)); }
  };

  // --- Mode selection ---
  if (!rail) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Initiate Payments" description="Choose a payment mode." />
        <Card title="Payment Mode">
          <div className="grid gap-3 sm:grid-cols-3">
            {MODES.map((m) => {
              const Icon = m.icon;
              return (
                <button key={m.rail} onClick={() => setRail(m.rail)}
                  className="flex flex-col items-start gap-2 rounded-[var(--radius-card)] border border-border bg-surface p-4 text-left hover:border-primary hover:shadow-sm">
                  <Icon className="h-5 w-5 text-primary" />
                  <span className="text-sm font-medium text-text">{m.label}</span>
                  <span className="text-xs text-text-muted">{m.rail}</span>
                </button>
              );
            })}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Initiate Payments"
        actions={<Button variant="ghost" size="sm" onClick={() => { setRail(null); reset(); }}><ArrowLeft className="h-4 w-4" /> Back</Button>}
      />
      <div className="mb-6"><Stepper steps={['Initiate Payment', 'Preview', 'Confirmation']} current={step} /></div>

      {step === 0 && (
        <div className="space-y-6">
          <Card title={`Initiate Payment — ${rail}`}>
            <div className="grid gap-4 md:grid-cols-2">
              <Input label="Cust Ref #" required value={custRef} onChange={(e) => setCustRef(e.target.value)} />
              <Input label="Amount (INR)" required type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <Select label="Debit Account" required value={debitAccountId} onChange={(e) => setDebitAccountId(e.target.value)}
                options={[{ value: '', label: 'Select account' }, ...(accounts ?? []).map((a) => ({ value: a.id, label: `${a.accountNumber} — Bal ${formatPaise(a.availableBalance)}` }))]} />
              <Input label="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
            {amount && <p className="mt-3 text-xs text-text-muted">In words: {Number(amount) > 0 ? `${formatINR(Number(amount))}` : ''}</p>}
          </Card>

          <Card title="Beneficiary Details">
            <Select label="Beneficiary" required value={beneficiaryId} onChange={(e) => setBeneficiaryId(e.target.value)}
              options={[{ value: '', label: 'Select beneficiary' }, ...eligibleBenes.map((b) => ({ value: b.id, label: `${b.code} — ${b.name}` }))]} />
            {selectedBene && (
              <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                <Field label="Name" value={selectedBene.name} />
                <Field label="Account Number" value={selectedBene.accountNumber} />
                <Field label="IFSC" value={selectedBene.ifsc ?? '—'} />
                <Field label="Name as fetched" value={selectedBene.nameAsFetched ?? '—'} />
              </div>
            )}
            {!eligibleBenes.length && <p className="mt-2 text-xs text-text-muted">No ACTIVE beneficiaries enabled for {rail}. Add one under Beneficiary → Maintenance.</p>}
          </Card>

          <div className="flex gap-2">
            <Button onClick={initiate} disabled={busy}>Next</Button>
            <Button variant="ghost" onClick={reset}>Cancel</Button>
          </div>
        </div>
      )}

      {step === 1 && draft && (
        <div className="space-y-6">
          <Card title="Payment Details">
            <div className="grid gap-3 text-sm md:grid-cols-2">
              <Field label="Reference" value={draft.refNo} />
              <Field label="Payment Mode" value={draft.paymentMode} />
              <Field label="Amount" value={formatPaise(draft.amount)} />
              <Field label="Amount in Words" value={draft.amountInWords} />
              <Field label="Debit Account" value={selectedAccount?.accountNumber ?? ''} />
              <Field label="Cust Ref #" value={draft.custRefNo} />
            </div>
          </Card>
          <Card title="Beneficiary Details">
            <div className="grid gap-3 text-sm md:grid-cols-2">
              <Field label="Name" value={draft.beneficiary?.name} />
              <Field label="Account Number" value={draft.beneficiary?.accountNumber} />
              <Field label="IFSC/NBIN" value={draft.beneficiary?.ifsc ?? '—'} />
              <Field label="Name as fetched" value={draft.beneficiary?.nameAsFetched ?? '—'} />
            </div>
          </Card>
          <p className="rounded-[var(--radius-input)] border border-risk-critical/30 bg-risk-critical/5 p-3 text-xs text-risk-critical">
            RTGS/NEFT fund transfers are effected solely on the beneficiary account number, not the beneficiary name.
          </p>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setStep(0)}>Back</Button>
            <Button onClick={confirm} disabled={busy}>Confirm</Button>
          </div>
        </div>
      )}

      {step === 2 && finalRes && (
        <Card title="Confirmation">
          <div className="flex flex-col items-center gap-4 py-4">
            {finalRes.outcome === 'BLOCKED' ? (
              <><ShieldX className="h-10 w-10 text-risk-critical" /><p className="font-medium text-risk-critical">Payment blocked — account frozen for review</p></>
            ) : finalRes.outcome === 'HELD' || finalRes.outcome === 'HELD_CUTOFF' ? (
              <><PauseCircle className="h-10 w-10 text-risk-high" /><p className="font-medium text-risk-high">Funds held{finalRes.reason ? ` — ${finalRes.reason}` : ' for analyst review'}</p></>
            ) : (
              <><CheckCircle2 className="h-10 w-10 text-risk-low" /><p className="font-medium text-risk-low">Payment {finalRes.status ?? 'submitted'}</p></>
            )}
            {finalRes.refNo && <p className="tabular text-sm text-text-muted">Reference: {finalRes.refNo}</p>}
            {confirmRes && <RiskMeter score={confirmRes.riskScore} level={confirmRes.riskLevel} reasons={confirmRes.reasons} />}
          </div>
          <div className="flex justify-center"><Button onClick={() => { setRail(null); reset(); }}>New Payment</Button></div>
        </Card>
      )}

      <Modal
        open={otpOpen}
        onClose={() => setOtpOpen(false)}
        title="Verify Transaction Password and OTP"
        footer={<><Button variant="ghost" onClick={() => setOtpOpen(false)}>Cancel</Button><Button onClick={submit} disabled={busy}>Submit</Button></>}
      >
        <div className="space-y-4">
          {confirmRes && (
            <div className="rounded-[var(--radius-input)] border border-border bg-bg p-3">
              <RiskMeter score={confirmRes.riskScore} level={confirmRes.riskLevel} reasons={confirmRes.reasons} />
              {confirmRes.outcome === 'CHALLENGE' && (
                <p className="mt-2 text-center text-xs text-risk-medium">Medium risk — a re-issued OTP is required.</p>
              )}
            </div>
          )}
          <Input label="Transaction Password" type="password" required value={txnPassword} onChange={(e) => setTxnPassword(e.target.value)} />
          <Input label="OTP" required value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="6-digit code" hint="Demo OTP: 123456" />
          <div className="flex items-center justify-between text-xs text-text-muted">
            <button onClick={resend} className="text-accent hover:underline">Resend OTP</button>
            <span>OTP Request ID: {confirmRes?.otpRequestId}</span>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function Field({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <p className="text-text-muted">{label}</p>
      <p className="font-medium text-text">{value ?? '—'}</p>
    </div>
  );
}
