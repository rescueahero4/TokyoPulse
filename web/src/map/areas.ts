// Tokyo's JMA forecast areas: the 23 wards, the Tama municipalities and the three
// island regions, from public/geo/tokyo-areas.geojson (scripts/build_tokyo_areas.py).
// Keyed by JMA area code, which is what warnings carry, so a warning always finds
// its shape. The wards are also what the weather layer paints.

import * as Cesium from 'cesium';

type Ring = [number, number][];
type Polygon = Ring[];

export type AreaLevel = 'ward' | 'municipality' | 'region';

export interface TokyoArea {
  code: string;
  level: AreaLevel;
  /** The area's own name, e.g. "Minato" or "Hachioji City". */
  name: string;
  nameJa: string;
  /** What warnings call this area: the ward itself, or "Tama area", or the island region. */
  place: string;
  placeJa: string;
  /** [lon, lat] inside the area, for labels. */
  label: [number, number];
  polygons: Polygon[];
  bounds: { west: number; south: number; east: number; north: number };
}

export type TokyoAreas = Map<string, TokyoArea>;

let loaded: TokyoAreas | null = null;
let loading: Promise<TokyoAreas | null> | null = null;

interface AreaFeature {
  properties: Omit<TokyoArea, 'polygons' | 'bounds'>;
  geometry: { coordinates: Polygon[] };
}

function boundsOf(polygons: Polygon[]): TokyoArea['bounds'] {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const rings of polygons) {
    for (const [lon, lat] of rings[0]) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return { west, south, east, north };
}

/** Resolves to null if the file can't be loaded, so layers can fall back to points. */
export function loadTokyoAreas(): Promise<TokyoAreas | null> {
  if (loaded) return Promise.resolve(loaded);
  if (!loading) {
    loading = fetch(import.meta.env.BASE_URL + 'geo/tokyo-areas.geojson')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
      .then((fc: { features: AreaFeature[] }) => {
        const out: TokyoAreas = new Map();
        for (const f of fc.features) {
          const polygons = f.geometry.coordinates;
          out.set(f.properties.code, { ...f.properties, polygons, bounds: boundsOf(polygons) });
        }
        loaded = out;
        return out;
      })
      .catch((e) => {
        console.warn('[map] Tokyo area boundaries unavailable', e);
        loading = null; // allow a later retry
        return null;
      });
  }
  return loading;
}

/** One Cesium polygon per part, with holes. GeoJSON rings repeat their first point. */
export function polygonHierarchy(rings: Polygon): Cesium.PolygonHierarchy {
  const toPositions = (ring: Ring) => Cesium.Cartesian3.fromDegreesArray(ring.slice(0, -1).flat());
  return new Cesium.PolygonHierarchy(
    toPositions(rings[0]),
    rings.slice(1).map((hole) => new Cesium.PolygonHierarchy(toPositions(hole))),
  );
}

function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The ward under a point, or null. */
export function wardAt(areas: TokyoAreas, lat: number, lon: number): TokyoArea | null {
  for (const area of areas.values()) {
    if (area.level !== 'ward') continue;
    const b = area.bounds;
    if (lon < b.west || lon > b.east || lat < b.south || lat > b.north) continue;
    for (const rings of area.polygons) {
      if (inRing(lon, lat, rings[0]) && !rings.slice(1).some((hole) => inRing(lon, lat, hole))) return area;
    }
  }
  return null;
}

export function wardArea(areas: TokyoAreas, wardName: string): TokyoArea | null {
  for (const area of areas.values()) {
    if (area.level === 'ward' && area.name === wardName) return area;
  }
  return null;
}

/**
 * Where to point the camera to see these areas. Synchronous so a click handler can
 * use it; null until the boundaries have loaded, or for codes we have no shape for.
 */
export function areasFocus(codes: string[] | null | undefined): { lat: number; lon: number; height: number } | null {
  if (!loaded || !codes?.length) return null;
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const code of codes) {
    const b = loaded.get(code)?.bounds;
    if (!b) continue;
    west = Math.min(west, b.west);
    east = Math.max(east, b.east);
    south = Math.min(south, b.south);
    north = Math.max(north, b.north);
  }
  if (!Number.isFinite(west)) return null;
  const only = codes.length === 1 ? loaded.get(codes[0]) : undefined;
  // The Ogasawara region reaches remote islands well over 1000km apart, so an island
  // region is framed on its label, which sits on its main inhabited island.
  if (only?.level === 'region') return { lat: only.label[1], lon: only.label[0], height: 400_000 };
  const spanMetres = Math.max(north - south, east - west) * 111_320;
  return { lat: (south + north) / 2, lon: (west + east) / 2, height: Math.max(15_000, spanMetres * 2.2) };
}
