import * as Cesium from 'cesium';
import type { Lang, PulseEvent } from '../../lib/types';
import { wardCentroid } from '../../lib/wards';
import { polygonHierarchy, wardArea, type TokyoArea, type TokyoAreas } from '../areas';
import { severityColor } from '../colors';

/**
 * Government weather warnings, drawn as the area JMA issued them for: a coloured
 * outline and a faint fill over the ward, Tama municipality or island region.
 *
 * Weather forecasts are not drawn here. They are the ward weather layer's job, and
 * the citywide summaries in the event feed have no place on the map.
 *
 * If the boundaries failed to load, or an area has no known shape, a warning falls
 * back to a point at its ward's centre or its own coordinates, so it never vanishes.
 */

/** Above the weather paint (2m) and the rail casing, so an outline stays readable. */
const FILL_HEIGHT_M = 3;
const OUTLINE_HEIGHT_M = 14;
const POLYGON_GRANULARITY = Cesium.Math.toRadians(0.02);
const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

function worst(events: PulseEvent[]): PulseEvent {
  return events.reduce((a, b) => ((SEVERITY_RANK[b.severity] ?? 0) > (SEVERITY_RANK[a.severity] ?? 0) ? b : a));
}

function areasOf(e: PulseEvent, areas: TokyoAreas | null): TokyoArea[] {
  if (!areas) return [];
  const out: TokyoArea[] = [];
  for (const code of e.areaCodes ?? []) {
    const area = areas.get(code);
    if (area) out.push(area);
  }
  if (out.length) return out;
  // Events stored before areaCodes existed still name their ward.
  for (const token of e.affects ?? []) {
    const w = wardCentroid(token);
    const area = w && wardArea(areas, w.ward);
    if (area) out.push(area);
  }
  return out;
}

function chipLabel(text: string, color: Cesium.Color): Cesium.LabelGraphics.ConstructorOptions {
  return {
    text,
    font: '600 11px ui-monospace, monospace',
    fillColor: color,
    style: Cesium.LabelStyle.FILL,
    showBackground: true,
    backgroundColor: Cesium.Color.fromCssColorString('rgba(10,10,15,0.8)'),
    backgroundPadding: new Cesium.Cartesian2(6, 3),
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
    verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
    // Above the ward weather chip, which sits centred on the same point.
    pixelOffset: new Cesium.Cartesian2(0, -18),
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    translucencyByDistance: new Cesium.NearFarScalar(2.0e5, 1.0, 6.0e5, 0.0),
  };
}

function drawArea(
  ds: Cesium.CustomDataSource,
  area: TokyoArea,
  lead: PulseEvent,
  selected: boolean,
): void {
  const color = severityColor(lead.severity);
  const properties = { kind: 'event', eventId: lead.id };
  area.polygons.forEach((rings, i) => {
    ds.entities.add({
      id: 'warning-fill:' + area.code + ':' + i,
      name: lead.title,
      properties,
      polygon: {
        hierarchy: polygonHierarchy(rings),
        height: FILL_HEIGHT_M,
        granularity: POLYGON_GRANULARITY,
        material: color.withAlpha(selected ? 0.32 : 0.16),
      },
    });
    rings.forEach((ring, r) => {
      ds.entities.add({
        id: 'warning-line:' + area.code + ':' + i + ':' + r,
        name: lead.title,
        properties,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(
            ring.flatMap(([lon, lat]) => [lon, lat, OUTLINE_HEIGHT_M]),
          ),
          width: selected ? 3.5 : 2,
          material: color,
          clampToGround: false,
        },
      });
    });
  });
}

