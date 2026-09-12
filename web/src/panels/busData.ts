// Bus feature shape + a minimal loader for /buses.geojson.
//
// TEMPORARY HOME: web/src/lib/api.ts is the map/shell agent's file and does not
// expose a bus fetcher yet. App.tsx still owns the fetching (ui-contract hard
// rule 3 — no panel fetches anything); this module only provides the function it
// calls. When lib/api.ts grows a `fetchBuses`, App swaps one import and this
// file can go.
//
// Everything here fails soft: a dead endpoint returns null, and the inspector
// then says the detail is unavailable rather than inventing one.

const BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');

/** Exactly what /buses.geojson puts in feature.properties. */
export interface BusProps {
  busId: string;
  busNumber: string | null;
  routeLabel: string | null;
  routeLabelJa: string | null;
  routeId: string | null;
  patternId: string | null;
  fromStop: string | null;
  fromStopJa: string | null;
  toStop: string | null;
  nextStopName: string | null;
  nextStopNameJa: string | null;
  /** 'at-stop' = a real reported location. 'interpolated' = an estimate. */
  positionSource: 'interpolated' | 'at-stop' | string | null;
  /** How the estimate was produced, when the API says. */
  positionMethod?: string | null;
  positionNote: string | null;
  /** 0..1 along the current leg. */
  legFraction: number | null;
  legGeometry?: string | null;
  bearing?: number | null;
  departedAt?: string | null;
  updatedAt: string | null;
  validUntil?: string | null;
  stale?: boolean | null;
  operator: string | null;
}

export interface BusFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] } | null;
  properties: BusProps;
}

export interface BusCollection {
  type: 'FeatureCollection';
  features: BusFeature[];
  meta?: import('../lib/types').Meta;
}

export async function fetchBuses(): Promise<BusCollection | null> {
  try {
    const res = await fetch(`${BASE}/buses.geojson`, { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const json = (await res.json()) as BusCollection;
    if (!json || !Array.isArray(json.features)) return null;
    return json;
  } catch {
    return null;
  }
}

export function findBus(buses: BusCollection | null | undefined, busId: string): BusProps | null {
  if (!buses || !Array.isArray(buses.features)) return null;
  const hit = buses.features.find((f) => f?.properties?.busId === busId);
  return hit?.properties ?? null;
}
