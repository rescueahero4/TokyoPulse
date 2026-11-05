import * as Cesium from 'cesium';
import type { Lang, WardWeather, WeatherVar } from '../../lib/types';
import { polygonHierarchy, type TokyoAreas } from '../areas';

/**
 * Weather painted ward by ward, from GET /wardweather.json.
 *
 * Each ward is one colour for one hour, because that is what the data is: the
 * area-weighted average of the ~5.5km forecast cells it overlaps. Nothing is
 * interpolated across a boundary.
 *
 * The polygons are built once. Moving through the hours only changes colours and
 * label text, which Cesium applies per instance without rebuilding any geometry,
 * so dragging the time control stays smooth.
 */

/** Below the rail casing (4m). Above the globe, so never hidden by the basemap. */
const POLYGON_HEIGHT_M = 2;
/**
 * At Cesium's default 1 degree tessellation a ward-sized polygon sags several metres
 * below its corners on the curved globe, and would dip under the basemap.
 */
const POLYGON_GRANULARITY = Cesium.Math.toRadians(0.02);
const LABEL_HEIGHT_M = 60;
/** Cesium moves a polygon between render batches if it ever becomes fully opaque. */
const MAX_ALPHA = 0.95;
const NO_COLOR = new Cesium.Color(0, 0, 0, 0);

type RGB = [number, number, number];

/**
 * Cooler to warmer, relative to the other wards this hour. Stops at orange: on this
 * map red means an official warning, and the warmest ward is not an alarm.
 */
const TEMP_STOPS: { t: number; c: RGB }[] = [
  { t: 0.0, c: [49, 84, 168] },
  { t: 0.3, c: [58, 160, 200] },
  { t: 0.55, c: [120, 196, 120] },
  { t: 0.8, c: [240, 214, 90] },
  { t: 1.0, c: [240, 140, 55] },
];

/** A smaller spread than this is not worth a strong colour difference. */
const MIN_TEMP_SPAN_C = 3;

/** Upper bound in mm per hour. Under the first band counts as dry and stays unpainted. */
const RAIN_BANDS: { max: number; c: RGB | null; alpha: number }[] = [
  { max: 0.1, c: null, alpha: 0 },
  { max: 0.5, c: [130, 200, 230], alpha: 0.6 },
  { max: 1.0, c: [70, 160, 220], alpha: 0.75 },
  { max: 2.5, c: [40, 110, 205], alpha: 0.85 },
  { max: 5.0, c: [90, 70, 200], alpha: 0.9 },
  { max: 10.0, c: [150, 55, 175], alpha: 0.95 },
  { max: Infinity, c: [200, 40, 120], alpha: 1 },
];

function tempRgb(t: number): RGB {
  if (t <= TEMP_STOPS[0].t) return TEMP_STOPS[0].c;
  for (let i = 1; i < TEMP_STOPS.length; i += 1) {
    const a = TEMP_STOPS[i - 1];
    const b = TEMP_STOPS[i];
    if (t <= b.t) {
      const f = (t - a.t) / (b.t - a.t);
      return [0, 1, 2].map((k) => a.c[k] + (b.c[k] - a.c[k]) * f) as RGB;
    }
  }
  return TEMP_STOPS[TEMP_STOPS.length - 1].c;
}

/**
 * The colour scale for one hour, fitted to the wards at that hour so that differences
 * between wards are what the colours show. Over a whole forecast the city's day and
 * night swing is several times larger than any gap between wards, and a scale that
 * spans it paints them all alike. The span never drops below MIN_TEMP_SPAN_C, so a
 * gap of a few tenths of a degree can't look dramatic.
 */
export function wardWeatherRange(
  data: WardWeather,
  variable: WeatherVar,
  hourIndex: number,
): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const ward of data.wards) {
    const v = ward[variable][hourIndex];
    if (typeof v !== 'number') continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return { min: 0, max: 1 };
  const pad = variable === 'temperature' ? Math.max(0, MIN_TEMP_SPAN_C - (max - min)) / 2 : 0;
  return { min: min - pad, max: max + pad };
}

