'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Building2, Landmark, Send, Zap, PauseCircle, ShieldX, CheckCircle2, Wand2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { Stepper } from '@/components/ui/Stepper';
import { RiskMeter } from '@/components/RiskMeter';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import { useSingleFlight } from '@/lib/use-single-flight';
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

// Seeded demo credentials (apps/backend/prisma/seed.ts). Demo-only convenience —
// the fill buttons below pre-populate them so the whole flow can be exercised
// without retyping on every run.
const DEMO_TXN_PASSWORD = 'Txn@12345';
const DEMO_OTP = '123456';

type DemoPreset = 'LOW' | 'CRITICAL';

/**
 * The model does not score the amount in isolation — it scores the event against
 * what this customer normally does: how many payments in the past hour, whether
 * the payee is one it has seen, how far the amount sits from their mean, the hour
 * of day. So the presets are derived from the customer's OWN payment history
 * rather than hardcoded, and each one moves several signals together:
 *
 *   LOW      — a payee already paid before, an amount near the customer's mean.
 *   CRITICAL — a name-mismatched (or just-activated) payee, an amount far outside
 *              the customer's range.
 *
 * Velocity is the one signal a form cannot set: it counts payments already scored
 * in the past hour, so a burst of demo runs raises the score no matter what is
 * filled in. fillDemo() warns when that is about to distort the result.
 */
const DEMO_MEAN_FALLBACK = 250_000; // rupees, when the customer has no settled history
const LOW_MEAN_FRACTION = 0.6; // comfortably inside "normal spend"
const CRITICAL_MEAN_MULTIPLE = 12;
/** Fraction of the debit account drained — trips the model's balance-drain feature. */
const CRITICAL_BALANCE_FRACTION = 0.95;
/**
 * Scored payments in the last hour past which velocity dominates the verdict.
 * Measured against the live model: the payment-shape signals (fresh payee, name
 * mismatch, balance drain, amount far outside range) top out around HIGH on
 * their own; adding velocity is what carries the event into CRITICAL/BLOCK.
 */
const VELOCITY_WARN_AT = 3;

const beneAgeMinutes = (b: BeneficiaryRow): number =>
  b.activatedAt ? (Date.now() - new Date(b.activatedAt).getTime()) / 60000 : Infinity;
/** Mirrors the backend's nameMismatch check (payments.service.ts confirm()). */
const hasNameMismatch = (b: BeneficiaryRow): boolean =>
  !!b.nameAsFetched && b.name.toLowerCase() !== b.nameAsFetched.toLowerCase();
const allowedRails = (b: BeneficiaryRow): Rail[] =>
  (Object.keys(RAIL_FIELD) as Rail[]).filter((r) => b[RAIL_FIELD[r]]);

interface Risk { riskScore: number; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; reasons: string[] }
interface ConfirmResult extends Risk { outcome: string; otpRequestId?: string }

