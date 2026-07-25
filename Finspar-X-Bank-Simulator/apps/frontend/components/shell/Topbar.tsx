'use client';

import { Menu, Bell } from 'lucide-react';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useAuthStore } from '@/lib/auth-store';
import { formatDateTimeDMY } from '@/lib/format';

export function Topbar({
  onToggleSidebar,
  unread = 0,
}: {
  onToggleSidebar: () => void;
  unread?: number;
}) {
  const user = useAuthStore((s) => s.user);

  return (
    <header className="flex h-14 items-center justify-between gap-4 border-b border-border bg-surface px-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
          className="rounded-[var(--radius-input)] p-2 text-text-muted hover:bg-bg hover:text-text"
        >
          <Menu className="h-5 w-5" />
        </button>
        {user?.lastLoginAt && (
          <span className="hidden text-xs text-text-muted sm:inline">
            Last Login: <span className="tabular">{formatDateTimeDMY(user.lastLoginAt)}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          aria-label="Notifications"
          className="relative rounded-[var(--radius-input)] p-2 text-text-muted hover:bg-bg hover:text-text"
        >
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-risk-critical px-1 text-[10px] font-semibold text-white">
              {unread}
            </span>
          )}
        </button>
        <ThemeToggle />
        {user && (
          <div className="hidden text-right text-sm md:block">
            <div className="font-medium text-text">Welcome !! {user.userId}</div>
            <div className="text-xs text-text-muted tabular">({user.customerId})</div>
          </div>
        )}
      </div>
    </header>
  );
}
