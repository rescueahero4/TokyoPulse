import * as Cesium from 'cesium';

/**
 * Basemap registry. Every URL comes from web/.env.local (VITE_*) so the presenter
 * can swap a tile source without a code change. All of these are keyless and send
 * `Access-Control-Allow-Origin: *`.
 *
 * Default is GSI 淡色 (pale): a light, minimal street map served by Japan's national
 * mapping agency, 国土地理院. It is cheap on the frontend (small flat-colour PNGs
 * that cache hard and re-fetch cheaply while panning), Tokyo's official rail
 * liveries read at full saturation against it, and "we render on Japan's official
 * government basemap, keyless" is a real talking point. Satellite imagery is the
 * opposite trade: big JPEG tiles at every level, re-fetched on every pan.
 *
 * CARTO IS DELIBERATELY ABSENT. basemaps.cartocdn.com returns HTTP 200 with a
 * valid PNG that has "API KEY REQUIRED — carto.com/basemaps" stamped diagonally
 * across it once anonymous usage passes their threshold. We hit that live, on
 * screen, mid-build. A 200 and a decodable image are NOT proof a tile source is
 * usable — look at the pixels. Every source below was downloaded and visually
 * inspected: clean, no watermark.
 *
 * NB: Esri/ArcGIS tile URLs are {z}/{y}/{x}, NOT the usual {z}/{x}/{y}.
 */
export interface BasemapDef {
  id: string;
  label: string;
  /** Short label for the collapsed control. */
  short: string;
  url: string;
  credit: string;
  maximumLevel: number;
  /** True when the tiles already carry place names, so no overlay is offered. */
  hasOwnLabels: boolean;
  /** Optional thin reference overlay (place names) composited above this basemap. */
  labelUrl?: string;
  labelMaxLevel?: number;
  labelCredit?: string;
  /** Needs an async Cesium ion call; only offered when a token is present. */
  ion?: boolean;
}

const env = import.meta.env;

/** Public-by-design ion token. May carry a trailing `#note` in .env.local. */
export const ION_TOKEN: string = String(env.VITE_CESIUM_ION_TOKEN || '').split('#')[0].trim();

const GSI_CREDIT = '地理院タイル (GSI 国土地理院)';
const ESRI_IMAGERY_CREDIT = 'Esri World Imagery · Maxar, Earthstar Geographics';
const ESRI_CANVAS_CREDIT = 'Esri · HERE · Garmin · © OpenStreetMap contributors';

/** Bilingual (JP/EN) ward and place names, small and unobtrusive. Verified clean. */
const ESRI_GRAY_LABELS = env.VITE_OVERLAY_GRAY_LABELS_TILES
  || 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}';
/** Place names sized for imagery. Verified clean. */
const ESRI_PLACE_LABELS = env.VITE_OVERLAY_LABELS_TILES
  || 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';

const RAW: BasemapDef[] = [
  {
    id: 'gsi-pale',
    label: 'GSI 淡色 · light',
    short: 'GSI PALE',
    url: env.VITE_GSI_PALE_TILES || 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    credit: GSI_CREDIT,
    maximumLevel: 18,
    hasOwnLabels: true,
  },
  {
    id: 'esri-gray',
    label: 'Light grey · minimal',
    short: 'GREY',
    url: env.VITE_BASEMAP_GRAY_TILES
      || 'https://services.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    credit: ESRI_CANVAS_CREDIT,
    maximumLevel: 16,
    hasOwnLabels: false,
    labelUrl: ESRI_GRAY_LABELS,
    labelMaxLevel: 16,
    labelCredit: ESRI_CANVAS_CREDIT,
  },
  {
    id: 'gsi-std',
    label: 'GSI 標準 · full detail',
    short: 'GSI STD',
    url: env.VITE_GSI_STD_TILES || 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    credit: GSI_CREDIT,
    maximumLevel: 18,
    hasOwnLabels: true,
  },
  {
    id: 'ion',
    label: 'Satellite HD (Cesium ion)',
    short: 'SAT HD',
    // Sentinel, not a tile template: built through createWorldImageryAsync().
    url: ION_TOKEN ? 'ion:world-imagery' : '',
    credit: 'Cesium ion · Bing Maps imagery',
    maximumLevel: 19,
    hasOwnLabels: false,
    labelUrl: ESRI_PLACE_LABELS,
    labelMaxLevel: 15,
    labelCredit: 'Esri Reference',
    ion: true,
  },
  {
    id: 'satellite',
    label: 'Satellite (Esri)',
    short: 'SAT',
    url: env.VITE_BASEMAP_SATELLITE_TILES
      || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: ESRI_IMAGERY_CREDIT,
    maximumLevel: 19,
    hasOwnLabels: false,
    labelUrl: ESRI_PLACE_LABELS,
    labelMaxLevel: 15,
    labelCredit: 'Esri Reference',
  },
  {
    id: 'gsi-photo',
    label: 'Satellite (GSI Japan)',
    short: 'SAT JP',
    url: env.VITE_BASEMAP_GSI_PHOTO_TILES
      || 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    credit: GSI_CREDIT + ' シームレス空中写真',
    maximumLevel: 18,
    hasOwnLabels: false,
    labelUrl: ESRI_PLACE_LABELS,
    labelMaxLevel: 15,
    labelCredit: 'Esri Reference',
  },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    short: 'OSM',
    url: env.VITE_OSM_FALLBACK_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    credit: '© OpenStreetMap contributors',
    maximumLevel: 19,
    hasOwnLabels: true,
  },
];

