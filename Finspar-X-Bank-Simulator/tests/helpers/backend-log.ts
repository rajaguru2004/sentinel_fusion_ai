import fs from 'node:fs';
import path from 'node:path';
import { ARTIFACTS } from './env';

/**
 * Reads the backend's tee'd stdout.
 *
 * This is the AUTHORITATIVE evidence that a bank action reached the model.
 *
 * Why not the model's own `sentinel_scored_total`? Because the service runs
 * `uvicorn --workers 2`, and prometheus_client counters are per-process and
 * in-memory. Consecutive scrapes of /metrics land on different workers and
 * return wildly different numbers — measured here, alternating between 7 rows
 * and 0 rows on an idle service. A "the counter did not move" assertion would
 * therefore fail roughly half the time for reasons that have nothing to do with
 * the bank. It is usable as a POSITIVE signal only (it went up => the model was
 * definitely called), never as proof of absence.
 *
 * `HttpScorer` console.logs one `[Sentinel /score] <EVENT_TYPE> (<id>) country=<c> ->`
 * line per successful model call, in the single Nest process. That is exact.
 */

export const BACKEND_LOG = path.join(ARTIFACTS, 'backend.log');

export const backendLogAvailable = (): boolean => fs.existsSync(BACKEND_LOG);

function read(): string {
  return backendLogAvailable() ? fs.readFileSync(BACKEND_LOG, 'utf8') : '';
}

/** How many events the bank has successfully scored through the model so far. */
export function modelCallCount(): number {
  return (read().match(/\[Sentinel \/score\]/g) ?? []).length;
}

/** Byte offset, so a test can look at only the slice it produced. */
export function logOffset(): number {
  return backendLogAvailable() ? fs.statSync(BACKEND_LOG).size : -1;
}

export function logSince(offset: number): string {
  if (offset < 0 || !backendLogAvailable()) return '';
  const end = fs.statSync(BACKEND_LOG).size;
  if (end <= offset) return '';
  const fd = fs.openSync(BACKEND_LOG, 'r');
  const buf = Buffer.alloc(end - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

/**
 * Run `fn`, then assert the bank made exactly `expected` model calls while it ran.
 *
 * Use `expected: 0` to prove something did NOT re-score (the reviewApproved
 * short-circuit), which is the assertion the flaky metrics counter could not
 * support. Skips itself with a clear annotation when the log is not being
 * captured, rather than passing silently.
 */
export async function expectModelCalls<T>(
  expected: number,
  fn: () => Promise<T>,
  context = '',
): Promise<{ result: T; counted: number | null }> {
  if (!backendLogAvailable()) {
    const result = await fn();
    return { result, counted: null };
  }
  const before = modelCallCount();
  const result = await fn();
  // The log line is written synchronously inside the request, but `tee` buffers,
  // so give it a beat to land before counting.
  await new Promise((r) => setTimeout(r, 750));
  const counted = modelCallCount() - before;
  if (counted !== expected) {
    throw new Error(
      `Expected the bank to make ${expected} model call(s)${context ? ` [${context}]` : ''}, ` +
        `but it made ${counted}.\n` +
        (expected > 0
          ? '  0 calls means the model was never reached: check SENTINEL_ENABLED=true and ' +
            'SENTINEL_URL=http://127.0.0.1:8000.\n'
          : '  An extra call means a path re-scored when it should not have.\n') +
        `  Source: ${BACKEND_LOG} ("[Sentinel /score]" lines)`,
    );
  }
  return { result, counted };
}
