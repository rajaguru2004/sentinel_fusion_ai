'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronDown, LogOut, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NAV } from '@/lib/nav';
import { useAuthStore } from '@/lib/auth-store';
import { api } from '@/lib/api';
import { useRouter } from 'next/navigation';

export function Sidebar({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const clear = useAuthStore((s) => s.clear);
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    // Auto-open the group containing the active route.
    const state: Record<string, boolean> = {};
    for (const item of NAV) {
      if (item.children?.some((c) => pathname.startsWith(c.href))) state[item.label] = true;
    }
    return state;
  });

  // The session lives in an httpOnly cookie the page cannot touch, so signing
  // out has to ask the server to clear it. Local state is cleared regardless of
  // the call's outcome — a failed logout must still end the visible session
  // rather than leave the user looking signed in.
  const logout = async (): Promise<void> => {
    try {
      await api.post('/auth/logout');
    } catch {
      // Already expired or the API is unreachable; the redirect still applies.
    } finally {
      clear();
      router.push('/login');
    }
  };

  return (
    <aside
      className={cn(
        'flex h-full flex-col border-r border-border bg-surface transition-all',
        collapsed ? 'w-16' : 'w-64',
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b border-border px-4 font-semibold text-text">
        <ShieldCheck className="h-6 w-6 shrink-0 text-primary" />
        {!collapsed && <span>Bank of Maharashtra</span>}
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {NAV.map((item) => {
          const Icon = item.icon;
          if (item.children) {
            const isOpen = open[item.label];
            return (
              <div key={item.label}>
                <button
                  onClick={() => setOpen((s) => ({ ...s, [item.label]: !s[item.label] }))}
                  className="flex w-full items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-sm text-text-muted hover:bg-bg hover:text-text"
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && (
                    <>
                      <span className="flex-1 text-left">{item.label}</span>
                      <ChevronDown className={cn('h-4 w-4 transition-transform', isOpen && 'rotate-180')} />
                    </>
                  )}
                </button>
                {isOpen && !collapsed && (
                  <div className="ml-4 mt-0.5 space-y-0.5 border-l border-border pl-3">
                    {item.children.map((child) => (
                      <Link
                        key={child.href}
                        href={child.href}
                        className={cn(
                          'block rounded-[var(--radius-input)] px-3 py-1.5 text-sm',
                          pathname === child.href
                            ? 'bg-primary/10 font-medium text-primary'
                            : 'text-text-muted hover:bg-bg hover:text-text',
                        )}
                      >
                        {child.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          }
          return (
            <Link
              key={item.href}
              href={item.href!}
              className={cn(
                'flex items-center gap-3 rounded-[var(--radius-input)] px-3 py-2 text-sm',
                pathname === item.href
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-text-muted hover:bg-bg hover:text-text',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      <button
        onClick={logout}
        className="flex items-center gap-3 border-t border-border px-4 py-3 text-sm text-text-muted hover:bg-bg hover:text-text"
      >
        <LogOut className="h-4 w-4 shrink-0" />
        {!collapsed && <span>Log out</span>}
      </button>
    </aside>
  );
}
