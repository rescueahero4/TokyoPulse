import * as Cesium from 'cesium';

/**
 * GSI flood-hazard raster as a second imagery layer. Off by default, alpha 0.55.
 * Returns null when the provider cannot be built - the toggle then reports "off".
 */
export function addFloodLayer(viewer: Cesium.Viewer, url: string): Cesium.ImageryLayer | null {
  if (!url) return null;
  try {
    const provider = new Cesium.UrlTemplateImageryProvider({
      url,
      maximumLevel: 17,
      credit: new Cesium.Credit('GSI flood hazard (ハサードマップ)'),
    });
    const layer = viewer.imageryLayers.addImageryProvider(provider);
    layer.alpha = 0.55;
    layer.show = true;
    return layer;
  } catch (e) {
    console.warn('[map] flood imagery unavailable', e);
    return null;
  }
}
