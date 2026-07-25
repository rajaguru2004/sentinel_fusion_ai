'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Volume2 } from 'lucide-react';

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generate(len = 6): string {
  let s = '';
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  for (let i = 0; i < len; i++) s += CHARS[arr[i] % CHARS.length];
  return s;
}

/** Client-side CAPTCHA (no external service). Reports its value to the parent for validation. */
export function Captcha({ onChange }: { onChange: (code: string) => void }) {
  const [code, setCode] = useState('');

  const refresh = useCallback(() => {
    const next = generate();
    setCode(next);
    onChange(next);
  }, [onChange]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const speak = (): void => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(code.split('').join(', '));
    window.speechSynthesis.speak(u);
  };

  return (
    <div className="flex items-center gap-2">
      <div
        className="select-none rounded-[var(--radius-input)] border border-border bg-bg px-4 py-2 font-mono text-lg tracking-[0.3em] text-text"
        style={{ fontStyle: 'italic', textDecoration: 'line-through 1px' }}
      >
        {code}
      </div>
      <button type="button" onClick={refresh} aria-label="Refresh CAPTCHA" className="rounded p-2 text-text-muted hover:text-text">
        <RefreshCw className="h-4 w-4" />
      </button>
      <button type="button" onClick={speak} aria-label="Play audio CAPTCHA" className="rounded p-2 text-text-muted hover:text-text">
        <Volume2 className="h-4 w-4" />
      </button>
    </div>
  );
}
