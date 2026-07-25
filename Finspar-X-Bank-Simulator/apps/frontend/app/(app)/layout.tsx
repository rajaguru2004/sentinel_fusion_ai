'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Sidebar } from '@/components/shell/Sidebar';
import { Topbar } from '@/components/shell/Topbar';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useAuthStore } from '@/lib/auth-store';

export default function AppLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const user = useAuthStore((s) => s.user);
  const [collapsed, setCollapsed] = useState(false);
  const [ready, setReady] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Wait for zustand's persist middleware to finish reading localStorage.
  //
  // Without this the guard below runs on the very first client render, when
  // `user` is still null because rehydration has not happened yet, and
  // immediately redirects to /login. In-app navigation hides the bug (the store
  // is already in memory), but any FULL page load — a deep link, a refresh, or
  // Playwright's page.goto — bounced the user to the login screen even with a
  // perfectly valid session.
  //
  // Note this is a UX guard, not a security boundary: the cached user is only a
  // hint that a session cookie probably exists. Authorisation is the httpOnly
  // cookie, checked server-side on every call — a forged store entry buys
  // nothing but a page that 401s and redirects straight back here.
  useEffect(() => {
    if (useAuthStore.persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    return useAuthStore.persist.onFinishHydration(() => setHydrated(true));
  }, []);

  // Auth guard — only meaningful once the persisted session has been restored.
  useEffect(() => {
    if (!hydrated) return;
    if (!user) {
      router.replace('/login');
    } else {
      setReady(true);
    }
  }, [hydrated, user, router]);

  if (!hydrated || !ready) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <Sidebar collapsed={collapsed} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onToggleSidebar={() => setCollapsed((c) => !c)} unread={2} />
        {/* Keyed on the route so navigating away from a crashed page clears the
            boundary — otherwise the error state outlives the page that caused it. */}
        <main className="flex-1 overflow-y-auto p-6">
          <ErrorBoundary key={pathname} area="this page">
            {children}
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
