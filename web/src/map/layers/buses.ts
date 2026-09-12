import * as Cesium from 'cesium';
import type { Lang } from '../../lib/types';

/**
 * Toei bus layer. OFF by default — the demo opens on the light rail map.
 *
 * HONESTY, first and load-bearing: these positions are NOT GPS. ODPT publishes
 * no coordinates for Toei vehicles, so A11 derives a position by interpolating
 * along the real road geometry between the last and next stop at a measured
 * median 12.3 km/h (p25 8.7 / p75 16.6, from 416 scheduled legs). A mid-leg
 * vehicle can therefore be out by roughly ±30% of the leg length. The map has to
 * SHOW that rather than imply live tracking (AGENT-BRIEF rule 5), so:
 *   - `at-stop` buses (a known, exact position) render as a solid marker;
 *   - `interpolated` buses render hollow and softer, i.e. visibly an estimate;
 *   - every entity carries positionNote/positionSource for the inspector card.
 *
 * Rendering budget: vehicles are billboards sharing ONE canvas image per state,
 * so 360 vehicles cost two texture-atlas entries, not 360.
 */

const BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');

export interface BusProps {
  busId: string;
  busNumber: string | null;
  routeId: string;
  routeLabel: string;
  routeLabelJa: string | null;
  nextStopName: string | null;
  nextStopNameJa: string | null;
  fromStop: string | null;
  toStop: string | null;
  operator: string | null;
  updatedAt: string | null;
  positionSource: 'interpolated' | 'at-stop' | string;
  positionMethod?: string | null;
  positionNote?: string | null;
  legFraction?: number | null;
  bearing?: number | null;
  stale?: boolean;
}

export interface BusFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] } | null;
  properties: BusProps;
}

export interface BusCollection {
  type: 'FeatureCollection';
  features: BusFeature[];
  meta?: { source?: string; generatedAt?: string; degraded?: boolean; note?: string | null };
}

export interface BusRouteFeature {
  type: 'Feature';
  geometry:
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'MultiLineString'; coordinates: [number, number][][] }
    | null;
  properties: {
    routeId: string; patternId?: string; routeCode?: string;
    routeLabelJa?: string; geometrySource?: string;
  };
}

export interface BusRouteCollection { type: 'FeatureCollection'; features: BusRouteFeature[] }

/** Vehicles only. The server already caps this at ~360; never request `?all=1`. */
export async function fetchBuses(signal?: AbortSignal): Promise<BusCollection | null> {
  try {
    const res = await fetch(BASE + '/buses.geojson', { signal });
    if (!res.ok) return null;
    return (await res.json()) as BusCollection;
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') console.warn('[map] /buses.geojson unavailable', e);
    return null;
  }
}

/** One route's shape. Scoped by routeId on purpose — `?all=1` is 651 features. */
export async function fetchBusRoute(routeId: string, signal?: AbortSignal): Promise<BusRouteCollection | null> {
  try {
    const res = await fetch(BASE + '/busroutes.geojson?routeId=' + encodeURIComponent(routeId), { signal });
    if (!res.ok) return null;
    return (await res.json()) as BusRouteCollection;
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') console.warn('[map] /busroutes.geojson unavailable', e);
    return null;
  }
}

/* ---------------- marker images ---------------- */
/** Built once and reused by every vehicle: two atlas entries total, not 360. */
let solidImg: HTMLCanvasElement | null = null;
let hollowImg: HTMLCanvasElement | null = null;

function squareCanvas(fill: string, stroke: string, solid: boolean): HTMLCanvasElement {
  const s = 16;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const g = c.getContext('2d');
  if (!g) return c;
  const r = 3;
  const pad = 2.5;
  const w = s - pad * 2;
  g.beginPath();
  // rounded square — deliberately not a circle, so a vehicle never reads as a station
  g.moveTo(pad + r, pad);
  g.lineTo(pad + w - r, pad);
  g.quadraticCurveTo(pad + w, pad, pad + w, pad + r);
  g.lineTo(pad + w, pad + w - r);
  g.quadraticCurveTo(pad + w, pad + w, pad + w - r, pad + w);
  g.lineTo(pad + r, pad + w);
  g.quadraticCurveTo(pad, pad + w, pad, pad + w - r);
  g.lineTo(pad, pad + r);
  g.quadraticCurveTo(pad, pad, pad + r, pad);
  g.closePath();
  if (solid) { g.fillStyle = fill; g.fill(); }
  g.lineWidth = solid ? 1.5 : 2;
  g.strokeStyle = stroke;
  g.stroke();
  return c;
}

