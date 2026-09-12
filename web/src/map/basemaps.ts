import * as Cesium from 'cesium';

/**
 * Basemap registry. Every URL comes from web/.env.local (VITE_*) so the presenter
 * can swap a tile source without a code change. All of these are keyless and send
 * `Access-Control-Allow-Origin: *`.
 *
 * Default is CARTO dark_all: dark, minimal labels, so our coloured rail lines,
 * quake dots and station markers read as the data plane instead of fighting a
 * topographic basemap (doc/arch.md §2 godseye principle 4 — strong visual metaphor).
 *
 * GSI (国土地理院) stays in the list on purpose: it is the official Japanese
 * government basemap and a genuine talking point, we are only changing the default.
 */
export interface BasemapDef {
  id: string;
  label: string;
  /** Short label for the collapsed control. */
  short: string;
  url: string;
  credit: string;
  maximumLevel: number;
}

const env = import.meta.env;

const CARTO_CREDIT = '© OpenStreetMap contributors © CARTO';
const GSI_CREDIT = '地理院タイル (GSI)';

const RAW: BasemapDef[] = [
  {
    id: 'dark',
    label: 'Dark (CARTO)',
    short: 'DARK',
    url: env.VITE_BASEMAP_DARK_TILES || 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
    credit: CARTO_CREDIT,
    maximumLevel: 19,
  },
  {
    id: 'dark-nolabels',
    label: 'Dark · no labels',
    short: 'DARK·NL',
    url: env.VITE_BASEMAP_DARK_NOLABELS_TILES
      || 'https://basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png',
    credit: CARTO_CREDIT,
    maximumLevel: 19,
  },
  {
    id: 'light',
    label: 'Light (Positron)',
    short: 'LIGHT',
    url: env.VITE_BASEMAP_LIGHT_TILES || 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    credit: CARTO_CREDIT,
    maximumLevel: 19,
  },
  {
    id: 'gsi-pale',
    label: 'GSI 淡色 (pale)',
    short: 'GSI PALE',
    url: env.VITE_GSI_PALE_TILES || 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    credit: GSI_CREDIT,
    maximumLevel: 18,
  },
  {
    id: 'gsi-std',
    label: 'GSI 標準 (std)',
    short: 'GSI STD',
    url: env.VITE_GSI_STD_TILES || 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    credit: GSI_CREDIT,
    maximumLevel: 18,
  },
  {
    id: 'osm',
    label: 'OSM (fallback)',
    short: 'OSM',
    url: env.VITE_OSM_FALLBACK_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    credit: '© OpenStreetMap contributors',
    maximumLevel: 19,
  },
];

/** A basemap with a blank URL is dropped rather than rendered as a dead tile grid. */
export const BASEMAPS: BasemapDef[] = RAW.filter((b) => !!b.url);

export const DEFAULT_BASEMAP_ID: string =
  (env.VITE_BASEMAP_DEFAULT && BASEMAPS.some((b) => b.id === env.VITE_BASEMAP_DEFAULT)
    ? String(env.VITE_BASEMAP_DEFAULT)
    : 'dark');

export function basemapById(id: string): BasemapDef {
  return BASEMAPS.find((b) => b.id === id) ?? BASEMAPS[0];
}

/**
 * Build an ImageryLayer for a basemap. Never throws: on failure it falls back to
 * the next definition in the list so the map always has a surface (rule 3 —
 * every layer fails independently).
 */
export function buildBasemapLayer(def: BasemapDef): { layer: Cesium.ImageryLayer; def: BasemapDef } | null {
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

export function buildFirstWorkingBasemap(preferredId: string): { layer: Cesium.ImageryLayer; def: BasemapDef } {
  const order = [basemapById(preferredId), ...BASEMAPS.filter((b) => b.id !== preferredId)];
  for (const def of order) {
    const built = buildBasemapLayer(def);
    if (built) return built;
  }
  // Last resort: a bare OSM provider, no credit object (cannot realistically happen).
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maximumLevel: 19,
  });
  return { layer: new Cesium.ImageryLayer(provider), def: RAW[RAW.length - 1] };
}
