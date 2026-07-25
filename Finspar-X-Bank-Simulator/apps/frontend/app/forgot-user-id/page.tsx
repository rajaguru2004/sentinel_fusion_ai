'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { AuthCard } from '@/components/auth/AuthCard';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { api, apiError } from '@/lib/api';

export default function ForgotUserIdPage() {
  const [customerId, setCustomerId] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setLoading(true);
    try {
      const { data } = await api.post('/auth/forgot-user-id', { customerId, email });
      setMessage(data.message);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthCard title="Forgot User Id" subtitle="Identify your account to receive your (masked) User Id by email.">
      {message ? (
        <p className="rounded-[var(--radius-input)] border border-border bg-bg p-4 text-sm text-text">{message}</p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Input label="Customer Id" required value={customerId} onChange={(e) => setCustomerId(e.target.value)} placeholder="83840226" />
          <Input label="Registered Email" required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Submitting…' : 'Submit'}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
