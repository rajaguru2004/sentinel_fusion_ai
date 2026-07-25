import axios, { type AxiosInstance } from 'axios';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const api: AxiosInstance = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { 'Content-Type': 'application/json' },
});

// Attach the JWT from localStorage on every request.
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('finspark-token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
    // Mock-VPN: forward the chosen country so the fraud gateway scores the login
    // /payment as if it came from there (dev only; backend gates on a flag).
    const mockCountry = localStorage.getItem('mock-country');
    if (mockCountry) config.headers['X-Mock-Country'] = mockCountry;
  }
  return config;
});

// On 401, drop the session and bounce to login.
api.interceptors.response.use(
  (res) => res,
  (error) => {
    if (typeof window !== 'undefined' && error?.response?.status === 401) {
      localStorage.removeItem('finspark-token');
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
    const msg = error.response?.data?.message;
    if (Array.isArray(msg)) return msg.join(', ');
    if (typeof msg === 'string') return msg;
    return error.message;
  }
  return 'Something went wrong';
}