/** Subset of the payments list used to profile "normal" for this customer. */
interface HistoryRow {
  amount: string; // paise
  status: string;
  riskLevel: string | null;
  beneficiaryName: string;
  transactionDate: string;
}

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

  const { data: accounts } = useQuery<AccountBalance[]>({
    queryKey: ['balances', 'DEPOSIT'],
    queryFn: async () => (await api.get('/accounts/balance?accountType=DEPOSIT')).data,
  });
  const { data: benes } = useQuery<BeneficiaryRow[]>({
    queryKey: ['beneficiaries', 'ACTIVE'],
    queryFn: async () => (await api.get('/beneficiaries?status=ACTIVE')).data,
  });

  // Demo-fill only: what the customer's normal looks like, so the presets can be
  // built from it instead of from constants that drift out of date with the data.
  const { data: history } = useQuery<HistoryRow[]>({
    queryKey: ['payments', 'profile'],
    queryFn: async () => (await api.get('/payments')).data,
    staleTime: 30_000,
  });

  const settled = (history ?? []).filter((p) => p.status === 'COMPLETED');
  const meanRupees =
    settled.length > 0
      ? settled.reduce((sum, p) => sum + Number(p.amount) / 100, 0) / settled.length
      : DEMO_MEAN_FALLBACK;
  /** Payments already put through the fraud gateway this hour = the velocity the model sees. */
  const scoredLastHour = (history ?? []).filter(
    (p) => p.riskLevel && Date.now() - new Date(p.transactionDate).getTime() < 3_600_000,
  ).length;
  const paidCount = new Map<string, number>();
  for (const p of settled) paidCount.set(p.beneficiaryName, (paidCount.get(p.beneficiaryName) ?? 0) + 1);

  const eligibleBenes = (benes ?? []).filter((b) => rail && b[RAIL_FIELD[rail]]);
  const selectedBene = benes?.find((b) => b.id === beneficiaryId);
  const selectedAccount = accounts?.find((a) => a.id === debitAccountId);

  const reset = (): void => {
    setStep(0); setDraft(null); setConfirmRes(null); setFinalRes(null);
    setCustRef(''); setAmount(''); setBeneficiaryId(''); setRemarks(''); setTxnPassword(''); setOtp('');
  };

  /**
   * LOW wants the most boring payee available: one this customer has actually
   * paid before (so it is in the model's payee set), matching fetched name, past
   * the cooling window. CRITICAL wants one carrying a fraud signal of its own —
   * a name mismatch first, otherwise one still inside the 30-min cooling window.
   */
  const pickDemoBene = (preset: DemoPreset): BeneficiaryRow | undefined => {
    const pool = (benes ?? []).filter((b) => b.status === 'ACTIVE');
    const onRail = pool.filter((b) => rail && b[RAIL_FIELD[rail]]);
    if (preset === 'LOW') {
      const familiar = onRail
        .filter((b) => !hasNameMismatch(b) && beneAgeMinutes(b) > 60)
        .sort((a, b) => (paidCount.get(b.name) ?? 0) - (paidCount.get(a.name) ?? 0));
      return familiar[0] ?? onRail.find((b) => !hasNameMismatch(b)) ?? onRail[0];
    }
    // Strongest available payee signal, in order: name mismatch, still inside the
    // 30-min cooling window, never paid before ("first ever payment to this
    // beneficiary"), else the most recently activated one.
    const risky = (list: BeneficiaryRow[]): BeneficiaryRow | undefined =>
      list.find(hasNameMismatch) ??
      list.find((b) => beneAgeMinutes(b) < 30) ??
      list.find((b) => !paidCount.has(b.name)) ??
      list.slice().sort((a, b) => beneAgeMinutes(a) - beneAgeMinutes(b))[0];
    // Current rail first, then any rail — switching the rail beats filling data
    // that would score LOW and demonstrate nothing.
    return risky(onRail) ?? risky(pool);
  };

  const demoAmount = (preset: DemoPreset, account: AccountBalance): number => {
    const availableRupees = Number(account.availableBalance) / 100;
    if (preset === 'LOW') {
      // Half the available balance is the ceiling: above that the model starts
      // reporting "amount is N% of the available balance", which is exactly the
      // kind of signal a LOW demo should not be raising.
      const target = Math.min(meanRupees * LOW_MEAN_FRACTION, availableRupees * 0.5);
      return Math.max(1000, Math.round(target / 1000) * 1000);
    }
    // Near-total drain of the debit account: pushes the amount far outside the
    // customer's range AND trips the balance-drain feature, two signals for one
    // field. Floored at 12x the mean so a fat account still reads as abnormal.
    const drain = (Number(account.availableBalance) / 100) * CRITICAL_BALANCE_FRACTION;
    return Math.max(Math.round((meanRupees * CRITICAL_MEAN_MULTIPLE) / 1000) * 1000, Math.round(drain / 1000) * 1000);
  };

  const fillDemo = (preset: DemoPreset): void => {
    // A LOW demo is supposed to end in a posted payment, and the ledger debits
    // against clearBalance - holdAmount. Held payments can push that below zero
    // on the largest account, so pick the richest account by AVAILABLE balance
    // rather than the first one listed. CRITICAL never reaches the ledger, so it
    // deliberately keeps the largest account for the biggest drain signal.
    const byAvailable = [...(accounts ?? [])].sort(
      (a, b) => Number(b.availableBalance) - Number(a.availableBalance),
    );
    const account = preset === 'LOW' ? byAvailable[0] : (accounts?.[0] ?? byAvailable[0]);
    if (!account) return void toast.error('No debit account loaded yet');
    const bene = pickDemoBene(preset);
    if (!bene) {
      return void toast.error(
        preset === 'LOW'
          ? `No ACTIVE beneficiary enabled for ${rail}`
          : 'No high-risk beneficiary in the data — seed the demo dataset first',
      );
    }
    const beneRails = allowedRails(bene);
    if (rail && !beneRails.includes(rail)) {
      setRail(beneRails[0]);
      toast.info(`Switched to ${beneRails[0]} — ${bene.code} is the high-risk payee`);
    }
    const value = demoAmount(preset, account);
    setCustRef(`DEMO-${Date.now().toString().slice(-8)}`);
    setAmount(String(value));
    setDebitAccountId(account.id);
    setBeneficiaryId(bene.id);
    setRemarks(preset === 'LOW' ? 'Demo payment — routine supplier invoice' : 'Demo payment — high-value, unfamiliar payee');
    setTxnPassword(DEMO_TXN_PASSWORD);
    setOtp(DEMO_OTP);
    toast.success(`${preset === 'LOW' ? 'Low' : 'High'}-risk demo filled — ${bene.code}, ${formatINR(value)}`);

    // Velocity is history, not form data: nothing filled here can pull the score
    // down once the customer already looks like they are firing off payments —
    // and nothing else can push it all the way up either.
    if (preset === 'LOW' && scoredLastHour >= VELOCITY_WARN_AT) {
      toast.warning(
        `${scoredLastHour} payments already scored in the past hour — velocity alone can carry this to HIGH. Let the hour roll off for a clean LOW.`,
      );
    }
    if (preset === 'CRITICAL' && scoredLastHour < VELOCITY_WARN_AT) {
      toast.info(
        'Expect HIGH (funds held). Repeat this a couple of times: the velocity signal is what takes it to CRITICAL and a block.',
      );
    }
  };

  // Every money-path action below is wrapped in useSingleFlight: the ref guard is
  // synchronous, so a double-click cannot get two requests away before the
  // disabled state renders. This is the client half of the "same intent applied
  // twice" fix — the ledger idempotency key is the server half.
  const { run: initiate, pending: initiating } = useSingleFlight(async () => {
    if (!custRef || !amount || !debitAccountId || !beneficiaryId) return void toast.error('Fill all required fields');
    try {
      const { data } = await api.post('/payments', {
        custRefNo: custRef, amount: Number(amount), debitAccountId, beneficiaryId, rail, remarks,
      });
      setDraft(data);
      setStep(1);
    } catch (e) { toast.error(apiError(e)); }
  });

  const { run: confirm, pending: confirming } = useSingleFlight(async () => {
    try {
      const { data } = await api.post<ConfirmResult>(`/payments/${draft.id}/confirm`, {});
      setConfirmRes(data);
      if (data.outcome === 'OTP' || data.outcome === 'CHALLENGE') setOtpOpen(true);
      else { setFinalRes(data); setStep(2); } // HELD / BLOCKED
    } catch (e) { toast.error(apiError(e)); }
  });

  const { run: submit, pending: submitting } = useSingleFlight(async () => {
    try {
      const { data } = await api.post(`/payments/${draft.id}/submit`, {
        txnPassword, otpRequestId: confirmRes!.otpRequestId, code: otp,
      });
      // The backend absorbs a replayed submit rather than posting twice; say so
      // instead of reporting a second success for a payment that already went.
      if (data.alreadyPosted) toast.info('This payment had already been submitted.');
      setFinalRes({ ...data, ...confirmRes });
      setOtpOpen(false);
      setStep(2);
    } catch (e) { toast.error(apiError(e)); }
  });

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
          <Card
            title={`Initiate Payment — ${rail}`}
            actions={
              <>
                <span className="hidden text-xs text-text-muted sm:inline">Demo data:</span>
                <Button variant="outline" size="sm" onClick={() => fillDemo('LOW')}>
                  <Wand2 className="h-4 w-4" /> Low Risk
                </Button>
                <Button variant="outline" size="sm" onClick={() => fillDemo('CRITICAL')}>
                  <Wand2 className="h-4 w-4" /> Critical Risk
                </Button>
              </>
            }
          >
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
            <Button onClick={() => void initiate()} disabled={initiating}>Next</Button>
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
            <Button onClick={() => void confirm()} disabled={confirming}>Confirm</Button>
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
        footer={<><Button variant="ghost" onClick={() => setOtpOpen(false)}>Cancel</Button><Button onClick={() => void submit()} disabled={submitting}>Submit</Button></>}
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
