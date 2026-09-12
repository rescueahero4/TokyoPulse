import * as Cesium from 'cesium';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Lang, PulseEvent } from '../lib/types';
import type { LineCollection, StationCollection } from '../lib/geo';
import { renderRail } from './layers/rail';
import { renderQuakes } from './layers/quakes';
import { renderWarnings } from './layers/warnings';
import { renderCrowd } from './layers/crowd';
import { addFloodLayer } from './layers/flood';
import { renderPeopleFlow } from './layers/peopleflow';

/** Layer ids match GET /layers.json so LayerPanel toggles map 1:1 onto the map. */
export const LAYER_IDS = ['trains', 'quakes', 'warnings', 'crowd', 'flood', 'peopleflow'] as const;
export type LayerId = (typeof LAYER_IDS)[number];

const env = import.meta.env;
const HOME = {
  lat: Number(env.VITE_MAP_CENTER_LAT ?? 35.6812) || 35.6812,
  lon: Number(env.VITE_MAP_CENTER_LON ?? 139.7671) || 139.7671,
  height: Number(env.VITE_MAP_HEIGHT_M ?? 40000) || 40000,
};
const GSI_STD = env.VITE_GSI_STD_TILES || 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png';
const OSM = env.VITE_OSM_FALLBACK_TILES || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const GSI_FLOOD = env.VITE_GSI_FLOOD_TILES
  || 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png';

export interface MapHandle {
  flyTo(lat: number, lon: number, height?: number): void;
  home(): void;
}

export interface CesiumViewerProps {
  lines: LineCollection | null;
  stations: StationCollection | null;
  events: PulseEvent[];
  visible: Record<string, boolean>;
  selectedLineId: string | null;
  selectedEventId: string | null;
  lang: Lang;
  peopleFlowAvailable: boolean;
  onLinePick?(lineId: string): void;
  onStats?(stats: Record<string, number>): void;
}

function baseImagery(): { layer: Cesium.ImageryLayer; label: string } {
  try {
    const gsi = new Cesium.UrlTemplateImageryProvider({
      url: GSI_STD,
      maximumLevel: 18,
      credit: new Cesium.Credit('地理院タイル (GSI)'),
    });
    return { layer: new Cesium.ImageryLayer(gsi), label: 'gsi-std' };
  } catch (e) {
    console.warn('[map] GSI imagery failed, falling back to OSM', e);
    const osm = new Cesium.UrlTemplateImageryProvider({
      url: OSM,
      maximumLevel: 19,
      credit: new Cesium.Credit('© OpenStreetMap contributors'),
    });
    return { layer: new Cesium.ImageryLayer(osm), label: 'osm-fallback' };
  }
}

