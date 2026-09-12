import type {
  Brief, Forecast, Impact, LayerState, LineProps, Meta, PulseEvent, SandboxInfo, TimeWindow,
} from './types';
import type { LineCollection, StationCollection } from './geo';
import { hasGeometry } from './geo';

const BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');
export const FORCE_MOCKS = String(import.meta.env.VITE_USE_MOCKS) === 'true';
const TIMEOUT_MS = 6000;

/** Where a payload actually came from, for honest labelling. */
export type Origin = 'api' | 'mock' | 'fallback' | 'none';

export interface Loaded<T> { data: T; origin: Origin }

function nowIso(): string {
  return new Date().toISOString();
}

function mkMeta(source: Meta['source'], degraded: boolean, note: string | null): Meta {
  return { source, generatedAt: nowIso(), degraded, note };
}

/** Stamp/repair meta so the UI can always read meta.degraded without a null check. */
function stampMeta<T extends { meta?: Meta }>(payload: T, origin: Origin, note: string | null): T {
  const existing = payload && typeof payload === 'object' ? payload.meta : undefined;
  if (origin === 'api') {
    if (existing && typeof existing.source === 'string') return payload;
    payload.meta = mkMeta('live', false, null);
    return payload;
  }
  payload.meta = {
    source: 'mock',
    generatedAt: existing?.generatedAt || nowIso(),
    degraded: true,
    note,
  };
  return payload;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { Accept: 'application/json', ...(init?.headers || {}) },
    });
    if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fallback ladder (AGENT-BRIEF rule 3 / ladder #7):
 *   1. live API at VITE_API_BASE_URL   (skipped entirely when VITE_USE_MOCKS=true)
 *   2. A5-DATA's checked-in mock under /mock/*  (served by the vite dev middleware)
 *   3. our own snapshot under /fallback/*  (built from the checked-in mock/raw ODPT data)
 *   4. a hardcoded built-in, so the layer renders an honest empty state
 * Never throws. Never returns undefined.
 */
async function load<T extends { meta?: Meta }>(
  apiPath: string | null,
  mockUrls: string[],
  validate: (j: unknown) => boolean,
  builtin: () => T,
): Promise<Loaded<T>> {
  if (apiPath && !FORCE_MOCKS) {
    try {
      const j = await getJson(BASE + apiPath);
      if (validate(j)) return { data: stampMeta(j as T, 'api', null), origin: 'api' };
      console.warn('[api] ' + apiPath + ' returned an unusable shape - falling back to mock');
    } catch (e) {
      console.warn('[api] ' + apiPath + ' unavailable (' + (e instanceof Error ? e.message : e) + ') - falling back to mock');
    }
  }
  for (const url of mockUrls) {
    try {
      const j = await getJson(url);
      if (validate(j)) {
        const origin: Origin = url.indexOf('/fallback') === 0 ? 'fallback' : 'mock';
        const note = origin === 'fallback'
          ? 'API and mock unavailable - serving checked-in ODPT snapshot'
          : FORCE_MOCKS ? 'VITE_USE_MOCKS=true - mock payload' : 'API unavailable - serving checked-in mock';
        return { data: stampMeta(j as T, origin, note), origin };
      }
    } catch {
      /* try the next rung */
    }
  }
  return { data: stampMeta(builtin(), 'none', 'no data source reachable'), origin: 'none' };
}

const isObj = (j: unknown): j is Record<string, unknown> => !!j && typeof j === 'object';
const hasArray = (k: string) => (j: unknown) => isObj(j) && Array.isArray(j[k]);
const isFc = (j: unknown) => isObj(j) && Array.isArray((j as { features?: unknown }).features);

// ---------------------------------------------------------------- endpoints

export interface EventsPayload {
  events: PulseEvent[];
  counts: Record<string, number>;
  meta: Meta;
}

export function fetchEvents(window: TimeWindow, limit = 60): Promise<Loaded<EventsPayload>> {
  return load<EventsPayload>(
    '/events.json?window=' + encodeURIComponent(window) + '&limit=' + limit,
    ['/mock/events.json'],
    hasArray('events'),
    () => ({ events: [], counts: {}, meta: mkMeta('mock', true, 'no events source') }),
  );
}

/** Lines must carry geometry to be useful to the rail layer; a geometry-less payload drops a rung. */
export async function fetchLines(): Promise<Loaded<LineCollection>> {
  const withGeom = (j: unknown) => isFc(j) && hasGeometry(j as LineCollection);
  const res = await load<LineCollection>(
    '/lines.geojson',
    ['/mock/lines.geojson', '/fallback/lines.geojson'],
    withGeom,
    () => ({ type: 'FeatureCollection', features: [], meta: mkMeta('mock', true, 'no line source') }),
  );
  if (res.data.features.length > 0) return res;
  // Nothing had geometry: keep the line-search list alive from any parsable collection.
  return load<LineCollection>(null, ['/mock/lines.geojson', '/fallback/lines.geojson'], isFc, () => res.data);
}

export function fetchStations(): Promise<Loaded<StationCollection>> {
  const ok = (j: unknown) => isFc(j) && (j as StationCollection).features.length > 0;
  return load<StationCollection>(
    '/stations.geojson',
    ['/mock/stations.geojson', '/fallback/stations.geojson'],
    ok,
    () => ({ type: 'FeatureCollection', features: [], meta: mkMeta('mock', true, 'no station source') }),
  );
}

export function fetchForecast(): Promise<Loaded<Forecast>> {
  return load<Forecast>(
    '/forecast.json',
    ['/mock/forecast.json'],
    (j) => isObj(j) && Array.isArray(j.hourly),
    () => ({
      location: { lat: 35.6812, lon: 139.7671, name: 'Tokyo' },
      nowIndex: 0,
      hourly: [],
      summary: { maxPrecip24h: 0, minTemp: 0, maxTemp: 0, rainHoursNext48: 0 },
      meta: mkMeta('mock', true, 'no forecast source'),
    }),
  );
}

export function fetchBrief(): Promise<Loaded<Brief>> {
  return load<Brief>(
    '/brief',
    ['/mock/brief.json'],
    (j) => isObj(j) && typeof j.en === 'string',
    () => ({
      en: 'City brief unavailable - no data source reachable.',
      ja: '市況ブリーフは利用できません。',
      provider: 'none',
      providerLabel: 'unavailable',
      eventCount: 0,
      meta: mkMeta('mock', true, 'no brief source'),
    }),
  );
}

export interface SandboxPayload { count: number; sandboxes: SandboxInfo[]; meta: Meta }

export function fetchSandboxes(): Promise<Loaded<SandboxPayload>> {
  return load<SandboxPayload>(
    '/sandboxes.json',
    ['/mock/sandboxes.json'],
    hasArray('sandboxes'),
    () => ({ count: 0, sandboxes: [], meta: mkMeta('mock', true, 'no sandbox source') }),
  );
}

export interface LayersPayload { layers: LayerState[]; meta: Meta }

export function fetchLayers(): Promise<Loaded<LayersPayload>> {
  return load<LayersPayload>(
    '/layers.json',
    ['/mock/layers.json'],
    hasArray('layers'),
    () => ({ layers: [], meta: mkMeta('mock', true, 'no layer health source') }),
  );
}

export function fetchImpact(lineId: string): Promise<Loaded<Impact>> {
  return load<Impact>(
    '/impact/' + encodeURIComponent(lineId),
    ['/mock/impact/' + encodeURIComponent(lineId) + '.json'],
    (j) => isObj(j) && typeof j.lineId === 'string',
    () => ({
      lineId,
      name: lineId,
      nameJa: null,
      status: 'unknown',
      statusText: 'No impact data available for this line',
      wards: [],
      stations: [],
      events: [],
      stationsInFloodZone: 0,
      meta: mkMeta('mock', true, 'no impact source for this line'),
    }),
  );
}

export interface HealthPayload { ok: boolean; neo4j?: string; eventCount?: number; meta?: Meta }

export function fetchHealth(): Promise<Loaded<HealthPayload>> {
  return load<HealthPayload>(
    '/health',
    [],
    (j) => isObj(j) && 'ok' in j,
    () => ({ ok: false, neo4j: 'down', eventCount: 0, meta: mkMeta('mock', true, 'API unreachable') }),
  );
}

/** peopleflow has no data file in this build - report honest unavailability, never a fake heatmap. */
export async function probePeopleFlow(): Promise<boolean> {
  for (const url of ['/mock/peopleflow.json', '/fallback/peopleflow.json']) {
    try {
      const j = await getJson(url);
      if (isFc(j) && (j as { features: unknown[] }).features.length > 0) return true;
    } catch {
      /* not available */
    }
  }
  return false;
}

export async function postReplay(scenario: 'quake' | 'train' | 'warning'): Promise<boolean> {
  if (FORCE_MOCKS) return false;
  try {
    await getJson(BASE + '/demo/replay', {
      method: 'POST',
      body: JSON.stringify({ scenario }),
      headers: { 'Content-Type': 'application/json' },
    });
    return true;
  } catch (e) {
    console.warn('[api] /demo/replay failed', e);
    return false;
  }
}

/** Line list for LineSearch, driven by /lines.geojson per the API contract. */
export function linesFromCollection(fc: LineCollection | null): LineProps[] {
  if (!fc || !Array.isArray(fc.features)) return [];
  return fc.features
    .map((f) => f.properties)
    .filter((p): p is LineProps => !!p && typeof p.lineId === 'string');
}
