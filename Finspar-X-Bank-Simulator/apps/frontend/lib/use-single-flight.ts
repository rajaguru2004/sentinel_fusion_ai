'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Runs an async action at most once at a time (ENHANCEMENTS.md §6).
 *
 * A `busy` boolean in state is not enough on its own. `setBusy(true)` does not
 * take effect until React re-renders, so two clicks dispatched in the same tick
 * both see `busy === false` and both fire — which is precisely the duplicate
 * submit that the ledger idempotency key (§1) exists to absorb. The ref here is
 * updated synchronously, so the second call is rejected before it can start.
 *
 * Returns `pending` for disabling the control, so the guard and the visual state
 * cannot drift apart.
 */
export function useSingleFlight<A extends unknown[]>(
  action: (...args: A) => Promise<void>,
): { run: (...args: A) => Promise<void>; pending: boolean } {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);

  const run = useCallback(
    async (...args: A) => {
      if (inFlight.current) return; // synchronous — wins the race against re-render
      inFlight.current = true;
      setPending(true);
      try {
        await action(...args);
      } finally {
        inFlight.current = false;
        setPending(false);
      }
    },
    [action],
  );

  return { run, pending };
}