export const CesiumViewer = forwardRef<MapHandle, CesiumViewerProps>(function CesiumViewer(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const creditRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const sourcesRef = useRef<Partial<Record<LayerId, Cesium.CustomDataSource>>>({});
  const floodRef = useRef<Cesium.ImageryLayer | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const statsRef = useRef<Record<string, number>>({});

  useImperativeHandle(ref, () => ({
    flyTo(lat: number, lon: number, height = 9000) {
      const v = viewerRef.current;
      if (!v || typeof lat !== 'number' || typeof lon !== 'number') return;
      try {
        v.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
          orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
          duration: 1.4,
        });
      } catch (e) {
        console.warn('[map] flyTo failed', e);
      }
    },
    home() {
      const v = viewerRef.current;
      if (!v) return;
      v.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
        duration: 1.2,
      });
    },
  }));

  // ---- create the viewer exactly once
  useEffect(() => {
    if (!hostRef.current || viewerRef.current) return;
    // No ion token in this build and we must never request one.
    try {
      (Cesium.Ion as unknown as { defaultAccessToken: string }).defaultAccessToken = '';
    } catch {
      /* ignore */
    }

    let viewer: Cesium.Viewer;
    const { layer, label } = baseImagery();
    try {
      viewer = new Cesium.Viewer(hostRef.current, {
        baseLayer: layer,
        terrainProvider: new Cesium.EllipsoidTerrainProvider(),
        baseLayerPicker: false,
        geocoder: false,
        timeline: false,
        animation: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        fullscreenButton: false,
        infoBox: false,
        selectionIndicator: false,
        scene3DOnly: true,
        shouldAnimate: false,
        creditContainer: creditRef.current ?? undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[map] Cesium viewer failed to initialise', e);
      setFatal(msg);
      return;
    }
    viewerRef.current = viewer;
    // Exposed for QA / e2e probing. Read-only debugging handle, no secrets.
    (window as unknown as { __tpViewer?: Cesium.Viewer }).__tpViewer = viewer;
    console.info('[map] viewer up, imagery=' + label);
    try {
      layer.imageryProvider.errorEvent.addEventListener((err: unknown) => {
        console.warn('[map] imagery tile error', err);
      });
    } catch {
      /* ignore */
    }

    try {
      viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#0b0f14');
      viewer.scene.globe.showGroundAtmosphere = false;
      viewer.scene.skyAtmosphere.show = true;
      viewer.scene.fog.enabled = false;
      viewer.scene.globe.enableLighting = false;
      viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    } catch (e) {
      console.warn('[map] scene tuning skipped', e);
    }

    // Camera home: straight down over Tokyo Station.
    try {
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      });
      const c = viewer.camera.positionCartographic;
      console.info(
        '[map] camera home lat=' + Cesium.Math.toDegrees(c.latitude).toFixed(4)
        + ' lon=' + Cesium.Math.toDegrees(c.longitude).toFixed(4)
        + ' h=' + Math.round(c.height),
      );
    } catch (e) {
      console.warn('[map] setView failed', e);
    }

    // One CustomDataSource per layer, each added independently.
    for (const id of LAYER_IDS) {
      if (id === 'flood') continue;
      try {
        const ds = new Cesium.CustomDataSource(id);
        void viewer.dataSources.add(ds);
        sourcesRef.current[id] = ds;
      } catch (e) {
        console.warn('[map] layer ' + id + ' could not be created', e);
      }
    }

    // The flood raster is added on first enable (see the visibility effect):
    // toggling `show` on a layer that was added hidden does not always make
    // Cesium re-request its imagery, so we add/remove the layer instead.

    // Click a rail polyline to select the line.
    try {
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
        const picked = viewer.scene.pick(click.position);
        const entity = picked && (picked.id as Cesium.Entity | undefined);
        const kind = entity?.properties?.kind?.getValue?.(Cesium.JulianDate.now());
        if (kind === 'line') {
          const lineId = entity?.properties?.lineId?.getValue?.(Cesium.JulianDate.now());
          if (lineId && props.onLinePick) props.onLinePick(String(lineId));
        }
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    } catch (e) {
      console.warn('[map] pick handler unavailable', e);
    }

    setReady(true);
    return () => {
      try {
        viewerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      viewerRef.current = null;
      sourcesRef.current = {};
      floodRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Report a layer's entity count upward, but only when it actually changed. */
  const bump = (k: string, n: number) => {
    if (statsRef.current[k] === n) return;
    statsRef.current = { ...statsRef.current, [k]: n };
    props.onStats?.(statsRef.current);
  };

  // ---- rail
  useEffect(() => {
    if (!ready) return;
    const ds = sourcesRef.current.trains;
    if (!ds) return;
    try {
      bump('trains', renderRail(ds, props.lines, props.selectedLineId));
    } catch (e) {
      console.warn('[map] rail layer failed', e);
    }
  }, [ready, props.lines, props.selectedLineId]);

  // ---- quakes
  useEffect(() => {
    if (!ready) return;
    const ds = sourcesRef.current.quakes;
    if (!ds) return;
    try {
      bump('quakes', renderQuakes(ds, props.events, props.lang, props.selectedEventId));
    } catch (e) {
      console.warn('[map] quake layer failed', e);
    }
  }, [ready, props.events, props.lang, props.selectedEventId]);

  // ---- warnings
  useEffect(() => {
    if (!ready) return;
    const ds = sourcesRef.current.warnings;
    if (!ds) return;
    try {
      bump('warnings', renderWarnings(ds, props.events, props.lang, props.selectedEventId));
    } catch (e) {
      console.warn('[map] warning layer failed', e);
    }
  }, [ready, props.events, props.lang, props.selectedEventId]);

  // ---- crowd
  useEffect(() => {
    if (!ready) return;
    const ds = sourcesRef.current.crowd;
    if (!ds) return;
    try {
      bump('crowd', renderCrowd(ds, props.stations, props.selectedLineId));
    } catch (e) {
      console.warn('[map] crowd layer failed', e);
    }
  }, [ready, props.stations, props.selectedLineId]);

  // ---- peopleflow (declared, unavailable)
  useEffect(() => {
    if (!ready) return;
    const ds = sourcesRef.current.peopleflow;
    if (!ds) return;
    try {
      bump('peopleflow', renderPeopleFlow(ds, props.peopleFlowAvailable));
    } catch (e) {
      console.warn('[map] peopleflow layer failed', e);
    }
  }, [ready, props.peopleFlowAvailable]);

  // ---- visibility, each toggle isolated
  useEffect(() => {
    if (!ready) return;
    for (const id of LAYER_IDS) {
      const on = props.visible[id] !== false;
      try {
        if (id === 'flood') {
          const wantFlood = props.visible.flood === true;
          const viewer = viewerRef.current;
          if (!viewer) continue;
          if (wantFlood && !floodRef.current) {
            floodRef.current = addFloodLayer(viewer, GSI_FLOOD);
          } else if (!wantFlood && floodRef.current) {
            viewer.imageryLayers.remove(floodRef.current, true);
            floodRef.current = null;
          }
          continue;
        }
        const ds = sourcesRef.current[id];
        if (!ds) continue;
        ds.show = id === 'peopleflow' ? props.peopleFlowAvailable && on : on;
      } catch (e) {
        console.warn('[map] toggle ' + id + ' failed', e);
      }
    }
    viewerRef.current?.scene.requestRender();
  }, [ready, props.visible, props.peopleFlowAvailable]);

  return (
    <div className="map-root">
      <div ref={hostRef} className="cesium-host" data-testid="cesium-host" />
      <div ref={creditRef} className="map-credits" />
      {fatal && (
        <div className="map-fatal" role="alert">
          <strong>Map unavailable</strong>
          <span>{fatal}</span>
        </div>
      )}
    </div>
  );
});
