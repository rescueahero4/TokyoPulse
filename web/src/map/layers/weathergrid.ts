import * as Cesium from 'cesium';

/**
 * Continuous weather surface from GET /weathergrid.json.
 *
 * Rendered as ONE SingleTileImageryProvider over the grid's bbox, not entities,
 * so it costs nothing against the entity budget the rail work fought down.
 *
 * HONESTY (the payload ships its own `note`, and we surface it): bilinear
 * interpolation adds NO new information — it only smooths the transition between
 * known points. Open-Meteo's native resolution over Japan is ~5km, so a 7x9
 * lattice at 0.125 degrees is already at the model's limit; a finer `?step=`
 * would resolve to the same model cells and buy nothing but latency.
 *
 * Temperature is a continuous field, so a smooth ramp is defensible.
 * Precipitation is genuinely patchy, so smoothing it would be misleading — it is
 * drawn in HARD QUANTISED BANDS instead, which reads as "these are buckets",
 * not as a continuous field we do not actually have.
 */

const BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000').replace(/\/$/, '');

export type WeatherVar = 'temperature_2m' | 'precipitation';

export interface WeatherGrid {
  bbox: { latMin: number; latMax: number; lonMin: number; lonMax: number };
  step: number;
  rows: number;
  cols: number;
  lats: number[];
  lons: number[];
  time: string;
  units: Record<string, string>;
  values: Record<string, number[]>;
  note?: string;
  attribution?: string;
  sourceUrl?: string;
  meta?: { source?: string; generatedAt?: string; degraded?: boolean; note?: string | null };
}

export async function fetchWeatherGrid(signal?: AbortSignal): Promise<WeatherGrid | null> {
  try {
    const res = await fetch(BASE + '/weathergrid.json', { signal });
    if (!res.ok) return null;
    const g = (await res.json()) as WeatherGrid;
    // Defend the invariant the contract states: values are ROW-MAJOR, rows*cols.
    if (!g || !g.values || !Array.isArray(g.lats) || !Array.isArray(g.lons)) return null;
    for (const k of Object.keys(g.values)) {
      if (!Array.isArray(g.values[k]) || g.values[k].length !== g.rows * g.cols) {
        console.warn('[map] weathergrid ' + k + ' is not rows*cols; ignoring');
        delete g.values[k];
      }
    }
    return Object.keys(g.values).length ? g : null;
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') console.warn('[map] /weathergrid.json unavailable', e);
    return null;
  }
}

/** Bilinear sample of a row-major lattice at (lat, lon). NaN outside the bbox. */
export function sample(grid: WeatherGrid, variable: WeatherVar, lat: number, lon: number): number {
  const v = grid.values[variable];
  if (!v) return NaN;
  const { rows, cols, lats, lons } = grid;
  const lat0 = lats[0];
  const lon0 = lons[0];
  const dLat = rows > 1 ? lats[1] - lat0 : 1;
  const dLon = cols > 1 ? lons[1] - lon0 : 1;

  let fr = (lat - lat0) / dLat;
  let fc = (lon - lon0) / dLon;
  if (fr < -0.5 || fc < -0.5 || fr > rows - 0.5 || fc > cols - 0.5) return NaN;
  fr = Math.max(0, Math.min(rows - 1, fr));
  fc = Math.max(0, Math.min(cols - 1, fc));

  const r0 = Math.floor(fr);
  const c0 = Math.floor(fc);
  const r1 = Math.min(rows - 1, r0 + 1);
  const c1 = Math.min(cols - 1, c0 + 1);
  const tr = fr - r0;
  const tc = fc - c0;

  const v00 = v[r0 * cols + c0];
  const v01 = v[r0 * cols + c1];
  const v10 = v[r1 * cols + c0];
  const v11 = v[r1 * cols + c1];
  const top = v00 + (v01 - v00) * tc;
  const bot = v10 + (v11 - v10) * tc;
  return top + (bot - top) * tr;
}

export function range(grid: WeatherGrid, variable: WeatherVar): { min: number; max: number } {
  const v = grid.values[variable] || [];
  let min = Infinity;
  let max = -Infinity;
  for (const n of v) {
    if (!Number.isFinite(n)) continue;
    if (n < min) min = n;
    if (n > max) max = n;
  }
  if (!Number.isFinite(min)) return { min: 0, max: 1 };
  return { min, max };
}

type RGBA = [number, number, number, number];

