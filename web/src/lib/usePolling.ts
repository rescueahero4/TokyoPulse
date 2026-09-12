import { useCallback, useEffect, useRef, useState } from 'react';

export interface Polled<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Poll an async fetcher on an interval. `intervalMs <= 0` fetches once only.
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

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setInterval> | null = null;

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

    setLoading(true);
    void run();
    if (intervalMs > 0) timer = setInterval(run, intervalMs);

    return () => {
      alive.current = false;
      if (timer) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, nonce, ...deps]);

  return { data, loading, error, refresh };
}