function images(): { solid: HTMLCanvasElement; hollow: HTMLCanvasElement } {
  // at-stop = known position -> solid. interpolated = estimate -> hollow.
  if (!solidImg) solidImg = squareCanvas('rgba(255,170,0,0.85)', '#ffd27f', true);
  if (!hollowImg) hollowImg = squareCanvas('rgba(0,0,0,0)', 'rgba(255,170,0,0.9)', false);
  return { solid: solidImg, hollow: hollowImg };
}

/* ---------------- render ---------------- */

/** Draw the live vehicles. Returns the number of markers drawn. */
export function renderBuses(
  ds: Cesium.CustomDataSource,
  fc: BusCollection | null,
  lang: Lang,
  selectedBusId: string | null,
): number {
  ds.entities.removeAll();
  if (!fc || !Array.isArray(fc.features)) return 0;
  const { solid, hollow } = images();
  let drawn = 0;

  ds.entities.suspendEvents();
  try {
    for (const f of fc.features) {
      const p = f.properties;
      const g = f.geometry;
      if (!p || !g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      const [lon, lat] = g.coordinates;
      if (typeof lon !== 'number' || typeof lat !== 'number') continue;

      const atStop = p.positionSource === 'at-stop';
      // positionNote is only populated for the overdue/at-stop cases (57 of 357
      // in the live payload) and positionMethod is never populated, so build an
      // honest description for EVERY vehicle rather than leaving most blank.
      const next = (lang === 'ja' && p.nextStopNameJa ? p.nextStopNameJa : p.nextStopName) || null;
      const pct = typeof p.legFraction === 'number' ? Math.round(p.legFraction * 100) : null;
      const how = atStop
        ? 'At a stop — position known'
        : 'Estimated position'
          + (pct !== null ? ' (~' + pct + '% along the leg' + (next ? ' to ' + next : '') + ')' : '')
          + ' — interpolated from the timetable at a measured 12.3 km/h median. Not GPS.';
      const note = [how, p.positionNote || null].filter(Boolean).join(' · ');
      const selected = !!selectedBusId && selectedBusId === p.busId;
      const label = (lang === 'ja' && p.routeLabelJa ? p.routeLabelJa : p.routeLabel) || p.busId;

      try {
        ds.entities.add({
          id: 'bus:' + p.busId,
          name: label,
          description: note,
          properties: {
            kind: 'bus',
            busId: p.busId,
            routeId: p.routeId,
            positionSource: p.positionSource,
            legFraction: typeof p.legFraction === 'number' ? p.legFraction : null,
          },
          position: Cesium.Cartesian3.fromDegrees(lon, lat, 30),
          billboard: {
            image: atStop ? solid : hollow,
            width: selected ? 20 : 13,
            height: selected ? 20 : 13,
            color: selected ? Cesium.Color.WHITE : Cesium.Color.WHITE.withAlpha(atStop ? 1 : 0.85),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            // Vehicles are city-scale detail; hide them from far out so they
            // never turn the country view into a smear of dots.
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 120_000),
          },
        });
        drawn += 1;
      } catch (err) {
        console.warn('[map] bus entity failed for ' + p.busId, err);
      }
    }
  } finally {
    ds.entities.resumeEvents();
  }
  return drawn;
}

/**
 * Draw one bus route's road-following shape. A11 confirmed BusroutePattern
 * carries real `ug:region` geometry for 748 of 757 patterns, so these follow
 * actual roads; the 9 that do not are flagged by `geometrySource`.
 */
export function renderBusRoute(
  ds: Cesium.CustomDataSource,
  fc: BusRouteCollection | null,
): number {
  ds.entities.removeAll();
  if (!fc || !Array.isArray(fc.features)) return 0;
  const color = Cesium.Color.fromCssColorString('#ffaa00');
  let drawn = 0;

  ds.entities.suspendEvents();
  try {
    fc.features.forEach((f, i) => {
      const g = f.geometry;
      if (!g) return;
      const parts = g.type === 'LineString' ? [g.coordinates] : g.coordinates;
      parts.forEach((seg, j) => {
        if (!Array.isArray(seg) || seg.length < 2) return;
        const flat: number[] = [];
        for (const c of seg) {
          if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
          flat.push(c[0], c[1], 12);
        }
        if (flat.length < 6) return;
        try {
          ds.entities.add({
            id: 'busroute:' + (f.properties?.patternId || f.properties?.routeId || i) + ':' + j,
            properties: { kind: 'busroute', routeId: f.properties?.routeId },
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
              width: 4,
              clampToGround: false,
              material: new Cesium.ColorMaterialProperty(color.withAlpha(0.75)),
            },
          });
          drawn += 1;
        } catch { /* one bad pattern must not kill the route */ }
      });
    });
  } finally {
    ds.entities.resumeEvents();
  }
  return drawn;
}
