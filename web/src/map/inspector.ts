// Map-click -> inspector selection.
//
// This attaches its OWN Cesium.ScreenSpaceEventHandler, independent of the
// line-select handler inside CesiumViewer.tsx. Cesium delivers the same click to
// every registered handler, so the two coexist: clicking a rail line still opens
// the Impact panel AND raises an inspector card, and neither file has to know
// about the other. CesiumViewer.tsx is not modified.
//
// Picking uses scene.drillPick (not scene.pick): station markers are drawn with
// disableDepthTestDistance and sit above the rail polylines, so a plain pick
// loses clicks that visually landed on a line.

import * as Cesium from 'cesium';

export type MapPick =
  | { kind: 'station'; stationId: string }
  /** A Toei bus. `positionSource` matters to the card copy: an interpolated
   *  position is schedule-derived, NOT GPS, and must be labelled as such. */
  | { kind: 'bus'; busId: string; routeId: string | null; positionSource: string | null }
  | { kind: 'event'; eventId: string }
  | { kind: 'line'; lineId: string }
  /** Nothing pickable under the cursor — i.e. basemap or a raster overlay. */
  | { kind: 'ground'; lat: number | null; lon: number | null }
  | null;

const VIEWER_KEY = '__tpViewer';

function getViewer(): Cesium.Viewer | null {
  const v = (window as unknown as Record<string, unknown>)[VIEWER_KEY];
  return (v as Cesium.Viewer | undefined) ?? null;
}

/** lon/lat under the cursor, or nulls if the ray misses the globe. */
function groundAt(viewer: Cesium.Viewer, position: Cesium.Cartesian2): { lat: number | null; lon: number | null } {
  try {
    const cartesian = viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid);
    if (!cartesian) return { lat: null, lon: null };
    const c = Cesium.Cartographic.fromCartesian(cartesian);
    return {
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
    };
  } catch {
    return { lat: null, lon: null };
  }
}

function resolvePick(viewer: Cesium.Viewer, position: Cesium.Cartesian2): MapPick {
  const now = Cesium.JulianDate.now();
  let picks: unknown[] = [];
  try {
    picks = viewer.scene.drillPick(position, 8, 12, 12) || [];
  } catch {
    picks = [];
  }

  // Two passes, deliberately. Point markers (stations, quakes, warnings) are
  // drawn ON TOP of the rail polylines with disableDepthTestDistance, but
  // drillPick does not always return them first — at Hakusan the Mita Line
  // polyline came back ahead of the station dot sitting on it. Whatever is
  // visually on top is what the user meant to click, so markers win pass 1 and
  // lines are the pass-2 fallback. A click on bare track still resolves to the
  // line, and A6's own handler keeps opening the Impact panel either way.
  // Buses are billboards drawn above everything and are the smallest target on
  // screen, so they join stations and events in the pass-1 "visually on top" set.
  const markerKinds = new Set(['station', 'event', 'bus']);

  for (const pass of [1, 2]) {
    for (const raw of picks) {
      const entity = (raw as { id?: Cesium.Entity } | undefined)?.id;
      const props = entity?.properties;
      if (!props) continue;
      const kind = props.kind?.getValue?.(now);
      // The rail "casing" entities deliberately carry no kind, so they can never
      // win a pick over the line they sit under.
      if (pass === 1 && !markerKinds.has(String(kind))) continue;
      if (pass === 2 && kind !== 'line') continue;

      if (kind === 'bus') {
        const busId = props.busId?.getValue?.(now);
        if (busId) {
          const routeId = props.routeId?.getValue?.(now);
          const positionSource = props.positionSource?.getValue?.(now);
          return {
            kind: 'bus',
            busId: String(busId),
            routeId: routeId ? String(routeId) : null,
            positionSource: positionSource ? String(positionSource) : null,
          };
        }
      }
      if (kind === 'station') {
        const stationId = props.stationId?.getValue?.(now);
        if (stationId) return { kind: 'station', stationId: String(stationId) };
      }
      if (kind === 'event') {
        const eventId = props.eventId?.getValue?.(now);
        if (eventId) return { kind: 'event', eventId: String(eventId) };
      }
      if (kind === 'line') {
        const lineId = props.lineId?.getValue?.(now);
        if (lineId) return { kind: 'line', lineId: String(lineId) };
      }
    }
  }

  return { kind: 'ground', ...groundAt(viewer, position) };
}

/**
 * Subscribe to map clicks. Returns an unsubscribe function.
 * The Cesium viewer is created asynchronously by CesiumViewer.tsx, so this
 * retries until `window.__tpViewer` exists (then gives up quietly).
 */
export function attachInspector(onPick: (pick: MapPick) => void): () => void {
  let handler: Cesium.ScreenSpaceEventHandler | null = null;
  let timer: number | null = null;
  let disposed = false;
  let attempts = 0;

  const attach = () => {
    if (disposed) return;
    const viewer = getViewer();
    if (!viewer || !viewer.scene || !viewer.scene.canvas) {
      attempts += 1;
      if (attempts > 60) return; // ~30s: the map never came up; fail quietly
      timer = window.setTimeout(attach, 500);
      return;
    }
    try {
      handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
        try {
          onPick(resolvePick(viewer, click.position));
        } catch (err) {
          console.warn('[inspector] pick failed', err);
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    } catch (err) {
      console.warn('[inspector] handler unavailable', err);
    }
  };

  attach();

  return () => {
    disposed = true;
    if (timer !== null) window.clearTimeout(timer);
    try {
      if (handler && !handler.isDestroyed()) handler.destroy();
    } catch {
      /* viewer already torn down */
    }
    handler = null;
  };
}
