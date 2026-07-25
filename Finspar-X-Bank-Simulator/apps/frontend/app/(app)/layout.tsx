'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/shell/Sidebar';
import { Topbar } from '@/components/shell/Topbar';
import { useAuthStore } from '@/lib/auth-store';

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { token, user } = useAuthStore();
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);

  // Auth guard — zustand persists to localStorage; wait a tick for hydration.
  useEffect(() => {
    if (!token || !user) {
      router.replace('/login');
    } else {
      setReady(true);
    }
  }, [token, user, router]);

  if (!ready) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar collapsed={collapsed} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onToggleSidebar={() => setCollapsed((c) => !c)} unread={2} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
