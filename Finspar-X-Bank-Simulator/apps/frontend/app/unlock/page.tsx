'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { AuthCard } from '@/components/auth/AuthCard';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { api, apiError } from '@/lib/api';

export default function UnlockPage() {
  const router = useRouter();
  const [step, setStep] = useState<'request' | 'verify'>('request');
  const [customerId, setCustomerId] = useState('');
  const [userId, setUserId] = useState('');
  const [requestId, setRequestId] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  const request = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/auth/unlock', { customerId, userId });
      toast.message(data.message);
      if (data.requestId) {
        setRequestId(data.requestId);
        setStep('verify');
      }
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  const verify = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/auth/unlock/verify', { requestId, code });
      toast.success(data.message);
      router.push('/login');
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard
      title="Unlock Me"
      subtitle={step === 'request' ? 'Locked out after failed sign-ins? Verify by OTP to unlock.' : 'Enter the OTP sent to your registered email.'}
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
        <form onSubmit={verify} className="space-y-4">
          <p className="text-xs text-text-muted">Request ID: {requestId}</p>
          <Input label="OTP" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" hint="Demo OTP: 123456" />
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Unlocking…' : 'Unlock account'}
          </Button>
          <p className="text-xs text-text-muted">Unlock does not reset your password. If forgotten, use Forgot Login Password afterwards.</p>
        </form>
      )}
    </AuthCard>
  );
}
