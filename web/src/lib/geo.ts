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
