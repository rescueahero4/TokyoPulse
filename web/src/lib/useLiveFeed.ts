import { useEffect, useState } from 'react';
import { FORCE_MOCKS, tickIngest } from './api';
import { useLive } from './liveActivity';

/**
 * paused:  this viewer is hidden or idle, so it is not driving ingest
 * warming: the stored data is old and a refresh is under way or being retried
 * live:    ingest finished recently
 * off:     no hosted ingest here (snapshot builds and local runs)
 */
export type FeedPhase = 'paused' | 'warming' | 'live' | 'off';

export interface LiveFeed {
  phase: FeedPhase;
  /** Epoch seconds of the last finished ingest, from any viewer. */
  lastIngestAt: number | null;
}

const FRESH_S = 180; // ingest runs once a minute, so this tolerates a missed pass or two
const BEAT_LIVE_MS = 30_000;
const BEAT_WARMING_MS = 15_000;

const isFresh = (at: number | null) => at !== null && Date.now() / 1000 - at < FRESH_S;

/** Drives ingest while this viewer is active. The API shares the work between viewers. */
export function useLiveFeed(): LiveFeed {
  const live = useLive();
  const [lastIngestAt, setLastIngestAt] = useState<number | null>(null);
  const [supported, setSupported] = useState(!FORCE_MOCKS);

  useEffect(() => {
    if (!live || !supported) return undefined;
    let alive = true;
    let timer: number | undefined;
    const beat = async () => {
      const res = await tickIngest();
      if (!alive) return;
      if (res === 'unsupported') {
        setSupported(false);
        return;
      }
      const at = res?.lastIngestAt ?? null;
      if (at !== null) setLastIngestAt(at);
      timer = window.setTimeout(beat, isFresh(at) ? BEAT_LIVE_MS : BEAT_WARMING_MS);
    };
    void beat();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [live, supported]);

  if (!supported) return { phase: 'off', lastIngestAt: null };
  if (!live) return { phase: 'paused', lastIngestAt };
  return { phase: isFresh(lastIngestAt) ? 'live' : 'warming', lastIngestAt };
}
