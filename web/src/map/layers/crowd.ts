import * as Cesium from 'cesium';
import type { StationCollection } from '../../lib/geo';
import type { Lang } from '../../lib/types';
import { css } from '../colors';

/** ridershipBand 1..5 -> marker pixel size. */
const BAND_PX: Record<number, number> = { 1: 6, 2: 9, 3: 12, 4: 15, 5: 18 };

/**
 * Furthest camera distance (m) at which a station may be named, by importance.
 *
 * `ridershipBand` alone is no longer a good importance signal: the 239 JR/Metro
 * stations imported from OSM have no ridership data and all carry a fallback
 * band of 2 or 3, so band 4/5 is effectively Toei-only. Interchange count
 * (`lineIds.length`) is the better proxy and is populated for every station —
 * a station serving three of our lines is a major interchange whoever runs it.
 */
function importanceCeiling(interchanges: number, band: number): number {
  if (interchanges >= 3 || band >= 5) return 120_000;
  if (interchanges === 2 || band >= 4) return 60_000;
  if (band >= 3) return 30_000;
  return 18_000;
}

/** Bigger is more important; drives which station wins a crowded spot. */
function importance(s: { lineIds: string[]; band: number }): number {
  return s.lineIds.length * 10 + s.band;
}

/**
 * Ground separation required between two labels, as a fraction of the camera
 * distance at which they appear. Derived from screen geometry: visible ground
 * width ~= 2*d*tan(fov/2), so a fixed pixel gap is a fixed fraction of d.
 * 0.04 ~= a 66px gap on a 1900px canvas. Tunable without a rebuild.
 */
const LABEL_SPACING = (() => {
  const n = Number(import.meta.env.VITE_LABEL_SPACING);
  return Number.isFinite(n) && n > 0 ? n : 0.04;
})();

/** Below this the label would never realistically be read; skip the entity. */
const MIN_LABEL_DISTANCE = 600;

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
 * Give every station its OWN label display distance, rather than choosing a
 * fixed subset. This is what makes label density scale with zoom: a station is
 * named from as far out as it can be without colliding with a more important
 * neighbour, so descending steadily reveals more names instead of jumping
 * between hand-picked tiers.
 *
 * Greedy, most important first. Two labels collide when the camera distance h
 * puts them closer than `h * LABEL_SPACING` on the ground, so the furthest a
 * station can be shown before clashing with neighbour k is `dist(s,k)/SPACING`.
 * Take the tightest such limit, capped by the station's importance ceiling.
 *
 * Separation is then guaranteed at every altitude: whenever two labels are both
 * visible, h <= min(D_s, D_k) <= dist/SPACING, so the required gap is met.
 *
 * O(n^2) over ~350 stations, once per render — not per frame.
 */
