'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Pencil, Lock } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PageHeader } from '@/components/PageHeader';
import { api, apiError } from '@/lib/api';
import { useAuthStore } from '@/lib/auth-store';

export default function ProfilePage() {
  const { user, updateUser } = useAuthStore();
  const [editing, setEditing] = useState(false);
  const [mobile, setMobile] = useState(user?.mobile ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  if (!user) return null;

  const changed = mobile !== user.mobile || email !== user.email;

  const startEdit = (): void => {
    setMobile(user.mobile);
    setEmail(user.email);
    setEditing(true);
  };

  const cancel = (): void => {
    setMobile(user.mobile);
    setEmail(user.email);
    setEditing(false);
  };

  const requestSave = (): void => {
    if (!changed) return void toast.message('No changes to save');
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return void toast.error('Enter a valid email');
    setPassword('');
    setConfirmOpen(true);
  };

  const save = async (): Promise<void> => {
    if (!password) return void toast.error('Enter your login password');
    setBusy(true);
    try {
      const { data } = await api.post('/auth/profile', { password, mobile, email });
      updateUser({ mobile: data.mobile, email: data.email });
      toast.success('Profile updated');
      setConfirmOpen(false);
      setEditing(false);
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="Profile"
        actions={
          <>
            <Badge tone="info">{user.role}</Badge>
            {!editing && (
              <Button variant="outline" size="sm" onClick={startEdit}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            )}
          </>
        }
      />

      <Card title="Account holder">
        <div className="space-y-1">
          {/* Identity — always read-only */}
          <ReadOnly label="User Id" value={user.userId} />
          <ReadOnly label="Customer Id" value={user.customerId} />
          <ReadOnly label="Customer Name" value={user.customerName} />

          {/* Editable contact details */}
          {editing ? (
            <div className="grid gap-4 border-t border-border pt-4 md:grid-cols-2">
              <Input label="Registered Mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} />
              <Input label="Registered Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          ) : (
            <>
              <ReadOnly label="Registered Mobile" value={user.mobile} />
              <ReadOnly label="Registered Email" value={user.email} />
            </>
          )}
        </div>

        {editing && (
          <div className="mt-6 flex items-center gap-2">
            <Button onClick={requestSave} disabled={!changed}>Save changes</Button>
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
            <span className="ml-auto flex items-center gap-1 text-xs text-text-muted">
              <Lock className="h-3.5 w-3.5" /> Password required to save
            </span>
          </div>
        )}
      </Card>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Confirm with your password"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Confirm & Save'}</Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-text-muted">
            Changing your registered mobile or email affects where one-time passwords are sent.
            Enter your login password to confirm.
          </p>
          <Input
            label="Login Password"
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
          />
        </div>
      </Modal>
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-3 text-sm">
      <span className="text-text-muted">{label}</span>
      <span className="font-medium text-text">{value}</span>
    </div>
  );
}
