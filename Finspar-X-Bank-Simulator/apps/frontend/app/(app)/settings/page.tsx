'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, ShieldBan, Clock, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge, RiskBadge, type RiskLevel } from '@/components/ui/Badge';
import { Table, THead, TBody, TR, TH, TD } from '@/components/ui/Table';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import { formatINR, formatDateTimeDMY } from '@/lib/format';

const LEVELS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const LEVEL_OPTIONS = LEVELS.map((l) => ({ value: l, label: l }));
const rank = (l: RiskLevel): number => LEVELS.indexOf(l);

interface Settings {
  alertEnabled: boolean;
  alertMinLevel: RiskLevel;
  blockEnabled: boolean;
  blockMinLevel: RiskLevel;
  perTxnLimit: number; // rupees
  cutoffEnabled: boolean;
  cutoffHour: number;
  cutoffMinute: number;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * Mirrors FraudGateway.decide() on the client so the operator can see what a
 * setting will actually do before saving it. If the backend ladder changes,
 * this must change with it — it is a preview, never the decision itself.
 */
function decisionFor(level: RiskLevel, blockEnabled: boolean, blockMinLevel: RiskLevel): string {
  if (blockEnabled && rank(level) >= rank(blockMinLevel)) return 'BLOCK';
  if (level === 'LOW') return 'EXECUTE';
  if (level === 'MEDIUM') return 'CHALLENGE';
  return 'HOLD';
}

const DECISION_HELP: Record<string, string> = {
  EXECUTE: 'Proceeds to OTP and posts',
  CHALLENGE: 'OTP + risk notice, payment marked CHALLENGED',
  HOLD: 'Funds reserved, queued for analyst review',
  BLOCK: 'Payment blocked and the account frozen',
};

const DECISION_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  EXECUTE: 'success',
  CHALLENGE: 'warning',
  HOLD: 'warning',
  BLOCK: 'danger',
};

const pad = (n: number): string => String(n).padStart(2, '0');

