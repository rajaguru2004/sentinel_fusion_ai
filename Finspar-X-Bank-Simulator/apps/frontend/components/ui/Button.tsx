import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'outline' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variants: Record<Variant, string> = {
  // solid primary, white text, subtle lift on hover (§11)
  primary:
    'bg-primary text-white shadow-sm hover:-translate-y-px hover:shadow active:translate-y-0',
  outline: 'border border-border bg-surface text-text hover:bg-bg',
  ghost: 'text-text-muted hover:bg-bg hover:text-text',
  danger: 'bg-risk-critical text-white hover:brightness-110',
};

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-10 px-4 text-sm',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-[var(--radius-input)] font-medium transition-all',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
        // disabled: reduced opacity, not battleship grey (§11)
        'disabled:pointer-events-none disabled:opacity-50',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
