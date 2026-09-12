import * as Cesium from 'cesium';
import type { Lang, PulseEvent } from '../../lib/types';
import { severityColor } from '../colors';

/** Earthquake epicentres. Radius scales with magnitude, colour with severity. */
export function renderQuakes(
  ds: Cesium.CustomDataSource,
  events: PulseEvent[],
  lang: Lang,
  selectedId: string | null,
): number {
  ds.entities.removeAll();
  let drawn = 0;
  for (const e of events) {
    if (e.type !== 'quake') continue;
    if (typeof e.lat !== 'number' || typeof e.lon !== 'number') continue;
    const mag = typeof e.magnitude === 'number' ? e.magnitude : 3;
    const pixel = Math.max(8, Math.min(42, 6 + mag * 4));
    const color = severityColor(e.severity);
    const selected = selectedId === e.id;
    const label = (lang === 'ja' && e.titleJa ? e.titleJa : e.title) || 'quake';
    try {
      ds.entities.add({
        id: 'quake:' + e.id,
        name: label,
        description: 'M' + mag + (e.maxScale ? ' / shindo ' + e.maxScale : ''),
        properties: { kind: 'event', eventId: e.id },
        position: Cesium.Cartesian3.fromDegrees(e.lon, e.lat),
        point: {
          pixelSize: selected ? pixel + 6 : pixel,
          color: color.withAlpha(0.45),
          outlineColor: color,
          outlineWidth: selected ? 4 : 2,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: {
          text: 'M' + mag,
          font: '600 12px ui-monospace, monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -(pixel / 2 + 10)),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(1.0e4, 1.0, 6.0e5, 0.6),
        },
      });
      drawn += 1;
    } catch (err) {
      console.warn('[map] quake entity failed for ' + e.id, err);
    }
  }
  return drawn;
}
