'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon, RotateCcw } from 'lucide-react';
import { getLastCorrelationId } from '@/lib/api';

interface Props {
  children: ReactNode;
  /** What the user was doing, e.g. "the payment form". Used in the message. */
  area?: string;
}
interface State {
  error: Error | null;
  correlationId: string | null;
}

/**
 * Catches render-time crashes so one broken panel does not blank the app
 * (ENHANCEMENTS.md §6).
 *
 * Without a boundary, a React error unmounts the entire tree — in a banking UI
 * that means a user mid-payment sees a white screen with no indication of
 * whether their money moved. Containing the failure to the panel that caused it
 * keeps the rest of the page, and the navigation out of it, usable.
 *
 * The last correlation id is captured alongside, so a user reporting the problem
 * hands over the one string that ties their session together across all four
 * services (§3).
 *
 * Must be a class component: there is still no hook equivalent of
 * componentDidCatch.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, correlationId: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary]', error, info.componentStack);
    this.setState({ correlationId: getLastCorrelationId() });
  }

  private reset = (): void => this.setState({ error: null, correlationId: null });

  render(): ReactNode {
    const { error, correlationId } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        role="alert"
        className="rounded-[var(--radius-card)] border border-risk-critical/40 bg-risk-critical/5 p-4"
      >
        <div className="flex items-start gap-3">
          <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-risk-critical" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-risk-critical">
              Something went wrong{this.props.area ? ` in ${this.props.area}` : ''}.
            </p>
            <p className="mt-1 text-xs leading-relaxed text-text-muted">
              This is a display problem — no money moved as a result of it. If a payment was in
              progress, check Modify Payments for its current status before retrying, so you do
              not send it twice.
            </p>
            {correlationId && (
              <p className="mt-1.5 font-mono text-[11px] text-text-muted">
                Reference: {correlationId}
              </p>
            )}
            <button
              onClick={this.reset}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-[var(--radius-input)] border border-border bg-surface px-2.5 py-1 text-xs text-text hover:border-primary"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
