'use client';

import { forwardRef, useId, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  required?: boolean;
  error?: string;
  hint?: string;
}

/**
 * Input — floating label, 1px border, accent focus ring, inline error below.
 * Required marker is a subtle `*` in muted text, not shouting red. (§11)
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, required, error, hint, id, ...props }, ref) => {
    const generatedId = useId();
    const inputId = id ?? generatedId;
    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-text">
            {label}
            {required && <span className="ml-0.5 text-text-muted">*</span>}
          </label>
        )}
        <input
          id={inputId}
          ref={ref}
          aria-invalid={!!error}
          className={cn(
            'h-10 w-full rounded-[var(--radius-input)] border bg-surface px-3 text-sm text-text',
            'placeholder:text-text-muted/60',
            'focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent',
            'disabled:opacity-50',
            error ? 'border-risk-critical' : 'border-border',
            className,
          )}
          {...props}
        />
        {error ? (
          <p className="text-xs text-risk-critical">{error}</p>
        ) : (
          hint && <p className="text-xs text-text-muted">{hint}</p>
        )}
      </div>
    );
  },
);
Input.displayName = 'Input';
