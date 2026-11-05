import { useCallback, useEffect, useRef, useState } from 'react';
import { whileLive } from './liveActivity';

export interface Polled<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** Like refresh, without flagging `loading`: for updates the viewer didn't ask for. */
  refetch: () => void;
}

/**
 * Poll an async fetcher on an interval, only while this viewer is active.
 * `intervalMs <= 0` fetches once only.
 * Intervals and in-flight results are cleaned up on unmount / dependency change.
 */
export function usePolling<T>(fetcher: () => Promise<T>, intervalMs: number, deps: unknown[] = []): Polled<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const silent = useRef(false);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const refetch = useCallback(() => {
    silent.current = true;
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    alive.current = true;
    let stopPolling: (() => void) | null = null;

    const run = async () => {
      try {
        const next = await fetcherRef.current();
        if (!alive.current) return;
        setData(next);
        setError(null);
      } catch (e) {
        if (!alive.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive.current) setLoading(false);
      }
    };

    if (!silent.current) setLoading(true);
    silent.current = false;
    if (intervalMs > 0) stopPolling = whileLive(() => void run(), intervalMs);
    else void run();

    return () => {
      alive.current = false;
      stopPolling?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, nonce, ...deps]);

  return { data, loading, error, refresh, refetch };
}
