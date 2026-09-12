import type { LineProps } from './types';

/** GeoJSON shapes used by the map. types.ts is frozen, so map-only shapes live here. */
export interface LineStringGeom { type: 'LineString'; coordinates: [number, number][] }
export interface MultiLineStringGeom { type: 'MultiLineString'; coordinates: [number, number][][] }
export interface PointGeom { type: 'Point'; coordinates: [number, number] }

export interface LineFeature {
  type: 'Feature';
  geometry: LineStringGeom | MultiLineStringGeom | null;
  properties: LineProps;
}

export interface StationProps {
  stationId: string;
  name: string;
  nameJa: string | null;
  lineIds: string[];
  ward: string | null;
  ridership: number | null;
  ridershipBand: number;
  inFloodZone: boolean;
}

export interface StationFeature {
  type: 'Feature';
  geometry: PointGeom | null;
  properties: StationProps;
}

export interface FeatureCollection<F> {
  type: 'FeatureCollection';
  features: F[];
  meta?: import('./types').Meta;
}

export type LineCollection = FeatureCollection<LineFeature>;
export type StationCollection = FeatureCollection<StationFeature>;

/** Flatten a line feature into one or more [lon,lat] rings. */
export function lineSegments(f: LineFeature): [number, number][][] {
  const g = f.geometry;
  if (!g) return [];
  if (g.type === 'LineString') return g.coordinates && g.coordinates.length > 1 ? [g.coordinates] : [];
  if (g.type === 'MultiLineString') return (g.coordinates || []).filter((s) => s && s.length > 1);
  return [];
}

export function hasGeometry(fc: LineCollection | null): boolean {
  if (!fc || !Array.isArray(fc.features)) return false;
  return fc.features.some((f) => lineSegments(f).length > 0);
}

/* ------------------------------------------------------------------ *
 * Rail geometry decimation
 *
 * /lines.geojson ships full-resolution OSM way geometry stitched per line:
 * 20 features -> 5,651 separate way segments -> 46,149 coordinate points.
 * One Cesium polyline entity per segment means thousands of entities, and a
 * full rebuild (every /lines poll, every line selection) costs ~500ms of
 * geometry batching — which is exactly what made drag and zoom feel sticky.
 *
 * Two passes collapse it:
 *   1. MERGE   — chain segments that share an endpoint back into long runs.
 *   2. SIMPLIFY — Ramer/Douglas-Peucker at a metre tolerance.
 * Both are pure functions of the geometry, so the result is memoized per
 * feature object and survives the 30s poll producing a fresh object.
 * ------------------------------------------------------------------ */

export type Path = [number, number][];

const M_PER_DEG_LAT = 111_320;

/** 6-decimal key: ~0.11m, finer than any rail geometry, so endpoints only merge when identical. */
function endpointKey(c: [number, number]): string {
  return c[0].toFixed(6) + ',' + c[1].toFixed(6);
}

/**
 * Chain contiguous segments head-to-tail into as few paths as possible.
 * Greedy and O(n): each segment is consumed exactly once. Branches and loops
 * simply end a chain, which is correct — they become their own path.
 */
export function mergePaths(segs: Path[]): Path[] {
  if (segs.length <= 1) return segs.map((s) => s.slice());
  // endpoint key -> segment indices touching it
  const ends = new Map<string, number[]>();
  const push = (k: string, i: number) => {
    const arr = ends.get(k);
    if (arr) arr.push(i);
    else ends.set(k, [i]);
  };
  segs.forEach((s, i) => {
    push(endpointKey(s[0]), i);
    push(endpointKey(s[s.length - 1]), i);
  });

  const used = new Uint8Array(segs.length);
  const out: Path[] = [];

  /** Find an unused segment touching `key`, oriented so it starts at `key`. */
  const take = (key: string): Path | null => {
    const cands = ends.get(key);
    if (!cands) return null;
    for (const i of cands) {
      if (used[i]) continue;
      const s = segs[i];
      if (endpointKey(s[0]) === key) { used[i] = 1; return s; }
      if (endpointKey(s[s.length - 1]) === key) { used[i] = 1; return s.slice().reverse(); }
    }
    return null;
  };

  for (let i = 0; i < segs.length; i += 1) {
    if (used[i]) continue;
    used[i] = 1;
    const chain: Path = segs[i].slice();
    // extend forward off the tail
    for (;;) {
      const next = take(endpointKey(chain[chain.length - 1]));
      if (!next) break;
      for (let k = 1; k < next.length; k += 1) chain.push(next[k]);
    }
    // extend backward off the head
    for (;;) {
      const prev = take(endpointKey(chain[0]));
      if (!prev) break;
      // prev starts at our head; walk it outward and prepend
      for (let k = 1; k < prev.length; k += 1) chain.unshift(prev[k]);
    }
    out.push(chain);
  }
  return out;
}

