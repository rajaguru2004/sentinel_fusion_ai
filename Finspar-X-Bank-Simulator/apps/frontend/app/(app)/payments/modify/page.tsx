'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, Trash2, Pencil, Send, PauseCircle, ShieldX, CheckCircle2 } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge, RiskBadge } from '@/components/ui/Badge';
import { Modal } from '@/components/ui/Modal';
import { RiskMeter } from '@/components/RiskMeter';
import { Table, THead, TBody, TR, TH, TD, EmptyState } from '@/components/ui/Table';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import { formatPaise, formatDateDMY, paiseToRupees } from '@/lib/format';

interface PaymentRow {
  id: string;
  refNo: string;
  custRefNo: string;
  amount: string;
  rail: string;
  paymentMode: string;
  status: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | null;
  beneficiaryName: string;
  transactionDate: string;
  remarks?: string | null;
  editable: boolean;
}

interface ConfirmResult {
  outcome: string;
  otpRequestId?: string;
  riskScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  reasons: string[];
}

const statusTone = (s: string) =>
  s === 'COMPLETED' ? 'success' : s === 'BLOCKED' ? 'danger' : s === 'HELD' ? 'warning' : 'neutral';

export default function ModifyPaymentsPage() {
  const qc = useQueryClient();
  const [rail, setRail] = useState('');
  const [refNo, setRefNo] = useState('');
  const [applied, setApplied] = useState(false);
  const [toDelete, setToDelete] = useState<PaymentRow | null>(null);
  const [toEdit, setToEdit] = useState<PaymentRow | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editCustRef, setEditCustRef] = useState('');
  const [editRemarks, setEditRemarks] = useState('');
  const [saving, setSaving] = useState(false);

  // Authorize & Send flow
  const [toSend, setToSend] = useState<PaymentRow | null>(null);
  const [confirmRes, setConfirmRes] = useState<ConfirmResult | null>(null);
  const [sendDone, setSendDone] = useState<{ outcome: string; refNo?: string; reason?: string; status?: string } | null>(null);
  const [txnPassword, setTxnPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [sendBusy, setSendBusy] = useState(false);

  const { data, refetch } = useQuery<PaymentRow[]>({
    queryKey: ['payments', rail, refNo],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (rail) params.set('rail', rail);
      if (refNo) params.set('refNo', refNo);
      return (await api.get(`/payments?${params}`)).data;
    },
    enabled: applied,
  });

  const del = async (): Promise<void> => {
    if (!toDelete) return;
    try {
      await api.delete(`/payments/${toDelete.id}`);
      toast.success('Payment deleted');
      setToDelete(null);
      qc.invalidateQueries({ queryKey: ['payments'] });
    } catch (e) { toast.error(apiError(e)); }
  };

  const openEdit = (p: PaymentRow): void => {
    setToEdit(p);
    setEditAmount(String(paiseToRupees(p.amount)));
    setEditCustRef(p.custRefNo);
    setEditRemarks(p.remarks ?? '');
  };

  const saveEdit = async (): Promise<void> => {
    if (!toEdit) return;
    const amount = Number(editAmount);
    if (!Number.isFinite(amount) || amount <= 0) return void toast.error('Enter a valid amount');
    if (!editCustRef.trim()) return void toast.error('Customer reference is required');
    setSaving(true);
    try {
      await api.patch(`/payments/${toEdit.id}`, {
        amount,
        custRefNo: editCustRef.trim(),
        remarks: editRemarks,
      });
      toast.success('Payment updated');
      setToEdit(null);
      qc.invalidateQueries({ queryKey: ['payments'] });
    } catch (e) { toast.error(apiError(e)); }
    finally { setSaving(false); }
  };

  const openSend = async (p: PaymentRow): Promise<void> => {
    setToSend(p);
    setConfirmRes(null);
    setSendDone(null);
    setTxnPassword('');
    setOtp('');
    setSendBusy(true);
    try {
      // Step 1: fraud check. LOW/MEDIUM -> OTP; HIGH -> HELD; CRITICAL -> BLOCKED.
      const { data } = await api.post<ConfirmResult>(`/payments/${p.id}/confirm`, {});
      setConfirmRes(data);
      if (data.outcome !== 'OTP' && data.outcome !== 'CHALLENGE') {
        setSendDone({ outcome: data.outcome });
        qc.invalidateQueries({ queryKey: ['payments'] });
      }
    } catch (e) {
      toast.error(apiError(e));
      setToSend(null);
    } finally {
      setSendBusy(false);
    }
  };

  const submitSend = async (): Promise<void> => {
    if (!toSend || !confirmRes?.otpRequestId) return;
    if (!txnPassword) return void toast.error('Enter your transaction password');
    if (!otp) return void toast.error('Enter the OTP');
    setSendBusy(true);
    try {
      const { data } = await api.post(`/payments/${toSend.id}/submit`, {
        txnPassword,
        otpRequestId: confirmRes.otpRequestId,
        code: otp,
      });
      setSendDone(data);
      toast.success('Payment submitted');
      qc.invalidateQueries({ queryKey: ['payments'] });
    } catch (e) { toast.error(apiError(e)); }
    finally { setSendBusy(false); }
  };

  const closeSend = (): void => {
    setToSend(null);
    setConfirmRes(null);
    setSendDone(null);
    setTxnPassword('');
    setOtp('');
  };

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader title="Modify Payments" description="Edit or delete payments that are still editable." />
      <Card title="Filters">
        <div className="grid gap-4 md:grid-cols-3">
          <Input label="Reference Number" value={refNo} onChange={(e) => setRefNo(e.target.value)} />
          <Select label="Payment Mode" value={rail} onChange={(e) => setRail(e.target.value)}
            options={[{ value: '', label: 'All' }, { value: 'IFT', label: 'IFT' }, { value: 'IMPS', label: 'IMPS' }, { value: 'NEFT', label: 'NEFT' }, { value: 'RTGS', label: 'RTGS' }]} />
        </div>
        <div className="mt-4">
          <Button onClick={() => { setApplied(true); refetch(); }}><Search className="h-4 w-4" /> Search</Button>
        </div>
      </Card>

      <div className="mt-6">
        {!applied ? (
          <EmptyState message="Set filters and click Search." />
        ) : !data?.length ? (
          <EmptyState message="No payments found." />
        ) : (
          <Table>
            <THead>
              <TH>Actions</TH>
              <TH>Reference Number</TH>
              <TH numeric>Amount</TH>
              <TH>Cust Ref</TH>
              <TH>Date</TH>
              <TH>Mode</TH>
              <TH>Status</TH>
              <TH numeric>Risk</TH>
            </THead>
            <TBody>
              {data.map((p) => (
                <TR key={p.id}>
                  <TD>
                    <div className="flex gap-2">
                      <button disabled={!p.editable} onClick={() => openSend(p)} className="text-risk-low enabled:hover:underline disabled:opacity-30" title="Authorize & Send"><Send className="h-4 w-4" /></button>
                      <button disabled={!p.editable} onClick={() => openEdit(p)} className="text-accent enabled:hover:underline disabled:opacity-30" title="Edit"><Pencil className="h-4 w-4" /></button>
                      <button disabled={!p.editable} onClick={() => setToDelete(p)} className="text-risk-critical enabled:hover:underline disabled:opacity-30" title="Delete"><Trash2 className="h-4 w-4" /></button>
                    </div>
                  </TD>
                  <TD className="tabular">{p.refNo}</TD>
                  <TD numeric>{formatPaise(p.amount)}</TD>
                  <TD className="tabular text-xs">{p.custRefNo}</TD>
                  <TD className="tabular">{formatDateDMY(p.transactionDate)}</TD>
                  <TD className="text-xs">{p.rail}</TD>
                  <TD><Badge tone={statusTone(p.status)}>{p.status}</Badge></TD>
                  <TD numeric>{p.riskLevel ? <RiskBadge level={p.riskLevel} /> : '—'}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>

      <Modal
        open={!!toSend}
        onClose={closeSend}
        title={`Authorize & Send ${toSend?.refNo ?? ''}`}
        footer={
          sendDone ? (
            <Button onClick={closeSend}>Close</Button>
          ) : confirmRes && (confirmRes.outcome === 'OTP' || confirmRes.outcome === 'CHALLENGE') ? (
            <>
              <Button variant="ghost" onClick={closeSend}>Cancel</Button>
              <Button onClick={submitSend} disabled={sendBusy}>{sendBusy ? 'Submitting…' : 'Submit'}</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={closeSend}>Cancel</Button>
          )
        }
      >
        <div className="space-y-4">
          {toSend && (
            <div className="text-sm text-text-muted">
              {toSend.beneficiaryName} · {toSend.rail} ·{' '}
              <span className="font-medium text-text">{formatPaise(toSend.amount)}</span>
            </div>
          )}

          {sendDone ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              {sendDone.outcome === 'BLOCKED' ? (
                <><ShieldX className="h-9 w-9 text-risk-critical" /><p className="font-medium text-risk-critical">Payment blocked — account frozen for review</p></>
              ) : sendDone.outcome === 'HELD' || sendDone.outcome === 'HELD_CUTOFF' ? (
                <><PauseCircle className="h-9 w-9 text-risk-high" /><p className="font-medium text-risk-high">Funds held{sendDone.reason ? ` — ${sendDone.reason}` : ' for analyst review'}</p></>
              ) : (
                <><CheckCircle2 className="h-9 w-9 text-risk-low" /><p className="font-medium text-risk-low">Payment {sendDone.status ?? 'submitted'}</p></>
              )}
              {sendDone.refNo && <p className="tabular text-sm text-text-muted">Reference: {sendDone.refNo}</p>}
            </div>
          ) : !confirmRes ? (
            <p className="py-4 text-center text-sm text-text-muted">Assessing risk…</p>
          ) : (
            <>
              <div className="rounded-[var(--radius-input)] border border-border bg-bg p-3">
                <RiskMeter score={confirmRes.riskScore} level={confirmRes.riskLevel} reasons={confirmRes.reasons} />
                {confirmRes.outcome === 'CHALLENGE' && (
                  <p className="mt-2 text-center text-xs text-risk-medium">Medium risk — enter the re-issued OTP to proceed.</p>
                )}
              </div>
              <Input label="Transaction Password" type="password" required value={txnPassword} onChange={(e) => setTxnPassword(e.target.value)} />
              <Input label="OTP" required value={otp} onChange={(e) => setOtp(e.target.value)} placeholder="6-digit code" hint="Demo OTP: 123456" />
              <p className="text-xs text-text-muted">OTP Request ID: {confirmRes.otpRequestId}</p>
            </>
          )}
        </div>
      </Modal>

      <Modal open={!!toEdit} onClose={() => setToEdit(null)} title={`Modify payment ${toEdit?.refNo ?? ''}`}
        footer={<><Button variant="ghost" onClick={() => setToEdit(null)}>Cancel</Button><Button onClick={saveEdit} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button></>}>
        <div className="space-y-4">
          <div className="text-sm text-text-muted">
            Beneficiary: <span className="font-medium text-text">{toEdit?.beneficiaryName}</span> · Mode:{' '}
            <span className="font-medium text-text">{toEdit?.rail}</span>
          </div>
          <Input label="Amount (₹)" type="number" min="0" step="0.01" value={editAmount} onChange={(e) => setEditAmount(e.target.value)} />
          <Input label="Customer Reference No" value={editCustRef} onChange={(e) => setEditCustRef(e.target.value)} />
          <Input label="Remarks" value={editRemarks} onChange={(e) => setEditRemarks(e.target.value)} />
        </div>
      </Modal>

      <Modal open={!!toDelete} onClose={() => setToDelete(null)} title="Delete payment?"
        footer={<><Button variant="ghost" onClick={() => setToDelete(null)}>Cancel</Button><Button variant="danger" onClick={del}>Delete</Button></>}>
        <p className="text-sm text-text-muted">Soft-delete {toDelete?.refNo}? The record is retained for audit.</p>
      </Modal>
    </div>
  );
}
