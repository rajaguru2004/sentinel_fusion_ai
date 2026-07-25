'use client';

import { useEffect, useState } from 'react';

type Level = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

const COLOR: Record<Level, string> = {
  LOW: 'var(--risk-low)',
  MEDIUM: 'var(--risk-medium)',
  HIGH: 'var(--risk-high)',
  CRITICAL: 'var(--risk-critical)',
};

/**
 * Signature moment (§11) — animated 0–100 risk arc, colour-shifting by band,
 * with plain-language reason chips. Animates from 0 on reveal; respects
 * prefers-reduced-motion.
 */
export function RiskMeter({
  score,
  level,
  reasons,
}: {
  score: number; // 0..1
  level: Level;
  reasons: string[];
}) {
  const target = Math.round(score * 100);
  const [value, setValue] = useState(0);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return setValue(target);
    let raf = 0;
    const start = performance.now();
    const tick = (t: number): void => {
      const p = Math.min(1, (t - start) / 700);
      setValue(Math.round(target * p));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  const R = 52;
  const C = Math.PI * R; // half-circle circumference
  const offset = C - (value / 100) * C;
  const color = COLOR[level];

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative" style={{ width: 140, height: 84 }}>
        <svg width="140" height="84" viewBox="0 0 140 84">
          <path d="M 14 76 A 52 52 0 0 1 126 76" fill="none" stroke="var(--border)" strokeWidth="10" strokeLinecap="round" />
          <path
            d="M 14 76 A 52 52 0 0 1 126 76"
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={C}
            strokeDashoffset={offset}
            style={{ transition: 'stroke 300ms' }}
          />
        </svg>
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center">
          <span className="text-3xl font-semibold tabular" style={{ color }}>
            {value}
          </span>
          <span className="text-xs font-medium" style={{ color }}>
            {level}
          </span>
        </div>
      </div>
      {reasons.length > 0 && (
        <div className="flex flex-wrap justify-center gap-1.5">
          {reasons.map((r, i) => (
            <span
              key={i}
              className="rounded-full border px-2.5 py-0.5 text-xs"
              style={{ borderColor: color, color }}
            >
              {r}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
