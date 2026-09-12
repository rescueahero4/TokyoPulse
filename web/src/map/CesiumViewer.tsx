import * as Cesium from 'cesium';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Lang, PulseEvent } from '../lib/types';
import type { LineCollection, StationCollection } from '../lib/geo';
import { lineSegments } from '../lib/geo';
import { renderRail } from './layers/rail';
import { renderQuakes } from './layers/quakes';
import { renderWarnings } from './layers/warnings';
import { renderCrowd } from './layers/crowd';
import { addFloodLayer } from './layers/flood';
import { renderPeopleFlow } from './layers/peopleflow';
import {
  BASEMAPS, DEFAULT_BASEMAP_ID, basemapById, buildBasemapLayer, buildFirstWorkingBasemap,
  buildLabelOverlay,
} from './basemaps';

/** Layer ids match GET /layers.json so LayerPanel toggles map 1:1 onto the map. */
export const LAYER_IDS = ['trains', 'quakes', 'warnings', 'crowd', 'flood', 'peopleflow'] as const;
export type LayerId = (typeof LAYER_IDS)[number];

const env = import.meta.env;
const HOME = {
  lat: Number(env.VITE_MAP_CENTER_LAT ?? 35.6812) || 35.6812,
  lon: Number(env.VITE_MAP_CENTER_LON ?? 139.7671) || 139.7671,
  height: Number(env.VITE_MAP_HEIGHT_M ?? 40000) || 40000,
};
/** City-scale camera bounds: you cannot fall through the globe or get lost in space. */
const MIN_ZOOM_M = Number(env.VITE_MAP_MIN_ZOOM_M ?? 120) || 120;
const MAX_ZOOM_M = Number(env.VITE_MAP_MAX_ZOOM_M ?? 2_500_000) || 2_500_000;
const GSI_FLOOD = env.VITE_GSI_FLOOD_TILES
  || 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png';

const BASEMAP_STORAGE_KEY = 'tp.basemap';
const LABELS_STORAGE_KEY = 'tp.basemapLabels';

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

function initialBasemapId(): string {
  try {
    const saved = window.localStorage.getItem(BASEMAP_STORAGE_KEY);
    if (saved && BASEMAPS.some((b) => b.id === saved)) return saved;
  } catch {
    /* private mode / blocked storage — fall through to the env default */
  }
  return DEFAULT_BASEMAP_ID;
}