/** A basemap with a blank URL is dropped rather than rendered as a dead tile grid. */
export const BASEMAPS: BasemapDef[] = RAW.filter((b) => !!b.url);

/** The first basemap we can build synchronously — used so startup never waits on ion. */
export const SYNC_FALLBACK_ID: string = (BASEMAPS.find((b) => !b.ion) ?? BASEMAPS[0]).id;

export const DEFAULT_BASEMAP_ID: string = (() => {
  const want = String(env.VITE_BASEMAP_DEFAULT || '');
  if (want && BASEMAPS.some((b) => b.id === want)) return want;
  // Light + simple is the default the demo wants; never fall back to a heavy one.
  return BASEMAPS.some((b) => b.id === 'gsi-pale') ? 'gsi-pale' : SYNC_FALLBACK_ID;
})();

export function basemapById(id: string): BasemapDef {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
}

const LABEL_ALPHA = Number(env.VITE_OVERLAY_LABELS_ALPHA ?? 0.9) || 0.9;

/**
 * Build an ImageryLayer for a basemap. Never throws: the caller falls back to the
 * next definition so the map always has a surface (rule 3 — layers fail alone).
 */
export function buildBasemapLayer(def: BasemapDef): { layer: Cesium.ImageryLayer; def: BasemapDef } | null {
  if (def.ion) return null; // async only — use buildBasemapLayerAsync
  try {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: def.url,
      maximumLevel: def.maximumLevel,
      credit: new Cesium.Credit(def.credit),
    });
    return { layer: new Cesium.ImageryLayer(provider), def };
  } catch (e) {
    console.warn('[map] basemap ' + def.id + ' failed to build', e);
    return null;
  }
}

/**
 * Async builder. The ion path calls createWorldImageryAsync(), which REJECTS on a
 * missing / expired / rate-limited token — so it is wrapped and degrades to the
 * keyless imagery instead of throwing anywhere near the render loop
 * (AGENT-BRIEF rule 3, godseye principle #2).
 */
export async function buildBasemapLayerAsync(
  def: BasemapDef,
): Promise<{ layer: Cesium.ImageryLayer; def: BasemapDef; path: string } | null> {
  if (!def.ion) {
    const built = buildBasemapLayer(def);
    return built ? { ...built, path: def.id } : null;
  }
  if (!ION_TOKEN) return null;
  try {
    const provider = await Cesium.createWorldImageryAsync();
    return { layer: new Cesium.ImageryLayer(provider), def, path: 'ion-world' };
  } catch (e) {
    console.warn('[map] ion world imagery unavailable, staying on the keyless path', e);
    return null;
  }
}

/** Thin place-name overlay for a basemap that carries none of its own. */
export function buildLabelOverlay(def: BasemapDef): Cesium.ImageryLayer | null {
  if (def.hasOwnLabels || !def.labelUrl) return null;
  try {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: def.labelUrl,
      maximumLevel: def.labelMaxLevel ?? 15,
      credit: new Cesium.Credit(def.labelCredit ?? def.credit),
    });
    const layer = new Cesium.ImageryLayer(provider);
    layer.alpha = LABEL_ALPHA;
    return layer;
  } catch (e) {
    console.warn('[map] label overlay unavailable', e);
    return null;
  }
}

/** Synchronous, never-fails surface for viewer construction. Skips ion defs. */
export function buildFirstWorkingBasemap(preferredId: string): { layer: Cesium.ImageryLayer; def: BasemapDef } {
  const sync = BASEMAPS.filter((b) => !b.ion);
  const pref = sync.find((b) => b.id === preferredId);
  const order = pref ? [pref, ...sync.filter((b) => b.id !== preferredId)] : sync;
  for (const def of order) {
    const built = buildBasemapLayer(def);
    if (built) return built;
  }
  // Last resort: a bare OSM provider (cannot realistically happen).
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maximumLevel: 19,
  });
  return { layer: new Cesium.ImageryLayer(provider), def: RAW[RAW.length - 1] };
}
