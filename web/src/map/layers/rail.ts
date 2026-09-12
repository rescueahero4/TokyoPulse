import * as Cesium from 'cesium';
import type { LineCollection } from '../../lib/geo';
import { railDecimation, railPaths, railPathsForCollection } from '../../lib/geo';
import { css, statusColor } from '../colors';

const DIM_ALPHA = 0.15;

/** Metres. From VITE_RAIL_SIMPLIFY_M — see geo.ts for why this is invisible at city scale. */
const SIMPLIFY_M = (() => {
  const n = Number(import.meta.env.VITE_RAIL_SIMPLIFY_M);
  return Number.isFinite(n) && n >= 0 ? n : 15;
})();

/**
 * Rail polylines, coloured by status. When a line is selected by search it
 * renders thicker in its own properties.color and everything else drops to
 * alpha 0.15.
 *
 * Perf notes (this layer was the map's bottleneck):
 *  - geometry is merged + Douglas-Peucker simplified in geo.ts before it gets
 *    here, so we draw tens of polylines instead of 5,651;
 *  - `clampToGround` is OFF. Ground-clamped polylines render through terrain
 *    classification primitives, which is what made drag/zoom feel sticky. We
 *    run on an EllipsoidTerrainProvider (flat), so a tiny constant height looks
 *    identical and costs nothing. Same call godseye makes (Globe.jsx:796).
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
    for (const f of fc.features) {
      const p = f.properties;
      if (!p) continue;
      const paths = railPaths(f, SIMPLIFY_M);
      if (paths.length === 0) continue;

      const selected = !!selectedLineId && selectedLineId === p.lineId;
      const dim = !!selectedLineId && !selected;
      const base = selected ? css(p.color || '#00b4ff') : statusColor(p.status);
      const color = dim ? base.withAlpha(DIM_ALPHA) : base.withAlpha(0.95);
      const width = selected ? 7 : 3;

      paths.forEach((path, i) => {
        const flat: number[] = [];
        for (const c of path) flat.push(c[0], c[1], 6);
        if (flat.length < 6) return;
        try {
          ds.entities.add({
            id: 'rail:' + p.lineId + ':' + i,
            name: p.name,
            description: p.statusText || '',
            properties: { kind: 'line', lineId: p.lineId },
            polyline: {
              positions: Cesium.Cartesian3.fromDegreesArrayHeights(flat),
              width,
              clampToGround: false,
              material: new Cesium.ColorMaterialProperty(color),
              zIndex: selected ? 20 : 10,
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