export default function SettingsPage() {
  const qc = useQueryClient();
  const [form, setForm] = useState<Settings | null>(null);

  const { data, isLoading } = useQuery<Settings>({
    queryKey: ['settings'],
    queryFn: async () => (await api.get<Settings>('/settings')).data,
  });

  // Seed the form once the server value arrives, and re-seed after every save
  // so `dirty` below compares against what is actually stored.
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const save = useMutation({
    mutationFn: async (s: Settings) => {
      const { data: saved } = await api.put<Settings>('/settings', {
        alertEnabled: s.alertEnabled,
        alertMinLevel: s.alertMinLevel,
        blockEnabled: s.blockEnabled,
        blockMinLevel: s.blockMinLevel,
        perTxnLimit: s.perTxnLimit,
        cutoffEnabled: s.cutoffEnabled,
        cutoffHour: s.cutoffHour,
        cutoffMinute: s.cutoffMinute,
      });
      return saved;
    },
    onSuccess: (saved) => {
      qc.setQueryData(['settings'], saved);
      setForm(saved);
      toast.success('Settings saved — applied from the next transaction');
    },
    onError: (e) => toast.error(apiError(e)),
  });

  if (isLoading || !form || !data) {
    return (
      <div className="mx-auto max-w-3xl">
        <PageHeader title="Settings" />
        <p className="text-sm text-text-muted">Loading current policy…</p>
      </div>
    );
  }

  const set = <K extends keyof Settings>(key: K, value: Settings[K]): void =>
    setForm((f) => (f ? { ...f, [key]: value } : f));

  const dirty = (Object.keys(form) as (keyof Settings)[]).some(
    (k) => k !== 'updatedAt' && k !== 'updatedBy' && form[k] !== data[k],
  );
  const limitValid = form.perTxnLimit > 0;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Settings"
        description="Fraud policy applied to every payment and every alert email. Changes take effect on the next transaction — no restart."
        actions={
          <>
            <Button variant="ghost" disabled={!dirty} onClick={() => setForm(data)}>
              <RotateCcw className="h-4 w-4" /> Revert
            </Button>
            <Button
              disabled={!dirty || !limitValid || save.isPending}
              onClick={() => save.mutate(form)}
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </>
        }
      />

      <div className="space-y-5">
        {/* --- 1. Alert email ------------------------------------------------ */}
        <Card
          title={
            <span className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-text-muted" /> Risk alert emails
            </span>
          }
        >
          <div className="space-y-4">
            <Toggle
              checked={form.alertEnabled}
              onChange={(v) => set('alertEnabled', v)}
              label="Send fraud alert emails"
              hint="Off silences every alert mail. Scoring, holds and the analyst feed are unaffected."
            />
            <Select
              label="Send an email when risk is at or above"
              options={LEVEL_OPTIONS}
              value={form.alertMinLevel}
              disabled={!form.alertEnabled}
              onChange={(e) => set('alertMinLevel', e.target.value as RiskLevel)}
            />
            <p className="text-xs text-text-muted">
              {form.alertEnabled ? (
                <>
                  The customer is mailed for{' '}
                  <strong className="text-text">
                    {LEVELS.filter((l) => rank(l) >= rank(form.alertMinLevel)).join(', ')}
                  </strong>{' '}
                  events. One qualifying event produces one email — no batching.
                </>
              ) : (
                'No alert emails will be sent.'
              )}
            </p>
          </div>
        </Card>

        {/* --- 2. Payment blocking ------------------------------------------- */}
        <Card
          title={
            <span className="flex items-center gap-2">
              <ShieldBan className="h-4 w-4 text-text-muted" /> Payment blocking
            </span>
          }
        >
          <div className="space-y-4">
            <Toggle
              checked={form.blockEnabled}
              onChange={(v) => set('blockEnabled', v)}
              label="Allow the fraud engine to block payments"
              hint="Off means a payment is never auto-blocked and no account is frozen — the riskiest outcome becomes HOLD for analyst review."
            />
            <Select
              label="Block the payment when risk is at or above"
              options={LEVEL_OPTIONS}
              value={form.blockMinLevel}
              disabled={!form.blockEnabled}
              onChange={(e) => set('blockMinLevel', e.target.value as RiskLevel)}
            />

            <div>
              <p className="mb-2 text-sm font-medium text-text">Resulting policy</p>
              <Table>
                <THead>
                  <TR>
                    <TH>Risk band</TH>
                    <TH>Payment outcome</TH>
                    <TH>Email</TH>
                  </TR>
                </THead>
                <TBody>
                  {LEVELS.map((level) => {
                    const decision = decisionFor(level, form.blockEnabled, form.blockMinLevel);
                    const mails = form.alertEnabled && rank(level) >= rank(form.alertMinLevel);
                    return (
                      <TR key={level}>
                        <TD>
                          <RiskBadge level={level} />
                        </TD>
                        <TD>
                          <div className="flex items-center gap-2">
                            <Badge tone={DECISION_TONE[decision]}>{decision}</Badge>
                            <span className="text-xs text-text-muted">
                              {DECISION_HELP[decision]}
                            </span>
                          </div>
                        </TD>
                        <TD>
                          <span className={mails ? 'text-text' : 'text-text-muted'}>
                            {mails ? 'Sent' : '—'}
                          </span>
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          </div>
        </Card>

        {/* --- 3. Limit & cut-off -------------------------------------------- */}
        <Card
          title={
            <span className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-text-muted" /> Transaction limit &amp; cut-off
            </span>
          }
        >
          <div className="space-y-4">
            <Input
              label="Per-transaction limit (₹)"
              required
              type="number"
              min={1}
              step={1000}
              value={form.perTxnLimit}
              onChange={(e) => set('perTxnLimit', Number(e.target.value))}
              error={limitValid ? undefined : 'Must be greater than zero'}
              hint={
                limitValid
                  ? `${formatINR(form.perTxnLimit)} — a payment above this is deferred to the next working day, not rejected.`
                  : undefined
              }
            />

            <Toggle
              checked={form.cutoffEnabled}
              onChange={(v) => set('cutoffEnabled', v)}
              label="Apply the NEFT / RTGS cut-off"
              hint="Off means NEFT and RTGS payments post at any hour and the end-of-day batch does not run."
            />

            <div className="flex items-end gap-3">
              <div className="w-32">
                <Select
                  label="Cut-off hour"
                  options={Array.from({ length: 24 }, (_, h) => ({
                    value: String(h),
                    label: pad(h),
                  }))}
                  value={String(form.cutoffHour)}
                  disabled={!form.cutoffEnabled}
                  onChange={(e) => set('cutoffHour', Number(e.target.value))}
                />
              </div>
              <div className="w-32">
                <Select
                  label="Minute"
                  options={[0, 15, 30, 45].map((m) => ({ value: String(m), label: pad(m) }))}
                  value={String(form.cutoffMinute)}
                  disabled={!form.cutoffEnabled}
                  onChange={(e) => set('cutoffMinute', Number(e.target.value))}
                />
              </div>
              <p className="pb-2.5 text-xs text-text-muted">
                {form.cutoffEnabled
                  ? `NEFT/RTGS submitted after ${pad(form.cutoffHour)}:${pad(form.cutoffMinute)} carry to the next working day. The end-of-day batch runs at this time on weekdays.`
                  : 'Cut-off disabled.'}
              </p>
            </div>
          </div>
        </Card>

        <p className="pb-2 text-xs text-text-muted">
          Last changed {formatDateTimeDMY(data.updatedAt)}
          {data.updatedBy ? ` by ${data.updatedBy}` : ''}. Every change is written to the audit log.
        </p>
      </div>
    </div>
  );
}

/** Checkbox styled as a settings row — label left, control right. */
function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="text-sm font-medium text-text">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-text-muted">{hint}</span>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
      />
    </label>
  );
}
