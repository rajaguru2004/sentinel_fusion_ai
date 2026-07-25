'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';

export default function TransactionPasswordPage() {
  const user = useAuthStore((s) => s.user);
  const [oldP, setOldP] = useState('');
  const [newP, setNewP] = useState('');
  const [confirmP, setConfirmP] = useState('');
  const [reqId, setReqId] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);

  const update = async (): Promise<void> => {
    if (newP !== confirmP) return void toast.error('Passwords do not match');
    setBusy(true);
    try {
      await api.post('/auth/change-txn-password', { oldPassword: oldP, newPassword: newP });
      toast.success('Transaction password updated');
      setOldP(''); setNewP(''); setConfirmP('');
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };

  const generate = async (): Promise<void> => {
    try {
      const { data } = await api.post('/auth/forgot-password', {
        customerId: user?.customerId, userId: user?.userId, purpose: 'TXN_PASSWORD',
      });
      if (data.requestId) { setReqId(data.requestId); toast.success('OTP sent to registered email'); }
      else toast.message(data.message);
    } catch (e) { toast.error(apiError(e)); }
  };

  const resetWithOtp = async (): Promise<void> => {
    if (newP !== confirmP) return void toast.error('Passwords do not match');
    try {
      await api.post('/auth/reset-password', { requestId: reqId, code: otp, newPassword: newP });
      toast.success('Transaction password reset');
      setReqId(''); setOtp(''); setNewP(''); setConfirmP('');
    } catch (e) { toast.error(apiError(e)); }
  };

  return (
    <div className="mx-auto max-w-lg space-y-6">
      <PageHeader title="Transaction Password" />
      <Card title="Change transaction password">
        <div className="space-y-4">
          <Input label="Old Password" required type="password" value={oldP} onChange={(e) => setOldP(e.target.value)} />
          <Input label="New Password" required type="password" value={newP} onChange={(e) => setNewP(e.target.value)} />
          <Input label="Confirm Password" required type="password" value={confirmP} onChange={(e) => setConfirmP(e.target.value)} />
          <div className="flex gap-2">
            <Button onClick={update} disabled={busy}>Update</Button>
            <Button variant="outline" onClick={generate}>Generate Or Reset Txn Password</Button>
          </div>
        </div>
      </Card>

      {reqId && (
        <Card title="Reset via OTP">
          <div className="space-y-4">
            <p className="text-xs text-text-muted">OTP sent to your registered email. Request ID: {reqId}</p>
            <Input label="OTP" required value={otp} onChange={(e) => setOtp(e.target.value)} hint="Demo OTP: 123456" />
            <p className="text-xs text-text-muted">Enter the new password above, then confirm.</p>
            <Button onClick={resetWithOtp}>Confirm reset</Button>
          </div>
        </Card>
      )}
    </div>
  );
}
