import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** Header the id travels on, inbound from the frontend and outbound to Sentinel. */
export const CORRELATION_HEADER = 'x-correlation-id';

interface Store {
  correlationId: string;
}

/**
 * Request-scoped correlation id (ENHANCEMENTS.md §3).
 *
 * A payment crosses Next.js -> NestJS -> Sentinel (Python) -> Redis. Without a
 * shared id, "why was this held?" means correlating four logs by timestamp.
 *
 * AsyncLocalStorage rather than a threaded parameter: the id has to reach
 * http-scorer.ts, which sits four call frames below the controller behind an
 * interface (`Scorer`) that deliberately knows nothing about HTTP. Passing it
 * explicitly would mean putting a transport concern into the scoring contract.
 */
const storage = new AsyncLocalStorage<Store>();

/** Run `fn` with `correlationId` bound to the current async context. */
export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** The current request's id, or undefined outside a request (cron, boot). */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/**
 * Accept a caller-supplied id so a trace can start at the browser, but only if
 * it is plausibly one of ours — an unvalidated header ends up in log lines and
 * outbound requests, so it must not carry newlines or unbounded length.
 */
export function sanitiseCorrelationId(raw: unknown): string {
  if (typeof raw !== 'string') return randomUUID();
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(trimmed)) return randomUUID();
  return trimmed;
}

/** A tag for log lines: `[abc12345] message`. Empty outside a request. */
export function logTag(): string {
  const id = currentCorrelationId();
  return id ? `[${id.slice(0, 8)}] ` : '';
}
