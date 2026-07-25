'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AuthCard } from '@/components/auth/AuthCard';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { api, apiError } from '@/lib/api';

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [step, setStep] = useState<'request' | 'reset'>('request');
  const [customerId, setCustomerId] = useState('');
  const [userId, setUserId] = useState('');
  const [requestId, setRequestId] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const request = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/auth/forgot-password', { customerId, userId });
      toast.message(data.message);
      if (data.requestId) {
        setRequestId(data.requestId);
        setStep('reset');
      }
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  const reset = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/auth/reset-password', { requestId, code, newPassword });
      toast.success(data.message);
      router.push('/login');
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  const resend = async (): Promise<void> => {
    try {
      const { data } = await api.post('/auth/recovery/resend', { requestId });
      setRequestId(data.requestId);
      toast.success('A new OTP has been sent.');
    } catch (err) {
      toast.error(apiError(err));
    }
  };

  return (
    <AuthCard
      title="Forgot Login Password"
      subtitle={step === 'request' ? 'We will email a one-time password to reset it.' : 'Enter the OTP and choose a new password.'}
    >
      {step === 'request' ? (
        <form onSubmit={request} className="space-y-4">
          <Input label="Customer Id" required value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="83840226" />
          <Input label="User Id" required value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="TARAKESH" />
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Sending…' : 'Send OTP'}
          </Button>
        </form>
      ) : (
        <form onSubmit={reset} className="space-y-4">
          <p className="text-xs text-text-muted">OTP sent to your registered email. Request ID: {requestId}</p>
          <Input label="OTP" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" hint="Demo OTP: 123456" />
          <Input label="New Password" required type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          <div className="flex items-center justify-between">
            <button type="button" onClick={resend} className="text-sm text-accent hover:underline">
              Resend OTP
            </button>
          </div>
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Updating…' : 'Set new password'}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