/**
 * Ramer-Douglas-Peucker. Tolerance is in metres; longitude is scaled by
 * cos(lat) so the error metric is isotropic at Tokyo's latitude.
 * Iterative (explicit stack) — a recursive version blows the stack on 46k points.
 */
export function simplifyPath(points: Path, toleranceM: number): Path {
  const n = points.length;
  if (n < 3 || toleranceM <= 0) return points;

  const tolDeg = toleranceM / M_PER_DEG_LAT;
  const tol2 = tolDeg * tolDeg;
  const kx = Math.cos((points[0][1] * Math.PI) / 180) || 1;

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: number[] = [0, n - 1];
  while (stack.length) {
    const last = stack.pop() as number;
    const first = stack.pop() as number;
    if (last - first < 2) continue;

    const ax = points[first][0] * kx;
    const ay = points[first][1];
    const bx = points[last][0] * kx;
    const by = points[last][1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let worst = -1;
    let worstD2 = 0;
    for (let i = first + 1; i < last; i += 1) {
      const px = points[i][0] * kx - ax;
      const py = points[i][1] - ay;
      let d2: number;
      if (len2 === 0) {
        d2 = px * px + py * py;
      } else {
        let t = (px * dx + py * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - dx * t;
        const ey = py - dy * t;
        d2 = ex * ex + ey * ey;
      }
      if (d2 > worstD2) { worstD2 = d2; worst = i; }
    }

    if (worst > 0 && worstD2 > tol2) {
      keep[worst] = 1;
      stack.push(first, worst, worst, last);
    }
  }

  const out: Path = [];
  for (let i = 0; i < n; i += 1) if (keep[i]) out.push(points[i]);
  return out;
}

interface RailCacheEntry { tol: number; paths: Path[]; points: number }
const railCache = new WeakMap<LineFeature, RailCacheEntry>();

/** Stats from the last railPaths() pass, for the perf log line. */
export const railDecimation = { rawSegments: 0, rawPoints: 0, paths: 0, points: 0 };

/**
 * Merged + simplified drawable paths for one line feature. Memoized per feature
 * object and per tolerance, so a re-render never recomputes.
 */
export function railPaths(f: LineFeature, toleranceM: number): Path[] {
  const hit = railCache.get(f);
  if (hit && hit.tol === toleranceM) return hit.paths;

  const segs = lineSegments(f).map(
    (s) => s.filter((c) => Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number'),
  ).filter((s) => s.length > 1) as Path[];

  const merged = mergePaths(segs);
  const paths = merged
    .map((p) => simplifyPath(p, toleranceM))
    .filter((p) => p.length > 1);

  let points = 0;
  for (const p of paths) points += p.length;
  railCache.set(f, { tol: toleranceM, paths, points });
  return paths;
}

/** Recompute the whole collection and refresh `railDecimation`. Cheap — all memoized. */
export function railPathsForCollection(fc: LineCollection, toleranceM: number): void {
  let rawSegments = 0;
  let rawPoints = 0;
  let paths = 0;
  let points = 0;
  for (const f of fc.features || []) {
    for (const s of lineSegments(f)) { rawSegments += 1; rawPoints += s.length; }
    for (const p of railPaths(f, toleranceM)) { paths += 1; points += p.length; }
  }
  railDecimation.rawSegments = rawSegments;
  railDecimation.rawPoints = rawPoints;
  railDecimation.paths = paths;
  railDecimation.points = points;
}