function drawPoint(
  ds: Cesium.CustomDataSource,
  id: string,
  lon: number,
  lat: number,
  lead: PulseEvent,
  selected: boolean,
  labelText: string,
): void {
  const color = severityColor(lead.severity);
  ds.entities.add({
    id,
    name: lead.title,
    properties: { kind: 'event', eventId: lead.id },
    position: Cesium.Cartesian3.fromDegrees(lon, lat, 40),
    point: {
      pixelSize: selected ? 16 : 11,
      color: color.withAlpha(0.65),
      outlineColor: color,
      outlineWidth: selected ? 3 : 1.5,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: labelText ? chipLabel(labelText, color) : undefined,
  });
}

/** Rebuilding polygons is visible on screen, and the feed re-delivers the same events every poll. */
const lastDrawn = new WeakMap<Cesium.CustomDataSource, { key: string; drawn: number }>();

export function renderWarnings(
  ds: Cesium.CustomDataSource,
  events: PulseEvent[],
  areas: TokyoAreas | null,
  lang: Lang,
  selectedId: string | null,
): number {
  const warnings = events.filter((e) => e.type === 'warning');
  const key = JSON.stringify([
    !!areas, lang, selectedId,
    warnings.map((e) => [e.id, e.severity, e.title, e.areaCodes, e.affects, e.lat, e.lon]),
  ]);
  const previous = lastDrawn.get(ds);
  if (previous?.key === key) return previous.drawn;

  ds.entities.removeAll();

  // ---- which warnings fall on which area
  const byArea = new Map<string, { area: TokyoArea; events: PulseEvent[] }>();
  const unplaced: PulseEvent[] = [];
  for (const e of warnings) {
    const found = areasOf(e, areas);
    if (!found.length) unplaced.push(e);
    for (const area of found) {
      const entry = byArea.get(area.code);
      if (entry) entry.events.push(e);
      else byArea.set(area.code, { area, events: [e] });
    }
  }

  // ---- one chip per place: 30 Tama cities under one advisory is one thing to read
  const byPlace = new Map<string, { area: TokyoArea; events: Set<PulseEvent> }>();
  for (const { area, events: list } of byArea.values()) {
    const entry = byPlace.get(area.place) ?? { area, events: new Set<PulseEvent>() };
    list.forEach((e) => entry.events.add(e));
    byPlace.set(area.place, entry);
  }

  let drawn = 0;
  ds.entities.suspendEvents();
  try {
    for (const { area, events: list } of byArea.values()) {
      const selected = list.find((e) => e.id === selectedId);
      try {
        drawArea(ds, area, selected ?? worst(list), !!selected);
        drawn += 1;
      } catch (err) {
        console.warn('[map] warning area failed for ' + area.code, err);
      }
    }

    for (const [place, { area, events: set }] of byPlace) {
      const list = [...set];
      const selected = list.find((e) => e.id === selectedId);
      const lead = selected ?? worst(list);
      const text = (lang === 'ja' ? area.placeJa : place) + (list.length > 1 ? '  ×' + list.length : '');
      if (area.level === 'ward') {
        ds.entities.add({
          id: 'warning-chip:' + area.code,
          name: lead.title,
          properties: { kind: 'event', eventId: lead.id },
          position: Cesium.Cartesian3.fromDegrees(area.label[0], area.label[1], 60),
          label: chipLabel(text, severityColor(lead.severity)),
        });
      } else {
        // Island groups are specks at city scale, so they keep a marker you can find.
        drawPoint(ds, 'warning-marker:' + place, area.label[0], area.label[1], lead, !!selected, text);
      }
    }

    for (const e of unplaced) {
      const w = (e.affects ?? []).map((t) => wardCentroid(t)).find(Boolean);
      const lat = w?.lat ?? e.lat;
      const lon = w?.lon ?? e.lon;
      if (typeof lat !== 'number' || typeof lon !== 'number') continue;
      const place = w ? (lang === 'ja' ? w.wardJa : w.ward) : '';
      drawPoint(ds, 'warning-point:' + e.id, lon, lat, e, e.id === selectedId, place);
      drawn += 1;
    }
  } finally {
    ds.entities.resumeEvents();
  }
  lastDrawn.set(ds, { key, drawn });
  return drawn;
}