function lerpStops(stops: { t: number; c: RGBA }[], t: number): RGBA {
  if (t <= stops[0].t) return stops[0].c;
  const last = stops[stops.length - 1];
  if (t >= last.t) return last.c;
  for (let i = 1; i < stops.length; i += 1) {
    const a = stops[i - 1];
    const b = stops[i];
    if (t <= b.t) {
      const f = (t - a.t) / (b.t - a.t || 1);
      return [
        Math.round(a.c[0] + (b.c[0] - a.c[0]) * f),
        Math.round(a.c[1] + (b.c[1] - a.c[1]) * f),
        Math.round(a.c[2] + (b.c[2] - a.c[2]) * f),
        a.c[3] + (b.c[3] - a.c[3]) * f,
      ];
    }
  }
  return last.c;
}

/** Cool -> warm. Continuous, because temperature genuinely is. */
const TEMP_STOPS: { t: number; c: RGBA }[] = [
  { t: 0.0, c: [49, 84, 168, 1] },
  { t: 0.25, c: [58, 160, 200, 1] },
  { t: 0.5, c: [120, 196, 120, 1] },
  { t: 0.7, c: [240, 214, 90, 1] },
  { t: 0.85, c: [240, 140, 55, 1] },
  { t: 1.0, c: [214, 60, 50, 1] },
];

/** Quantised buckets (mm/h), NOT a smooth ramp — see the module note. */
const PRECIP_BANDS: { max: number; c: RGBA }[] = [
  { max: 0.1, c: [0, 0, 0, 0] },
  { max: 0.5, c: [130, 200, 230, 0.55] },
  { max: 1.0, c: [70, 160, 220, 0.7] },
  { max: 2.5, c: [40, 110, 205, 0.8] },
  { max: 5.0, c: [90, 70, 200, 0.85] },
  { max: 10.0, c: [150, 55, 175, 0.9] },
  { max: Infinity, c: [200, 40, 120, 0.92] },
];

function colorFor(variable: WeatherVar, value: number, min: number, max: number): RGBA {
  if (!Number.isFinite(value)) return [0, 0, 0, 0];
  if (variable === 'precipitation') {
    for (const b of PRECIP_BANDS) if (value < b.max) return b.c;
    return PRECIP_BANDS[PRECIP_BANDS.length - 1].c;
  }
  const t = max > min ? (value - min) / (max - min) : 0.5;
  return lerpStops(TEMP_STOPS, t);
}

/**
 * Rasterise the surface. The canvas is deliberately modest (the lattice is 7x9);
 * a larger canvas would only render the same information with more pixels.
 */
