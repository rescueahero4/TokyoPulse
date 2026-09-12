import * as Cesium from 'cesium';
import type { Lang, PulseEvent } from '../../lib/types';
import { wardCentroid } from '../../lib/wards';
import { severityColor } from '../colors';

/**
 * Government weather warnings, pinned at the affected ward centroid
 * (contracts/wards.csv). Falls back to the event's own lat/lon when the
 * `affects` list names no ward we know.
 */
export function renderWarnings(
  ds: Cesium.CustomDataSource,
  events: PulseEvent[],
  lang: Lang,
  selectedId: string | null,
): number {
  ds.entities.removeAll();
  let drawn = 0;

  for (const e of events) {
    if (e.type !== 'warning' && e.type !== 'weather') continue;
    const targets: { lat: number; lon: number; label: string }[] = [];

    for (const token of e.affects || []) {
      const w = wardCentroid(token);
      if (w) targets.push({ lat: w.lat, lon: w.lon, label: lang === 'ja' ? w.wardJa : w.ward });
    }
    if (targets.length === 0 && typeof e.lat === 'number' && typeof e.lon === 'number') {
      targets.push({ lat: e.lat, lon: e.lon, label: '' });
    }
    if (targets.length === 0) continue;

    const color = severityColor(e.severity);
    const selected = selectedId === e.id;
    const title = (lang === 'ja' && e.titleJa ? e.titleJa : e.title) || 'warning';

    targets.forEach((t, i) => {
      try {
        ds.entities.add({
          id: 'warning:' + e.id + ':' + i,
          name: title,
          description: t.label,
          properties: { kind: 'event', eventId: e.id },
          position: Cesium.Cartesian3.fromDegrees(t.lon, t.lat),
          billboard: undefined,
          point: {
            pixelSize: selected ? 18 : 13,
            color: color.withAlpha(0.7),
            outlineColor: Cesium.Color.WHITE.withAlpha(0.85),
            outlineWidth: 2,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          label: {
            text: t.label || title.slice(0, 24),
            font: '600 12px system-ui, sans-serif',
            fillColor: color,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 3,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -20),
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(1.0e4, 1.0, 4.0e5, 0.5),
          },
        });
        drawn += 1;
      } catch (err) {
        console.warn('[map] warning entity failed for ' + e.id, err);
      }
    });
  }
  return drawn;
}
