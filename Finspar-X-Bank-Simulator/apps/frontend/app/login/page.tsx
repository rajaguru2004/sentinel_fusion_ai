'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, ShieldCheck, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Captcha } from '@/components/auth/Captcha';
import { VirtualKeyboard } from '@/components/auth/VirtualKeyboard';
import { ThemeToggle } from '@/components/ThemeToggle';
import { DemoTestPanel } from '@/components/demo/DemoTestPanel';
import { api, apiError } from '@/lib/api';
import { useAuthStore, type AuthUser } from '@/lib/auth-store';

const schema = z.object({
  customerId: z.string().min(1, 'Customer Id is required'),
  userId: z.string().min(1, 'User Id is required'),
  password: z.string().min(1, 'Password is required'),
});
type FormValues = z.infer<typeof schema>;

// Mock-VPN country selector (dev). Sent as X-Mock-Country so the fraud gateway
// scores the login as if it originated there — lets you test the new-country
// signal without a real VPN.
const MOCK_COUNTRIES: { code: string; label: string }[] = [
  { code: '', label: 'Auto (real location)' },
  { code: 'IN', label: '🇮🇳 India' },
  { code: 'US', label: '🇺🇸 United States' },
  { code: 'GB', label: '🇬🇧 United Kingdom' },
  { code: 'NL', label: '🇳🇱 Netherlands' },
  { code: 'SG', label: '🇸🇬 Singapore' },
  { code: 'AE', label: '🇦🇪 UAE' },
  { code: 'AU', label: '🇦🇺 Australia' },
  { code: 'DE', label: '🇩🇪 Germany' },
  { code: 'JP', label: '🇯🇵 Japan' },
  { code: 'RU', label: '🇷🇺 Russia' },
];

export default function LoginPage() {
  const router = useRouter();
  const setSession = useAuthStore((s) => s.setSession);
  const [reveal, setReveal] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [captchaCode, setCaptchaCode] = useState('');
  const [captchaInput, setCaptchaInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [mockCountry, setMockCountry] = useState('');
  const captchaRef = useRef('');

  // Persist the mock-VPN choice so the api interceptor sends it on every request.
  const onMockCountryChange = (code: string): void => {
    setMockCountry(code);
    if (typeof window !== 'undefined') {
      if (code) localStorage.setItem('mock-country', code);
      else localStorage.removeItem('mock-country');
    }
  };

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema) });

  const password = watch('password') ?? '';

  // Restore any previously chosen mock-VPN country.
  useEffect(() => {
    const saved = localStorage.getItem('mock-country');
    if (saved) setMockCountry(saved);
  }, []);

  const onSubmit = async (values: FormValues): Promise<void> => {
    if (captchaInput.trim().toUpperCase() !== captchaRef.current) {
      toast.error('CAPTCHA does not match');
      return;
    }
    setSubmitting(true);
    try {
      const { data } = await api.post('/auth/login', {
        ...values,
        deviceFingerprint: navigator.userAgent.slice(0, 64),
      });
      setSession(data.accessToken, data.user as AuthUser);
      toast.success(`Welcome, ${data.user.userId}`);
      router.push('/dashboard');
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      {/* Left — brand / portal description */}
      <aside className="relative hidden flex-col justify-between bg-primary p-12 text-white lg:flex">
        <div className="flex items-center gap-2 text-xl font-semibold">
          <ShieldCheck className="h-7 w-7" /> Bank of Maharashtra
        </div>
        <div className="space-y-4">
          <h1 className="text-3xl font-semibold leading-tight">
            Corporate internet banking, watched over by AI fraud detection.
          </h1>
          <p className="text-white/70">
            Every transfer is scored in real time. Secure maker controls, transaction
            passwords, and one-time codes protect your money movement.
          </p>
        </div>
        <p className="text-sm text-white/50">
          Demo environment · fabricated data · India · INR only
        </p>
      </aside>

      {/* Right — login form */}
      <main className="flex flex-col items-center justify-center gap-6 bg-bg p-6">
        <div className="absolute right-4 top-4">
          <ThemeToggle />
        </div>
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="w-full max-w-md space-y-5 rounded-[var(--radius-card)] border border-border bg-surface p-8 shadow-sm"
        >
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-xl font-semibold text-text">
              <Lock className="h-5 w-5 text-accent" /> Sign in
            </h2>
            <p className="text-sm text-text-muted">Enter your corporate banking credentials.</p>
          </div>

          <Input label="Customer Id" required placeholder="83840226" {...register('customerId')} error={errors.customerId?.message} />
          <Input label="User Id" required placeholder="TARAKESH" {...register('userId')} error={errors.userId?.message} />

          <div className="relative">
            <Input
              label="Password"
              required
              type={reveal ? 'text' : 'password'}
              autoComplete="off"
              {...register('password')}
              error={errors.password?.message}
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              className="absolute right-3 top-[34px] text-text-muted hover:text-text"
              aria-label={reveal ? 'Hide password' : 'Show password'}
            >
              {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          <label className="flex items-center gap-2 text-sm text-text-muted">
            <input
              type="checkbox"
              checked={showKeyboard}
              onChange={(e) => setShowKeyboard(e.target.checked)}
              className="accent-primary"
            />
            Enable Virtual Keyboard
          </label>
          {showKeyboard && (
            <VirtualKeyboard
              onKey={(ch) => setValue('password', password + ch, { shouldValidate: true })}
              onBackspace={() => setValue('password', password.slice(0, -1), { shouldValidate: true })}
            />
          )}

          <div className="space-y-2">
            <span className="text-sm font-medium text-text">
              CAPTCHA<span className="ml-0.5 text-text-muted">*</span>
            </span>
            <Captcha
              onChange={(code) => {
                setCaptchaCode(code);
                captchaRef.current = code;
              }}
            />
            <Input
              placeholder="Enter the characters above"
              value={captchaInput}
              onChange={(e) => setCaptchaInput(e.target.value)}
              aria-label="CAPTCHA answer"
            />
            <span className="sr-only">{captchaCode}</span>
          </div>

          <div className="space-y-1">
            <label htmlFor="mock-country" className="text-sm font-medium text-text">
              Mock VPN location <span className="text-text-muted">(demo)</span>
            </label>
            <select
              id="mock-country"
              value={mockCountry}
              onChange={(e) => onMockCountryChange(e.target.value)}
              className="w-full rounded-[var(--radius-input)] border border-border bg-bg px-3 py-2 text-sm text-text focus:border-accent focus:outline-none"
            >
              {MOCK_COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-text-muted">
              Simulates the login originating from this country for fraud scoring.
            </p>
          </div>

          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? 'Signing in…' : 'Login'}
          </Button>

          <div className="flex flex-wrap justify-between gap-2 text-sm">
            <Link href="/forgot-password" className="text-accent hover:underline">
              Forgot Login Password?
            </Link>
            <Link href="/unlock" className="text-accent hover:underline">
              Unlock Me
            </Link>
            <Link href="/forgot-user-id" className="text-accent hover:underline">
              Forgot User Id?
            </Link>
          </div>
        </form>
        <p className="max-w-md text-center text-xs text-text-muted">
          Demo login — Customer <span className="tabular">83840226</span>, User{' '}
          <span className="tabular">TARAKESH</span>, Password{' '}
          <span className="tabular">Finspark@123</span>
        </p>
        {/* Demo-only. Self-hides when the backend runner is not mounted. */}
        {process.env.NEXT_PUBLIC_DEMO_TEST_RUNNER === 'true' && <DemoTestPanel />}
      </main>
    </div>
  );
}
