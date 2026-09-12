import * as Cesium from 'cesium';
import type { StationCollection } from '../../lib/geo';
import { css } from '../colors';

/** ridershipBand 1..5 -> marker pixel size. */
const BAND_PX: Record<number, number> = { 1: 6, 2: 9, 3: 12, 4: 15, 5: 18 };

/** Station crowd markers, pixel size driven by properties.ridershipBand. */
export function renderCrowd(
  ds: Cesium.CustomDataSource,
  fc: StationCollection | null,
  highlightLineId: string | null,
): number {
  ds.entities.removeAll();
  if (!fc || !Array.isArray(fc.features)) return 0;
  const accent = css('#38bdf8');
  let drawn = 0;

  for (const f of fc.features) {
    const p = f.properties;
    const g = f.geometry;
    if (!p || !g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
    const [lon, lat] = g.coordinates;
    if (typeof lon !== 'number' || typeof lat !== 'number') continue;

    const band = Math.max(1, Math.min(5, Math.round(p.ridershipBand || 1)));
    const size = BAND_PX[band] ?? 6;
    const onLine = !!highlightLineId && (p.lineIds || []).indexOf(highlightLineId) >= 0;
    const dim = !!highlightLineId && !onLine;
    const color = onLine ? accent : css('#7dd3fc');

    try {
      ds.entities.add({
        id: 'station:' + p.stationId,
        name: p.name,
        description: (p.ward || '') + ' / band ' + band,
        properties: { kind: 'station', stationId: p.stationId, lat, lon },
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 20),
        point: {
          pixelSize: onLine ? size + 4 : size,
          color: color.withAlpha(dim ? 0.12 : 0.55),
          outlineColor: color.withAlpha(dim ? 0.2 : 0.95),
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      drawn += 1;
    } catch (err) {
      console.warn('[map] station entity failed for ' + p.stationId, err);
    }
  }
  return drawn;
}
