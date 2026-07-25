'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';

export default function ChangePasswordPage() {
  const [oldP, setOldP] = useState('');
  const [newP, setNewP] = useState('');
  const [confirmP, setConfirmP] = useState('');
  const [busy, setBusy] = useState(false);

  const valid = oldP && newP.length >= 8 && newP === confirmP;

  const submit = async (): Promise<void> => {
    if (newP !== confirmP) return void toast.error('Passwords do not match');
    setBusy(true);
    try {
      await api.post('/auth/change-password', { oldPassword: oldP, newPassword: newP });
      toast.success('Password updated');
      setOldP(''); setNewP(''); setConfirmP('');
    } catch (e) { toast.error(apiError(e)); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-lg">
      <PageHeader title="Change Password" />
      <Card title="Login password">
        <div className="space-y-4">
          <Input label="Old Password" required type="password" value={oldP} onChange={(e) => setOldP(e.target.value)} />
          <Input label="New Password" required type="password" value={newP} onChange={(e) => setNewP(e.target.value)} />
          <Input label="Confirm Password" required type="password" value={confirmP} onChange={(e) => setConfirmP(e.target.value)}
            error={confirmP && newP !== confirmP ? 'Does not match' : undefined} />
          <div className="flex gap-2">
            <Button onClick={submit} disabled={!valid || busy}>Update</Button>
            <Button variant="ghost" onClick={() => { setOldP(''); setNewP(''); setConfirmP(''); }}>Reset</Button>
          </div>
          <p className="text-xs text-text-muted">New password must differ from your last 3 passwords.</p>
        </div>
      </Card>
    </div>
  );
}
