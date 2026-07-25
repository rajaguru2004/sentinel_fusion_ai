import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AuthUser {
  userId: string;
  customerId: string;
  customerName: string;
  role: 'MAKER' | 'AUTHORIZER' | 'VIEWER';
  lastLoginAt: string | null;
  email: string;
  mobile: string;
}

interface AuthState {
  user: AuthUser | null;
  setSession: (user: AuthUser) => void;
  updateUser: (partial: Partial<AuthUser>) => void;
  clear: () => void;
}

/**
 * Client-side session *display* state only.
 *
 * The JWT deliberately does not live here any more (ENHANCEMENTS.md §4). It is
 * held in an httpOnly cookie the browser attaches on its own, so no script —
 * including an injected one — can read it. What remains is the profile we render
 * in the header: non-sensitive, and losing it only costs a re-fetch.
 *
 * Because this is no longer the source of truth for auth, a stale persisted user
 * cannot grant access: the cookie is what the API checks, and a 401 redirects to
 * login regardless of what is cached here.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      setSession: (user) => set({ user }),
      updateUser: (partial) =>
        set((state) => ({ user: state.user ? { ...state.user, ...partial } : state.user })),
      clear: () => set({ user: null }),
    }),
    { name: 'finspark-auth' },
  ),
);