function labelDistances(spots: Spot[]): Map<string, number> {
  const ordered = [...spots].sort((a, b) => importance(b) - importance(a));
  const placed: { lat: number; lon: number }[] = [];
  const out = new Map<string, number>();

  for (const s of ordered) {
    let d = importanceCeiling(s.lineIds.length, s.band);
    for (const k of placed) {
      const gap = metres(s.lat, s.lon, k.lat, k.lon) / LABEL_SPACING;
      if (gap < d) d = gap;
      if (d < MIN_LABEL_DISTANCE) break;
    }
    placed.push({ lat: s.lat, lon: s.lon });
    if (d >= MIN_LABEL_DISTANCE) out.set(s.stationId, d);
  }
  return out;
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
  showLabels = true,
): number {
  ds.entities.removeAll();
  if (!fc || !Array.isArray(fc.features)) return 0;

  const spots = dedupe(fc);
  const distances = labelDistances(spots);

  // Pinned labels bypass the declutter, so on a dense line the chips still
  // collide — the Oedo loop's stops sit ~32px apart at the altitude the camera
  // settles on. Walk the selected line in geographic order and rotate each label
  // through four sides of its dot (above / right / below / left). Two phases was
  // not enough around Shinjuku, where the stops are ~500m apart; four gives each
  // label its own quadrant without hiding anything the user just asked to see.
  const stagger = new Map<string, number>();
  if (highlightLineId) {
    const onLine = spots
      .filter((s) => s.lineIds.indexOf(highlightLineId) >= 0)
      .sort((a, b) => (a.lon - b.lon) || (a.lat - b.lat));
    onLine.forEach((s, i) => stagger.set(s.stationId, i % 4));
  }

  /** Label anchor for a pinned station: 0 above, 1 right, 2 below, 3 left. */
  const anchor = (id: string, size: number) => {
    const phase = stagger.get(id) ?? 0;
    const gap = size / 2 + 6;
    if (phase === 1) {
      return {
        h: Cesium.HorizontalOrigin.LEFT,
        v: Cesium.VerticalOrigin.CENTER,
        off: new Cesium.Cartesian2(gap, 0),
      };
    }
    if (phase === 2) {
      return {
        h: Cesium.HorizontalOrigin.CENTER,
        v: Cesium.VerticalOrigin.TOP,
        off: new Cesium.Cartesian2(0, gap),
      };
    }
    if (phase === 3) {
      return {
        h: Cesium.HorizontalOrigin.RIGHT,
        v: Cesium.VerticalOrigin.CENTER,
        off: new Cesium.Cartesian2(-gap, 0),
      };
    }
    return {
      h: Cesium.HorizontalOrigin.CENTER,
      v: Cesium.VerticalOrigin.BOTTOM,
      off: new Cesium.Cartesian2(0, -gap),
    };
  };
  const accent = css('#00b4ff');
  const base = css('#7dd3fc');
  let drawn = 0;
  let labels = 0;
  let pinned = 0;

  ds.entities.suspendEvents();
  try {
    for (const s of spots) {
      const size = BAND_PX[s.band] ?? 6;
      const onLine = !!highlightLineId && s.lineIds.indexOf(highlightLineId) >= 0;
      const dim = !!highlightLineId && !onLine;
      const color = onLine ? accent : base;

      // Never render the string "null": fall back to the romanised name.
      const text = (lang === 'ja' && s.nameJa ? s.nameJa : s.name) || '';
      // Selecting a line is exactly when the user wants its stops named, and the
      // set is small (14-42 stations), so selection OVERRIDES the declutter and
      // the distance tiers entirely: every stop on the selected line is labelled
      // at any zoom. Stations not on it lose their label along with their dot.
      const far = distances.get(s.stationId) ?? 0;
      const showLabel = showLabels && !!text && (onLine || (!highlightLineId && far > 0));

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
              horizontalOrigin: anchor(s.stationId, size).h,
              verticalOrigin: anchor(s.stationId, size).v,
              pixelOffset: anchor(s.stationId, size).off,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              // A pinned (selected-line) label has no distance limit at all.
              distanceDisplayCondition: onLine
                ? undefined
                : new Cesium.DistanceDisplayCondition(0, far),
              // Soft fade in over the last 30% rather than a hard pop.
              translucencyByDistance: onLine
                ? undefined
                : new Cesium.NearFarScalar(far * 0.7, 1.0, far, 0.0),
            }
            : undefined,
        });
        drawn += 1;
        if (showLabel) labels += 1;
        if (showLabel && onLine) pinned += 1;
      } catch (err) {
        console.warn('[map] station entity failed for ' + s.stationId, err);
      }
    }
  } finally {
    ds.entities.resumeEvents();
  }

  console.info(
    '[map] crowd: ' + fc.features.length + ' features -> ' + drawn + ' markers ('
    + (fc.features.length - drawn) + ' transfer duplicates merged), '
    + distances.size + ' labellable, ' + labels + ' labels'
    + (showLabels ? '' : ' (names OFF)')
    + (highlightLineId ? ' (' + pinned + ' pinned to ' + highlightLineId + ')' : ''),
  );
  return drawn;
}