export const CesiumViewer = forwardRef<MapHandle, CesiumViewerProps>(function CesiumViewer(props, ref) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const creditRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const sourcesRef = useRef<Partial<Record<LayerId, Cesium.CustomDataSource>>>({});
  const floodRef = useRef<Cesium.ImageryLayer | null>(null);
  const baseLayerRef = useRef<Cesium.ImageryLayer | null>(null);
  const labelLayerRef = useRef<Cesium.ImageryLayer | null>(null);
  const linesRef = useRef<LineCollection | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [basemapId, setBasemapId] = useState<string>(initialBasemapId);
  const [labelsOn, setLabelsOn] = useState<boolean>(() => {
    try { return window.localStorage.getItem(LABELS_STORAGE_KEY) !== '0'; } catch { return true; }
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const statsRef = useRef<Record<string, number>>({});

  linesRef.current = props.lines;

  useImperativeHandle(ref, () => ({
    flyTo(lat: number, lon: number, height = 9000) {
      const v = viewerRef.current;
      if (!v || typeof lat !== 'number' || typeof lon !== 'number') return;
      try {
        v.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            lon, lat, Math.min(MAX_ZOOM_M, Math.max(MIN_ZOOM_M, height)),
          ),
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
    // Ion token is optional and public by design. Nothing on the critical path
    // needs it (all imagery here is keyless), but an ion asset — PLATEAU 3D
    // Tiles — would. The env value may carry a trailing `#note`, so strip it.
    try {
      const raw = String(env.VITE_CESIUM_ION_TOKEN || '').split('#')[0].trim();
      (Cesium.Ion as unknown as { defaultAccessToken: string }).defaultAccessToken = raw;
    } catch {
      /* ignore */
    }

    let viewer: Cesium.Viewer;
    const { layer, def } = buildFirstWorkingBasemap(initialBasemapId());
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
        shadows: false,
        skyAtmosphere: false,
        requestRenderMode: false,
        creditContainer: creditRef.current ?? undefined,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[map] Cesium viewer failed to initialise', e);
      setFatal(msg);
      return;
    }
    viewerRef.current = viewer;
    baseLayerRef.current = layer;
    if (def.id !== basemapId) setBasemapId(def.id);
    // Exposed for QA / e2e probing. Read-only debugging handle, no secrets.
    (window as unknown as { __tpViewer?: Cesium.Viewer }).__tpViewer = viewer;
    console.info('[map] viewer up, basemap=' + def.id);
    try {
      layer.imageryProvider.errorEvent.addEventListener((err: unknown) => {
        console.warn('[map] imagery tile error', err);
      });
    } catch {
      /* ignore */
    }

    // ---- scene: flat, dark, no atmospheric cost (godseye Globe.jsx:310-332)
    try {
      const scene = viewer.scene;
      scene.backgroundColor = Cesium.Color.fromCssColorString('#05080b');
      scene.globe.baseColor = Cesium.Color.fromCssColorString('#0a0a0f');
      if (scene.skyBox) scene.skyBox.show = false;
      scene.globe.showGroundAtmosphere = false;
      scene.globe.enableLighting = false;       // a lit globe dims our tiles; HUD wants flat
      scene.globe.depthTestAgainstTerrain = false;
      scene.globe.maximumScreenSpaceError = 12; // less LOD work per frame
      scene.fog.enabled = false;
      scene.highDynamicRange = false;
      try { scene.postProcessStages.fxaa.enabled = false; } catch { /* optional stage */ }
    } catch (e) {
      console.warn('[map] scene tuning skipped', e);
    }

    // ---- camera controls. Cesium's default inertia is what makes drag feel
    // floaty and laggy; zeroing it is what makes the map feel immediate.
    try {
      const c = viewer.scene.screenSpaceCameraController;
      c.inertiaSpin = 0;
      c.inertiaTranslate = 0;
      c.inertiaZoom = 0;
      c.enableZoom = true;
      c.enableRotate = true;
      c.enableTranslate = true;
      c.enableTilt = true;
      c.enableLook = true;
      c.minimumZoomDistance = MIN_ZOOM_M;
      c.maximumZoomDistance = MAX_ZOOM_M;
      c.enableCollisionDetection = true;
      // Route wheel + trackpad pinch to Cesium instead of the page.
      viewer.scene.canvas.style.touchAction = 'none';
      console.info(
        '[map] camera controls: inertia 0, zoom ' + MIN_ZOOM_M + '-' + MAX_ZOOM_M + 'm',
      );
    } catch (e) {
      console.warn('[map] camera controller tuning skipped', e);
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
      baseLayerRef.current = null;
      labelLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- basemap swap. The base layer always sits at index 0 so the label
  // overlay and the flood raster (both added above it) keep compositing.
  useEffect(() => {
    if (!ready) return;
    const viewer = viewerRef.current;
    const current = baseLayerRef.current;
    if (!viewer || !current) return;
    const def = basemapById(basemapId);
    if (!def) return;
    try { window.localStorage.setItem(BASEMAP_STORAGE_KEY, def.id); } catch { /* ignore */ }
    if (current.imageryProvider && (current.imageryProvider as { url?: string }).url === def.url) return;
    try {
      const built = buildBasemapLayer(def);
      if (!built) return;
      viewer.imageryLayers.add(built.layer, 0);
      viewer.imageryLayers.remove(current, true);
      baseLayerRef.current = built.layer;
      built.layer.imageryProvider.errorEvent.addEventListener((err: unknown) => {
        console.warn('[map] imagery tile error', err);
      });
      console.info('[map] basemap -> ' + def.id);
      viewer.scene.requestRender();
    } catch (e) {
      console.warn('[map] basemap swap failed, keeping current surface', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, basemapId]);

  // ---- minimal reference overlay (place names). Composited over the basemap,
  // godseye-style, so plain satellite imagery still reads like a city map.
  // Skipped for basemaps that already carry their own labels.
  useEffect(() => {
    if (!ready) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const want = labelsOn && !basemapById(basemapId).hasOwnLabels;
    try { window.localStorage.setItem(LABELS_STORAGE_KEY, labelsOn ? '1' : '0'); } catch { /* ignore */ }
    try {
      if (want && !labelLayerRef.current) {
        const layer = buildLabelOverlay();
        if (layer) {
          // index 1 = directly above the basemap, below the flood raster.
          viewer.imageryLayers.add(layer, 1);
          labelLayerRef.current = layer;
        }
      } else if (!want && labelLayerRef.current) {
        viewer.imageryLayers.remove(labelLayerRef.current, true);
        labelLayerRef.current = null;
      }
      viewer.scene.requestRender();
    } catch (e) {
      console.warn('[map] label overlay toggle failed', e);
    }
  }, [ready, labelsOn, basemapId]);

  /** Report a layer's entity count upward, but only when it actually changed. */
  const bump = (k: string, n: number) => {
    if (statsRef.current[k] === n) return;
    statsRef.current = { ...statsRef.current, [k]: n };
    props.onStats?.(statsRef.current);
  };

  // /lines.geojson is re-polled every 30s and hands back a fresh object every
  // time. Rebuilding the rail layer on object identity meant a full teardown
  // twice a minute; key it on what actually affects the render instead.
  const railSig = useMemo(() => {
    const fc = props.lines;
    if (!fc || !Array.isArray(fc.features)) return '';
    return fc.features
      .map((f) => {
        const p = f.properties;
        let pts = 0;
        for (const s of lineSegments(f)) pts += s.length;
        return (p?.lineId || '?') + '|' + (p?.status || '?') + '|' + (p?.color || '?') + '|' + pts;
      })
      .join(';');
  }, [props.lines]);

  // ---- rail
  useEffect(() => {
    if (!ready) return;
    const ds = sourcesRef.current.trains;
    if (!ds) return;
    try {
      bump('trains', renderRail(ds, linesRef.current, props.selectedLineId));
      viewerRef.current?.scene.requestRender();
    } catch (e) {
      console.warn('[map] rail layer failed', e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, railSig, props.selectedLineId]);

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

  const active = basemapById(basemapId);

  return (
    <div className="map-root">
      <div ref={hostRef} className="cesium-host" data-testid="cesium-host" />

      {/* Basemap switcher — collapsed to one chip so it never covers the data
          plane or the panels. Opens upward, bottom-left of the forecast strip. */}
      <div className={'map-basemap' + (pickerOpen ? ' is-open' : '')}>
        {pickerOpen && (
          <div className="map-basemap-menu" role="listbox" aria-label="Basemap">
            {BASEMAPS.map((b) => (
              <button
                key={b.id}
                type="button"
                role="option"
                aria-selected={b.id === basemapId}
                className={'map-basemap-opt' + (b.id === basemapId ? ' is-active' : '')}
                onClick={() => { setBasemapId(b.id); setPickerOpen(false); }}
              >
                <span className="map-basemap-swatch" data-bm={b.id} />
                {b.label}
              </button>
            ))}
            <button
              type="button"
              className={'map-basemap-opt map-basemap-labels' + (labelsOn ? ' is-active' : '')}
              aria-pressed={labelsOn}
              disabled={active.hasOwnLabels}
              onClick={() => setLabelsOn((o) => !o)}
              title={active.hasOwnLabels
                ? 'This basemap already has its own labels'
                : 'Thin place-name overlay on top of the imagery'}
            >
              <span className="map-basemap-switch" />
              Place labels
            </button>
            <div className="map-basemap-note">
              GSI = 国土地理院, the official Japanese government basemap — aerial and topo.
            </div>
          </div>
        )}
        <button
          type="button"
          className="map-basemap-toggle"
          aria-expanded={pickerOpen}
          onClick={() => setPickerOpen((o) => !o)}
          title="Change basemap style"
        >
          <span className="map-basemap-swatch" data-bm={active.id} />
          BASEMAP · {active.short}
          <span className="map-basemap-caret">{pickerOpen ? '▾' : '▴'}</span>
        </button>
      </div>

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
