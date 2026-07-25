'use client';

import { useState } from 'react';
import { Delete } from 'lucide-react';

const ROWS = [
  '1234567890'.split(''),
  'qwertyuiop'.split(''),
  'asdfghjkl'.split(''),
  'zxcvbnm'.split(''),
];

/** On-screen keypad — anti-keylogger input for the password field (§8.1). */
export function VirtualKeyboard({
  onKey,
  onBackspace,
}: {
  onKey: (ch: string) => void;
  onBackspace: () => void;
}) {
  const [shift, setShift] = useState(false);

  return (
    <div className="mt-2 space-y-1 rounded-[var(--radius-input)] border border-border bg-bg p-2">
      {ROWS.map((row, i) => (
        <div key={i} className="flex justify-center gap-1">
          {row.map((ch) => {
            const label = shift ? ch.toUpperCase() : ch;
            return (
              <button
                key={ch}
                type="button"
                onClick={() => onKey(label)}
                className="h-8 min-w-8 rounded border border-border bg-surface px-2 text-sm text-text hover:bg-primary hover:text-white"
              >
                {label}
              </button>
            );
          })}
        </div>
      ))}
      <div className="flex justify-center gap-1">
        <button
          type="button"
          onClick={() => setShift((s) => !s)}
          className={`h-8 rounded border border-border px-3 text-xs ${shift ? 'bg-primary text-white' : 'bg-surface text-text'}`}
        >
          Shift
        </button>
        <button
          type="button"
          onClick={onBackspace}
          className="flex h-8 items-center gap-1 rounded border border-border bg-surface px-3 text-xs text-text hover:bg-bg"
        >
          <Delete className="h-3.5 w-3.5" /> Back
        </button>
      </div>
    </div>
  );
}