function wardColor(
  variable: WeatherVar,
  value: number | null | undefined,
  range: { min: number; max: number },
  opacity: number,
): Cesium.Color {
  if (typeof value !== 'number') return NO_COLOR;
  let rgb: RGB | null;
  let alpha = opacity;
  if (variable === 'precipitation') {
    const band = RAIN_BANDS.find((b) => value < b.max) ?? RAIN_BANDS[RAIN_BANDS.length - 1];
    rgb = band.c;
    alpha = opacity * band.alpha;
  } else {
    rgb = tempRgb(range.max > range.min ? (value - range.min) / (range.max - range.min) : 0.5);
  }
  if (!rgb) return NO_COLOR;
  return new Cesium.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, Math.min(alpha, MAX_ALPHA));
}

export function formatWardValue(variable: WeatherVar, value: number | null | undefined, units: Record<string, string>): string {
  return typeof value === 'number' ? value.toFixed(1) + (units[variable] ?? '') : 'no data';
}

interface LayerState {
  colors: Map<string, Cesium.Color>;
  labels: Map<string, Cesium.Entity>;
}

const states = new WeakMap<Cesium.CustomDataSource, LayerState>();

function build(ds: Cesium.CustomDataSource, areas: TokyoAreas): LayerState {
  const state: LayerState = { colors: new Map(), labels: new Map() };
  ds.entities.suspendEvents();
  try {
    for (const area of areas.values()) {
      if (area.level !== 'ward') continue;
      const color = new Cesium.CallbackProperty(
        (_time, result) => Cesium.Color.clone(state.colors.get(area.code) ?? NO_COLOR, result),
        false,
      );
      area.polygons.forEach((rings, i) => {
        ds.entities.add({
          id: 'wardwx:' + area.code + ':' + i,
          properties: { kind: 'ward', ward: area.name },
          polygon: {
            hierarchy: polygonHierarchy(rings),
            height: POLYGON_HEIGHT_M,
            granularity: POLYGON_GRANULARITY,
            material: new Cesium.ColorMaterialProperty(color),
            outline: true,
            outlineColor: Cesium.Color.WHITE.withAlpha(0.35),
          },
        });
      });
      state.labels.set(area.code, ds.entities.add({
        id: 'wardwx-label:' + area.code,
        position: Cesium.Cartesian3.fromDegrees(area.label[0], area.label[1], LABEL_HEIGHT_M),
        label: {
          text: '',
          font: '600 10px "JetBrains Mono", ui-monospace, monospace',
          // Cyan, so a ward's reading can't be mistaken for a station name.
          fillColor: Cesium.Color.fromCssColorString('#7fe3ff'),
          // NEVER FILL_AND_OUTLINE: Cesium's SDF label atlas bleeds neighbouring
          // glyphs through the outline pass. A chip gives contrast over any colour.
          style: Cesium.LabelStyle.FILL,
          showBackground: true,
          backgroundColor: Cesium.Color.fromCssColorString('rgba(6,14,24,0.72)'),
          backgroundPadding: new Cesium.Cartesian2(4, 2),
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // Wards are about 6km apart, so past this the labels would overlap.
          translucencyByDistance: new Cesium.NearFarScalar(70_000, 1, 110_000, 0),
        },
      }));
    }
  } finally {
    ds.entities.resumeEvents();
  }
  return state;
}

/** Bring the layer in line with the current data, hour and controls. */
export function syncWardWeather(
  ds: Cesium.CustomDataSource,
  areas: TokyoAreas,
  data: WardWeather | null,
  opts: { variable: WeatherVar; hourIndex: number; opacity: number; showValues: boolean; lang: Lang },
): void {
  let state = states.get(ds);
  if (!state) {
    state = build(ds, areas);
    states.set(ds, state);
  }
  const range = data ? wardWeatherRange(data, opts.variable, opts.hourIndex) : { min: 0, max: 1 };
  const byCode = new Map((data?.wards ?? []).map((w) => [w.code, w]));
  for (const [code, label] of state.labels) {
    const area = areas.get(code);
    const ward = byCode.get(code);
    const value = ward?.[opts.variable][opts.hourIndex];
    state.colors.set(code, wardColor(opts.variable, value, range, opts.opacity));
    if (!label.label || !area) continue;
    label.show = opts.showValues && !!ward;
    if (ward) {
      const name = opts.lang === 'ja' ? area.nameJa : area.name;
      label.label.text = new Cesium.ConstantProperty(
        name + '\n' + formatWardValue(opts.variable, value, data?.units ?? {}),
      );
    }
  }
}
