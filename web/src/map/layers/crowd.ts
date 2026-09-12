import * as Cesium from 'cesium';
import type { StationCollection } from '../../lib/geo';
import type { Lang } from '../../lib/types';
import { css } from '../colors';

/** ridershipBand 1..5 -> marker pixel size. */
const BAND_PX: Record<number, number> = { 1: 6, 2: 9, 3: 12, 4: 15, 5: 18 };

/**
 * Camera distance (m) at which a band's label starts showing. Busiest first:
 * at the 40,000m demo view only the major interchanges are named, and detail
 * appears as the presenter zooms — which also shows off the continuous zoom.
 */
const BAND_LABEL_DISTANCE: Record<number, number> = {
  5: 100_000,
  4: 50_000,
  3: 25_000,
  2: 12_000,
  1: 6_000,
};

/**
 * Ground separation required between two labels, as a fraction of the camera
 * distance at which they appear. Derived from screen geometry: visible ground
 * width ~= 2*d*tan(fov/2), so a fixed pixel gap is a fixed fraction of d.
 * 0.045 ~= a 75px gap on a 1900px canvas. Tunable without a rebuild.
 */
const LABEL_SPACING = (() => {
  const n = Number(import.meta.env.VITE_LABEL_SPACING);
  return Number.isFinite(n) && n > 0 ? n : 0.045;
})();

/** Stations closer than this AND sharing a name are the same physical station. */
const DEDUPE_M = 400;

interface Spot {
  stationId: string;
  name: string;
  nameJa: string | null;
  lat: number;
  lon: number;
  band: number;
  lineIds: string[];
  ward: string | null;
}

function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dy = (aLat - bLat) * 111_320;
  const dx = (aLon - bLon) * 111_320 * Math.cos((aLat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/**
 * Collapse transfer stations. A station served by two Toei lines arrives as two
 * point features a few tens of metres apart with the same name (measured here:
 * 8 such pairs at 54-286m). Drawing and labelling both stacks text on itself —
 * the same failure that made the warning labels a black smear. One physical
 * location, one marker, one label; the served lines are merged so the
 * line-selection highlight still lights every platform of an interchange.
 */
function dedupe(fc: StationCollection): Spot[] {
  const spots: Spot[] = [];
  for (const f of fc.features) {
    const p = f.properties;
    const g = f.geometry;
    if (!p || !g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
    const [lon, lat] = g.coordinates;
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;
    const band = Math.max(1, Math.min(5, Math.round(p.ridershipBand || 1)));

    const hit = spots.find(
      (s) => s.name === p.name && metres(s.lat, s.lon, lat, lon) < DEDUPE_M,
    );
    if (hit) {
      hit.band = Math.max(hit.band, band);
      for (const id of p.lineIds || []) if (hit.lineIds.indexOf(id) < 0) hit.lineIds.push(id);
      if (!hit.nameJa && p.nameJa) hit.nameJa = p.nameJa;
      continue;
    }
    spots.push({
      stationId: p.stationId,
      name: p.name,
      nameJa: p.nameJa ?? null,
      lat,
      lon,
      band,
      lineIds: [...(p.lineIds || [])],
      ward: p.ward ?? null,
    });
  }
  return spots;
}

/**
 * Decide which spots get a label. Greedy, busiest first: a label is kept only if
 * no already-kept label sits within its own separation radius. Higher bands are
 * considered first and claim the larger radii, so a dense cluster resolves to
 * its most important station rather than to whichever happened to be first in
 * the file. Computed once per render, not per frame.
 */
function chooseLabels(spots: Spot[]): Set<string> {
  const ordered = [...spots].sort((a, b) => b.band - a.band);
  const kept: Spot[] = [];
  const ids = new Set<string>();
  for (const s of ordered) {
    const sep = (BAND_LABEL_DISTANCE[s.band] ?? 6000) * LABEL_SPACING;
    let clash = false;
    for (const k of kept) {
      if (metres(s.lat, s.lon, k.lat, k.lon) < sep) { clash = true; break; }
    }
    if (clash) continue;
    kept.push(s);
    ids.add(s.stationId);
  }
  return ids;
}

/**
 * Station crowd markers, pixel size driven by ridershipBand, with decluttered
 * station-name labels. Returns the number of markers drawn.
 */
export function renderCrowd(
  ds: Cesium.CustomDataSource,
  fc: StationCollection | null,
  highlightLineId: string | null,
  lang: Lang = 'en',
): number {
  ds.entities.removeAll();
  if (!fc || !Array.isArray(fc.features)) return 0;

  const spots = dedupe(fc);
  const labelled = chooseLabels(spots);
  const accent = css('#00b4ff');
  const base = css('#7dd3fc');
  let drawn = 0;
  let labels = 0;

  ds.entities.suspendEvents();
  try {
    for (const s of spots) {
      const size = BAND_PX[s.band] ?? 6;
      const onLine = !!highlightLineId && s.lineIds.indexOf(highlightLineId) >= 0;
      const dim = !!highlightLineId && !onLine;
      const color = onLine ? accent : base;

      // Never render the string "null": fall back to the romanised name.
      const text = (lang === 'ja' && s.nameJa ? s.nameJa : s.name) || '';
      const far = BAND_LABEL_DISTANCE[s.band] ?? 6000;
      const showLabel = labelled.has(s.stationId) && !!text && !dim;

      try {
        ds.entities.add({
          id: 'station:' + s.stationId,
          name: s.name,
          description: (s.ward || '') + ' / band ' + s.band,
          properties: { kind: 'station', stationId: s.stationId, lat: s.lat, lon: s.lon },
          position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 20),
          point: {
            pixelSize: onLine ? size + 4 : size,
            color: color.withAlpha(dim ? 0.12 : 0.55),
            outlineColor: color.withAlpha(dim ? 0.2 : 0.95),
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: showLabel
            ? {
              text,
              font: '600 11px "JetBrains Mono", ui-monospace, monospace',
              fillColor: onLine ? accent : Cesium.Color.fromCssColorString('#e0e0e0'),
              // NO text outline. Cesium renders entity labels through a signed
              // distance field atlas, and FILL_AND_OUTLINE bleeds neighbouring
              // glyphs out of that atlas — on screen it is a dense black scribble
              // over the station, which is exactly the smear we already fixed in
              // warnings.ts. A background chip gives contrast on both the light
              // GSI basemap and the dark satellite one, with no outline at all.
              style: Cesium.LabelStyle.FILL,
              showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString('rgba(5,8,11,0.82)'),
              backgroundPadding: new Cesium.Cartesian2(5, 3),
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              pixelOffset: new Cesium.Cartesian2(0, -(size / 2) - 6),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, far),
              // Soft fade in over the last 30% rather than a hard pop.
              translucencyByDistance: new Cesium.NearFarScalar(far * 0.7, 1.0, far, 0.0),
            }
            : undefined,
        });
        drawn += 1;
        if (showLabel) labels += 1;
      } catch (err) {
        console.warn('[map] station entity failed for ' + s.stationId, err);
      }
    }
  } finally {
    ds.entities.resumeEvents();
  }

  console.info(
    '[map] crowd: ' + fc.features.length + ' features -> ' + drawn + ' markers ('
    + (fc.features.length - drawn) + ' transfer duplicates merged), ' + labels + ' labels',
  );
  return drawn;
}
