import * as Cesium from 'cesium';
import type { Lang, PulseEvent } from '../../lib/types';
import { wardCentroid } from '../../lib/wards';
import { severityColor } from '../colors';

interface Job {
  eventId: string;
  lat: number;
  lon: number;
  /** Ward name when we know it, '' for a bare lat/lon event. */
  place: string;
  title: string;
  severity: string;
  selected: boolean;
}

/** 4 decimals ~11m: anything closer than that is the same pin on screen. */
function spotKey(lat: number, lon: number): string {
  return lat.toFixed(4) + ',' + lon.toFixed(4);
}

/**
 * Government weather warnings, pinned at the affected ward centroid
 * (contracts/wards.csv). Falls back to the event's own lat/lon when the
 * `affects` list names no ward we know.
 *
 * Collision handling: many JMA warnings carry no lat/lon and resolve to the SAME
 * ward centroid, which previously stacked a dozen black-outlined labels on one
 * pixel and read as a solid black smear. Now markers sharing a spot are fanned
 * out in a small ring and only ONE label is drawn per spot, carrying a count.
 * Nothing is dropped from the map, and every event is listed in the timeline
 * regardless — honest labelling, less ink.
 */
export function renderWarnings(
  ds: Cesium.CustomDataSource,
  events: PulseEvent[],
  lang: Lang,
  selectedId: string | null,
): number {
  ds.entities.removeAll();

  // ---- pass 1: resolve every event to its map position(s)
  const jobs: Job[] = [];
  for (const e of events) {
    if (e.type !== 'warning' && e.type !== 'weather') continue;
    const title = (lang === 'ja' && e.titleJa ? e.titleJa : e.title) || 'warning';
    const selected = selectedId === e.id;
    let placed = false;

    for (const token of e.affects || []) {
      const w = wardCentroid(token);
      if (!w) continue;
      jobs.push({
        eventId: e.id, lat: w.lat, lon: w.lon,
        place: lang === 'ja' ? w.wardJa : w.ward,
        title, severity: e.severity, selected,
      });
      placed = true;
    }
    if (!placed && typeof e.lat === 'number' && typeof e.lon === 'number') {
      jobs.push({ eventId: e.id, lat: e.lat, lon: e.lon, place: '', title, severity: e.severity, selected });
    }
  }

  // ---- pass 2: how many share each spot, and does any of them matter most
  const groups = new Map<string, Job[]>();
  for (const j of jobs) {
    const k = spotKey(j.lat, j.lon);
    const g = groups.get(k);
    if (g) g.push(j);
    else groups.set(k, [j]);
  }

  // ---- pass 3: emit
  let drawn = 0;
  ds.entities.suspendEvents();
  try {
    groups.forEach((group) => {
      // Label the selected one if it is in this group, otherwise the first.
      const lead = group.find((j) => j.selected) ?? group[0];
      const n = group.length;

      group.forEach((j, i) => {
        const color = severityColor(j.severity);
        const isLead = j === lead;
        // Fan duplicates out on a ~9px screen ring so each pin stays clickable.
        const angle = (i / Math.max(1, n)) * Math.PI * 2;
        const offX = n > 1 ? Math.cos(angle) * 9 : 0;
        const offY = n > 1 ? Math.sin(angle) * 9 : 0;

        const labelText = isLead
          ? (j.place || j.title.slice(0, 24)) + (n > 1 ? '  ×' + n : '')
          : '';

        try {
          ds.entities.add({
            id: 'warning:' + j.eventId + ':' + spotKey(j.lat, j.lon) + ':' + i,
            name: j.title,
            description: j.place,
            properties: { kind: 'event', eventId: j.eventId },
            position: Cesium.Cartesian3.fromDegrees(j.lon, j.lat, 40),
            point: {
              pixelSize: j.selected ? 16 : 11,
              color: color.withAlpha(0.65),
              outlineColor: color,
              outlineWidth: j.selected ? 3 : 1.5,
              pixelOffset: new Cesium.Cartesian2(offX, offY),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
            // A HUD chip, not a heavy black text outline — that stacking is what
            // produced the black smear over Shinjuku.
            label: labelText
              ? {
                text: labelText,
                font: '600 11px ui-monospace, monospace',
                fillColor: color,
                style: Cesium.LabelStyle.FILL,
                showBackground: true,
                backgroundColor: Cesium.Color.fromCssColorString('rgba(10,10,15,0.72)'),
                backgroundPadding: new Cesium.Cartesian2(6, 3),
                horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
                pixelOffset: new Cesium.Cartesian2(10, -8),
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
                // Hide the text entirely when zoomed out past city scale.
                translucencyByDistance: new Cesium.NearFarScalar(2.0e5, 1.0, 6.0e5, 0.0),
              }
              : undefined,
          });
          drawn += 1;
        } catch (err) {
          console.warn('[map] warning entity failed for ' + j.eventId, err);
        }
      });
    });
  } finally {
    ds.entities.resumeEvents();
  }
  return drawn;
}
