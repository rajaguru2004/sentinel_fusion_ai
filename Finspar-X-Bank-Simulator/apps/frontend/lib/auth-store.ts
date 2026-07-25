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
  token: string | null;
  user: AuthUser | null;
  setSession: (token: string, user: AuthUser) => void;
  updateUser: (partial: Partial<AuthUser>) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setSession: (token, user) => {
        // Mirror the token into a plain key so the axios interceptor can read it.
        if (typeof window !== 'undefined') localStorage.setItem('finspark-token', token);
        set({ token, user });
      },
      updateUser: (partial) =>
        set((state) => ({ user: state.user ? { ...state.user, ...partial } : state.user })),
      clear: () => {
        if (typeof window !== 'undefined') localStorage.removeItem('finspark-token');
        set({ token: null, user: null });
      },
    }),
    { name: 'finspark-auth' },
  ),
);
