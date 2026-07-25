import axios, { type AxiosInstance } from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

/** Set by the backend at login; readable by JS so we can echo it back. */
const CSRF_COOKIE = 'finspark_csrf';
const CSRF_HEADER = 'X-CSRF-Token';
const CORRELATION_HEADER = 'X-Correlation-Id';

export const api: AxiosInstance = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { 'Content-Type': 'application/json' },
  // The session JWT now lives in an httpOnly cookie the browser attaches
  // automatically. Nothing on this page can read it — which is the entire point:
  // an XSS can no longer exfiltrate the session.
  withCredentials: true,
});

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Last correlation id the server reported — surfaced in error messages. */
let lastCorrelationId: string | null = null;
export const getLastCorrelationId = (): string | null => lastCorrelationId;

api.interceptors.request.use((config) => {
  if (typeof window === 'undefined') return config;

  // Double-submit CSRF: echo the JS-readable cookie in a header. A cross-origin
  // page can cause the cookie to be SENT but cannot READ it, so it cannot
  // produce this header — which is what makes the cookie-borne JWT safe to
  // attach automatically.
  const method = (config.method ?? 'get').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) config.headers[CSRF_HEADER] = csrf;
  }

  // Mock-VPN: forward the chosen country so the fraud gateway scores the login
  // /payment as if it came from there (dev only; backend gates on a flag).
  const mockCountry = localStorage.getItem('mock-country');
  if (mockCountry) config.headers['X-Mock-Country'] = mockCountry;

  return config;
});

api.interceptors.response.use(
  (res) => {
    const id = res.headers?.[CORRELATION_HEADER.toLowerCase()];
    if (typeof id === 'string') lastCorrelationId = id;
    return res;
  },
  (error) => {
    const id = error?.response?.headers?.[CORRELATION_HEADER.toLowerCase()];
    if (typeof id === 'string') lastCorrelationId = id;

    // On 401 the cookie is gone or expired; clear local user state and bounce.
    // The cookie itself is cleared server-side, so there is nothing to remove here.
    if (typeof window !== 'undefined' && error?.response?.status === 401) {
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

/** Pull a human-readable message out of an axios error. */
export function apiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    // 429 bodies are terse; say something the user can act on.
    if (error.response?.status === 429) {
      return 'Too many requests. Please wait a moment and try again.';
    }
    if (error.response?.status === 403 && String(error.response?.data?.message ?? '').includes('CSRF')) {
      return 'Your session could not be verified. Please sign in again.';
    }
    const msg = error.response?.data?.message;
    if (Array.isArray(msg)) return msg.join(', ');
    if (typeof msg === 'string') return msg;
    return error.message;
  }
  return 'Something went wrong';
}