export function buildSurfaceCanvas(grid: WeatherGrid, variable: WeatherVar): HTMLCanvasElement | null {
  const { latMin, latMax, lonMin, lonMax } = grid.bbox;
  if (!(latMax > latMin) || !(lonMax > lonMin)) return null;
  const W = 512;
  const H = Math.max(64, Math.round((W * (latMax - latMin)) / (lonMax - lonMin)));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;

  const { min, max } = range(grid, variable);
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let y = 0; y < H; y += 1) {
    // Canvas y grows downward, latitude grows upward.
    const lat = latMax - ((y + 0.5) / H) * (latMax - latMin);
    for (let x = 0; x < W; x += 1) {
      const lon = lonMin + ((x + 0.5) / W) * (lonMax - lonMin);
      const c = colorFor(variable, sample(grid, variable, lat, lon), min, max);
      const i = (y * W + x) * 4;
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = Math.round(c[3] * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/**
 * Add the surface as a single imagery tile over the grid's bbox.
 * Async because Cesium >= 1.104 builds SingleTileImageryProvider through
 * `fromUrl`; the old constructor is kept as a fallback.
 */
export async function addWeatherLayer(
  viewer: Cesium.Viewer,
  grid: WeatherGrid,
  variable: WeatherVar,
  alpha: number,
): Promise<Cesium.ImageryLayer | null> {
  try {
    const cv = buildSurfaceCanvas(grid, variable);
    if (!cv) return null;
    const url = cv.toDataURL('image/png');
    const rectangle = Cesium.Rectangle.fromDegrees(
      grid.bbox.lonMin, grid.bbox.latMin, grid.bbox.lonMax, grid.bbox.latMax,
    );
    const credit = new Cesium.Credit(grid.attribution || 'Open-Meteo');
    const ST = Cesium.SingleTileImageryProvider as unknown as {
      fromUrl?: (u: string, o: unknown) => Promise<Cesium.ImageryProvider>;
    };
    const provider = typeof ST.fromUrl === 'function'
      ? await ST.fromUrl(url, { rectangle, credit })
      : new Cesium.SingleTileImageryProvider({ url, rectangle, credit } as never);
    const layer = viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = alpha;
    return layer;
  } catch (e) {
    console.warn('[map] weather surface unavailable', e);
    return null;
  }
}

/* ---------------- numeric values at the lattice points ---------------- */

/**
 * Draw the ACTUAL sampled values, at the 63 real lattice points.
 *
 * Deliberately not at interpolated positions: the surface is smoothed, but a
 * number printed to one decimal reads as a measurement, and mid-cell it would be
 * a computed estimate dressed up as one. The colour ramp carries the shape of
 * the field; these carry the facts behind it.
 *
 * Reuses the station-label rule — a label is shown only out to the distance at
 * which its neighbours are still clear, spacing/LABEL_SPACING. At 0.125 degrees
 * the lattice is ~11-14km apart, so they stay separated well past city zoom.
 */
export function renderWeatherValues(
  ds: Cesium.CustomDataSource,
  grid: WeatherGrid | null,
  variable: WeatherVar,
  show: boolean,
): number {
  ds.entities.removeAll();
  if (!show || !grid) return 0;
  const v = grid.values[variable];
  if (!v) return 0;

  const unit = grid.units?.[variable] || '';
  const isPrecip = variable === 'precipitation';

  // Same geometry as the station declutter: a fixed pixel gap is a fixed
  // fraction of camera distance, so distance = ground spacing / spacing-fraction.
  const spacingFrac = (() => {
    const n = Number(import.meta.env.VITE_LABEL_SPACING);
    return Number.isFinite(n) && n > 0 ? n : 0.04;
  })();
  const midLat = (grid.bbox.latMin + grid.bbox.latMax) / 2;
  const spacingM = Math.min(
    grid.step * 111_320,
    grid.step * 111_320 * Math.cos((midLat * Math.PI) / 180),
  );
  const far = Math.max(20_000, Math.min(400_000, spacingM / spacingFrac));

  let drawn = 0;
  ds.entities.suspendEvents();
  try {
    for (let r = 0; r < grid.rows; r += 1) {
      for (let c = 0; c < grid.cols; c += 1) {
        const value = v[r * grid.cols + c];
        if (!Number.isFinite(value)) continue;
        // 63 labels all reading "0.0mm" say nothing; show only where it rains.
        if (isPrecip && value < 0.05) continue;
        const lat = grid.lats[r];
        const lon = grid.lons[c];
        if (typeof lat !== 'number' || typeof lon !== 'number') continue;
        try {
          ds.entities.add({
            id: 'wxval:' + variable + ':' + r + ':' + c,
            position: Cesium.Cartesian3.fromDegrees(lon, lat, 60),
            properties: { kind: 'wxvalue', variable },
            label: {
              text: value.toFixed(1) + unit,
              font: '600 10px "JetBrains Mono", ui-monospace, monospace',
              fillColor: Cesium.Color.fromCssColorString('#7fe3ff'),
              // NEVER FILL_AND_OUTLINE: Cesium's SDF label atlas bleeds
              // neighbouring glyphs through the outline pass and renders a black
              // scribble. A chip gives contrast over both ends of the ramp.
              style: Cesium.LabelStyle.FILL,
              showBackground: true,
              backgroundColor: Cesium.Color.fromCssColorString('rgba(0,40,60,0.82)'),
              backgroundPadding: new Cesium.Cartesian2(4, 2),
              horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
              // Station labels sit ABOVE their dot; these sit BELOW their lattice
              // point. The two layers are independent so neither can declutter
              // against the other — opposite offsets turn most near-collisions
              // into vertical separation instead.
              verticalOrigin: Cesium.VerticalOrigin.TOP,
              pixelOffset: new Cesium.Cartesian2(0, 10),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, far),
              translucencyByDistance: new Cesium.NearFarScalar(far * 0.75, 1.0, far, 0.0),
            },
          });
          drawn += 1;
        } catch { /* one bad point must not kill the layer */ }
      }
    }
  } finally {
    ds.entities.resumeEvents();
  }
  return drawn;
}
