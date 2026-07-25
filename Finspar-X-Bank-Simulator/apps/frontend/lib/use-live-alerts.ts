'use client';

import { useEffect, useRef, useState } from 'react';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface LiveAlert {
  id: string;
  at: string;
  correlationId?: string;
  eventType: string;
  riskScore: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  decision: string;
  reasons: string[];
  userId?: string;
  paymentId?: string;
  amount?: string;
  refNo?: string;
}

export type StreamStatus = 'connecting' | 'live' | 'offline';

/**
 * Subscribe to the analyst verdict stream (ENHANCEMENTS.md §6).
 *
 * `withCredentials` is what makes this work at all: EventSource cannot set an
 * Authorization header, so a bearer-token API would have forced the JWT into the
 * query string — i.e. into every proxy and access log on the path. Now that the
 * session is a cookie (§4), the browser attaches it automatically and the stream
 * is authenticated like any other request.
 *
 * `onAlert` is held in a ref so a caller passing an inline closure does not tear
 * down and rebuild the connection on every render.
 */
export function useLiveAlerts(onAlert?: (alert: LiveAlert) => void): {
  alerts: LiveAlert[];
  status: StreamStatus;
} {
  const [alerts, setAlerts] = useState<LiveAlert[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const handler = useRef(onAlert);
  handler.current = onAlert;

  useEffect(() => {
    const source = new EventSource(`${API_URL}/api/analyst/stream`, { withCredentials: true });

    source.onopen = () => setStatus('live');

    source.onmessage = (e: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(e.data) as LiveAlert | { at: string };
        // Keep-alive frames carry only a timestamp; they prove liveness but are
        // not alerts and must not enter the list.
        if (!('id' in payload)) {
          setStatus('live');
          return;
        }
        setStatus('live');
        // Cap the buffer: a long-lived console on a busy system would otherwise
        // grow this array without bound.
        setAlerts((prev) => [payload, ...prev].slice(0, 100));
        handler.current?.(payload);
      } catch {
        // A malformed frame is not worth tearing the stream down for.
      }
    };

    // EventSource reconnects on its own; reflect the gap rather than fighting it.
    source.onerror = () => setStatus('offline');

    return () => source.close();
  }, []);

  return { alerts, status };
}
