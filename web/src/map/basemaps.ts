import * as Cesium from 'cesium';

/**
 * Basemap registry. Every URL comes from web/.env.local (VITE_*) so the presenter
 * can swap a tile source without a code change. All of these are keyless and send
 * `Access-Control-Allow-Origin: *`.
 *
 * Default is Esri World Imagery (satellite) with a thin translucent place-name
 * overlay on top — the same construction godseye uses (Globe.jsx:290-355). Plain
 * imagery + minimal labels is the "Google Maps" read the human asked for, and it
 * makes our coloured rail lines / quake dots / station markers pop instead of
 * fighting a topographic basemap.
 *
 * GSI (国土地理院) stays in the list on purpose — both its aerial (seamlessphoto)
 * and its topo tiles. It is the official Japanese government basemap and a genuine
 * talking point; we are only changing the default.
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
  /** True when the tiles already carry place names, so the label overlay is skipped. */
  hasOwnLabels: boolean;
  /** Needs an async Cesium ion call; only offered when a token is present. */
  ion?: boolean;
}

const env = import.meta.env;

/** Public-by-design ion token. May carry a trailing `#note` in .env.local. */
export const ION_TOKEN: string = String(env.VITE_CESIUM_ION_TOKEN || '').split('#')[0].trim();

const CARTO_CREDIT = '© OpenStreetMap contributors © CARTO';
const GSI_CREDIT = '地理院タイル (GSI 国土地理院)';
const ESRI_CREDIT = 'Esri World Imagery · Maxar, Earthstar Geographics';

const RAW: BasemapDef[] = [
  {
    id: 'ion',
    label: 'Satellite HD (Cesium ion)',
    short: 'SAT HD',
    // Sentinel, not a tile template: built through createWorldImageryAsync().
    url: ION_TOKEN ? 'ion:world-imagery' : '',
    credit: 'Cesium ion · Bing Maps imagery',
    maximumLevel: 19,
    hasOwnLabels: false,
    ion: true,
  },
  {
    id: 'satellite',
    label: 'Satellite (Esri)',
    short: 'SAT',
    url: env.VITE_BASEMAP_SATELLITE_TILES
      || 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    credit: ESRI_CREDIT,
    maximumLevel: 19,
    hasOwnLabels: false,
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
  },
  {
    id: 'dark',
    label: 'Dark (CARTO)',
    short: 'DARK',
    url: env.VITE_BASEMAP_DARK_TILES || 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    credit: CARTO_CREDIT,
    maximumLevel: 19,
    hasOwnLabels: true,
  },
  {
    id: 'dark-nolabels',
    label: 'Dark · no labels',
    short: 'DARK·NL',
    url: env.VITE_BASEMAP_DARK_NOLABELS_TILES
      || 'https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
    credit: CARTO_CREDIT,
    maximumLevel: 19,
    hasOwnLabels: false,
  },
  {
    id: 'light',
    label: 'Light (Positron)',
    short: 'LIGHT',
    url: env.VITE_BASEMAP_LIGHT_TILES || 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    credit: CARTO_CREDIT,
    maximumLevel: 19,
    hasOwnLabels: true,
  },
  {
    id: 'gsi-pale',
    label: 'GSI 淡色 (pale)',
    short: 'GSI PALE',
    url: env.VITE_GSI_PALE_TILES || 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    credit: GSI_CREDIT,
    maximumLevel: 18,
    hasOwnLabels: true,
  },
  {
    id: 'gsi-std',
    label: 'GSI 標準 (std)',
    short: 'GSI STD',
    url: env.VITE_GSI_STD_TILES || 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    credit: GSI_CREDIT,
    maximumLevel: 18,
    hasOwnLabels: true,
  },
  {
    id: 'osm',
    label: 'OSM (fallback)',
    short: 'OSM',
    url: env.VITE_OSM_FALLBACK_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    credit: '© OpenStreetMap contributors',
    maximumLevel: 19,
    hasOwnLabels: true,
  },
];

/** A basemap with a blank URL is dropped rather than rendered as a dead tile grid. */
export const BASEMAPS: BasemapDef[] = RAW.filter((b) => !!b.url);

export const DEFAULT_BASEMAP_ID: string = (() => {
  const want = String(env.VITE_BASEMAP_DEFAULT || '');
  if (want && BASEMAPS.some((b) => b.id === want)) return want;
  // ion imagery is sharper over Tokyo, but only if we actually have a token.
  return ION_TOKEN && BASEMAPS.some((b) => b.id === 'ion') ? 'ion' : 'satellite';
})();

/** The first basemap we can build synchronously — used so startup never waits on ion. */
export const SYNC_FALLBACK_ID: string = (BASEMAPS.find((b) => !b.ion) ?? BASEMAPS[0]).id;

export function basemapById(id: string): BasemapDef {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
}

/**
 * Minimal reference overlay: place names + boundaries, thin and translucent.
 * This is what gives plain satellite imagery a Google-Maps-like read without
 * importing a whole topographic map. Layered ABOVE the basemap, like godseye.
 */
export const LABEL_OVERLAY = {
  url: env.VITE_OVERLAY_LABELS_TILES
    || 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  maximumLevel: 15,
  alpha: 0.92,
  credit: 'Esri Reference',
};

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
 * keyless Esri imagery instead of throwing anywhere near the render loop
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

export function buildLabelOverlay(): Cesium.ImageryLayer | null {
  if (!LABEL_OVERLAY.url) return null;
  try {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: LABEL_OVERLAY.url,
      maximumLevel: LABEL_OVERLAY.maximumLevel,
      credit: new Cesium.Credit(LABEL_OVERLAY.credit),
    });
    const layer = new Cesium.ImageryLayer(provider);
    layer.alpha = LABEL_OVERLAY.alpha;
    return layer;
  } catch (e) {
    console.warn('[map] label overlay unavailable', e);
    return null;
  }
}

export function buildFirstWorkingBasemap(preferredId: string): { layer: Cesium.ImageryLayer; def: BasemapDef } {
  const order = [basemapById(preferredId), ...BASEMAPS.filter((b) => b.id !== preferredId)];
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
