import * as Cesium from 'cesium';
import type { LineCollection } from '../../lib/geo';
import { lineSegments } from '../../lib/geo';
import { css, statusColor } from '../colors';

const DIM_ALPHA = 0.15;

/**
 * Rail polylines, coloured by status. When a line is selected by search it
 * renders at width 8 in its livery colour and everything else drops to alpha 0.15.
 * Returns the number of polylines drawn.
 */
export function renderRail(
  ds: Cesium.CustomDataSource,
  fc: LineCollection | null,
  selectedLineId: string | null,
): number {
  ds.entities.removeAll();
  if (!fc || !Array.isArray(fc.features)) return 0;
  let drawn = 0;

  for (const f of fc.features) {
    const p = f.properties;
    if (!p) continue;
    const segs = lineSegments(f);
    if (segs.length === 0) continue;

    const selected = !!selectedLineId && selectedLineId === p.lineId;
    const dim = !!selectedLineId && !selected;
    const base = selected ? css(p.color || '#38bdf8') : statusColor(p.status);
    const color = dim ? base.withAlpha(DIM_ALPHA) : base.withAlpha(0.95);
    const width = selected ? 8 : 4;

    segs.forEach((seg, i) => {
      const flat: number[] = [];
      for (const c of seg) {
        if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'number') continue;
        flat.push(c[0], c[1]);
      }
      if (flat.length < 4) return;
      try {
        ds.entities.add({
          id: 'rail:' + p.lineId + ':' + i,
          name: p.name,
          description: p.statusText || '',
          properties: { kind: 'line', lineId: p.lineId },
          polyline: {
            positions: Cesium.Cartesian3.fromDegreesArray(flat),
            width,
            clampToGround: true,
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
  return drawn;
}
