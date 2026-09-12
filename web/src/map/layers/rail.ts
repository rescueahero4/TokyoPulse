import * as Cesium from 'cesium';
import type { LineCollection, LineFeature } from '../../lib/geo';
import { railDecimation, railPaths, railPathsForCollection } from '../../lib/geo';
import { css, statusColor } from '../colors';

const DIM_ALPHA = 0.15;
/** No live feed for this operator: the line keeps its identity but reads as unclaimed. */
const UNKNOWN_ALPHA = 0.35;

/** Metres. From VITE_RAIL_SIMPLIFY_M — see geo.ts for why this is invisible at city scale. */
const SIMPLIFY_M = (() => {
  const n = Number(import.meta.env.VITE_RAIL_SIMPLIFY_M);
  return Number.isFinite(n) && n >= 0 ? n : 15;
})();

/**
 * Heights, not zIndex: zIndex only applies to ground-clamped polylines and we
 * deliberately do not clamp (see the perf note below). A few metres of
 * separation is invisible from 40km but fixes the draw order exactly.
 */
const H_CASING = 4;
const H_LINE = 8;
const H_SELECTED = 12;

function flatten(path: [number, number][], height: number): number[] {
  const flat: number[] = [];
  for (const c of path) flat.push(c[0], c[1], height);
  return flat;
}

/**
 * Rail polylines painted in each line's OFFICIAL LIVERY COLOUR
 * (properties.color, sourced from contracts/lines.csv) — Tokyo's rail map is
 * recognisable by colour, and painting everything by status threw that away.
 *
 * Status is layered on top as a modifier, so PRD goal #1 still reads at a glance:
 *   normal    - solid livery, full opacity
 *   delay     - livery line over a wider semi-transparent AMBER casing
 *   suspended - dashed livery line over a wider RED casing
 *   unknown   - livery at alpha 0.35 (no keyless feed for this operator; still
 *               recognisably itself, visibly not claimed as live — AGENT-BRIEF rule 5)
 * Selection (line search) keeps working on top of all of it: the picked line goes
 * to width 7 in full livery, every other line drops to alpha 0.15.
 *
 * Perf notes (this layer was the map's bottleneck):
 *  - geometry is merged + Douglas-Peucker simplified in geo.ts before it gets
 *    here, so we draw hundreds of polylines instead of 5,651;
 *  - `clampToGround` is OFF. Ground-clamped polylines render through terrain
 *    classification primitives, which is what made drag/zoom feel sticky. We run
 *    on a flat EllipsoidTerrainProvider, so a fixed small height is identical to
 *    look at and free. Same call godseye makes (Globe.jsx:796).
 *
 * Returns the number of polylines drawn.
 */
export function renderRail(
  ds: Cesium.CustomDataSource,
  fc: LineCollection | null,
  selectedLineId: string | null,
): number {
  ds.entities.removeAll();
  if (!fc || !Array.isArray(fc.features)) return 0;

  const t0 = performance.now();
  railPathsForCollection(fc, SIMPLIFY_M);
  let drawn = 0;

  ds.entities.suspendEvents();
  try {
    for (const f of fc.features as LineFeature[]) {
      const p = f.properties;
      if (!p) continue;
      const paths = railPaths(f, SIMPLIFY_M);
      if (paths.length === 0) continue;

      const status = p.status || 'unknown';
      const selected = !!selectedLineId && selectedLineId === p.lineId;
      const dim = !!selectedLineId && !selected;

      // Livery first; status colour only as a fallback for a line with no colour.
      const livery = p.color ? css(p.color) : statusColor(status);

      let alpha = 0.95;
      let width = 3;
      if (status === 'unknown') { alpha = UNKNOWN_ALPHA; width = 2.5; }
      if (selected) { alpha = 1; width = 7; }
      if (dim) alpha = DIM_ALPHA;

      const color = livery.withAlpha(alpha);
      const height = selected ? H_SELECTED : H_LINE;

      // Casing: only for a line that has something wrong with it, and never
      // while another line is selected (it would fight the highlight).
      const casingHex = status === 'delay' ? '#f59e0b' : status === 'suspended' ? '#ef4444' : null;
      const casing = casingHex && !dim ? css(casingHex).withAlpha(selected ? 0.75 : 0.5) : null;

      const material: Cesium.MaterialProperty = status === 'suspended' && !dim
        ? new Cesium.PolylineDashMaterialProperty({
          color,
          dashLength: 18,
        })
        : new Cesium.ColorMaterialProperty(color);

      paths.forEach((path, i) => {
        if (path.length < 2) return;
        try {
          if (casing) {
            ds.entities.add({
              id: 'railcase:' + p.lineId + ':' + i,
              // No `properties.kind` — the casing must never win a pick over the line.
              polyline: {
                positions: Cesium.Cartesian3.fromDegreesArrayHeights(flatten(path, H_CASING)),
                width: width + 5,
                clampToGround: false,
                material: new Cesium.ColorMaterialProperty(casing),
              },
            });
            drawn += 1;
          }
          ds.entities.add({
            id: 'rail:' + p.lineId + ':' + i,
            name: p.name,
            description: p.statusText || '',
            properties: { kind: 'line', lineId: p.lineId },
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArrayHeights(flatten(path, height)),
              width,
              clampToGround: false,
              material,
            },
          });
          drawn += 1;
        } catch (e) {
          console.warn('[map] rail segment failed for ' + p.lineId, e);
        }
      });
    }
  } finally {
    ds.entities.resumeEvents();
  }

  console.info(
    '[map] rail: ' + railDecimation.rawSegments + ' raw segments / '
    + railDecimation.rawPoints + ' pts -> ' + drawn + ' polylines / '
    + railDecimation.points + ' pts (tol ' + SIMPLIFY_M + 'm) in '
    + (performance.now() - t0).toFixed(1) + 'ms',
  );
  return drawn;
}
