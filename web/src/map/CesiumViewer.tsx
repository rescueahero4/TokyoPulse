import * as Cesium from 'cesium';
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from 'react';
import type { Lang, PulseEvent } from '../lib/types';
import type { LineCollection, StationCollection } from '../lib/geo';
import { lineSegments } from '../lib/geo';
import { renderRail } from './layers/rail';
import { renderQuakes } from './layers/quakes';
import { renderWarnings } from './layers/warnings';
import { renderCrowd } from './layers/crowd';
import { addFloodLayer } from './layers/flood';
import { renderPeopleFlow } from './layers/peopleflow';
// Shared collapsible header owned by the panels agent. Imported, never edited,
// so the MAP cluster's collapse affordance matches every other HUD widget.
import { PanelHeader } from '../panels/PanelHeader';
import {
  BASEMAPS, DEFAULT_BASEMAP_ID, ION_TOKEN, SYNC_FALLBACK_ID, basemapById,
  buildBasemapLayerAsync, buildFirstWorkingBasemap, buildLabelOverlay,
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
/**
 * Camera bounds. The far end must clear Earth's radius (~6,371km) or the camera
 * can never retreat far enough to see the globe — it hits an invisible wall and
 * reads as "zoom is broken". That was a real bug here: the cap was 2,500km.
 * 30,000km gives one continuous zoom: globe -> country -> city -> street.
 */
const MIN_ZOOM_M = Number(env.VITE_MAP_MIN_ZOOM_M ?? 120) || 120;
const MAX_ZOOM_M = Number(env.VITE_MAP_MAX_ZOOM_M ?? 30_000_000) || 30_000_000;
/** Altitude at which the scene switches between globe dressing and flat city view. */
const GLOBE_ALTITUDE_M = Number(env.VITE_MAP_GLOBE_ALTITUDE_M ?? 1_000_000) || 1_000_000;
/** Opening shot altitude: Earth framed, Japan facing the viewer. */
const INTRO_HEIGHT_M = Number(env.VITE_MAP_INTRO_HEIGHT_M ?? 24_000_000) || 24_000_000;
const INTRO_SECONDS = Number(env.VITE_INTRO_DURATION_S ?? 3.6) || 3.6;
const INTRO_ENABLED = String(env.VITE_INTRO_FLIGHT ?? 'true') !== 'false';
/** One wheel-equivalent step for the +/- buttons. */
const ZOOM_STEP = 1.6;
const GSI_FLOOD = env.VITE_GSI_FLOOD_TILES
  || 'https://disaportaldata.gsi.go.jp/raster/01_flood_l2_shinsuishin_data/{z}/{x}/{y}.png';

// Versioned: bumping the suffix retires a saved preference so a changed default
// actually reaches the presenter's browser instead of losing to an old click.
const COLLAPSE_STORAGE_KEY = 'tp.collapsed.map';
const BASEMAP_STORAGE_KEY = 'tp.basemap.v3';
const LABELS_STORAGE_KEY = 'tp.basemapLabels.v3';

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
  /** Presenter toggle for station name labels. Owned by App/LayerPanel (A8);
   *  the map only consumes it. Defaults to on when the prop is absent. */
  showStationLabels?: boolean;
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
  const appliedBasemapRef = useRef<string>('');
  const labelSrcRef = useRef<string>('');
  const linesRef = useRef<LineCollection | null>(null);
  /** Kept fresh every render: the once-registered pick handler reads it instead of `props`. */
  const onLinePickRef = useRef<CesiumViewerProps['onLinePick']>(undefined);
  const [fatal, setFatal] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [basemapId, setBasemapId] = useState<string>(initialBasemapId);
  const [labelsOn, setLabelsOn] = useState<boolean>(() => {
    try { return window.localStorage.getItem(LABELS_STORAGE_KEY) !== '0'; } catch { return true; }
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState<boolean>(() => {
    // Persisted like every other widget so the presenter's layout survives a
    // reload. localStorage throws in a private window - never let that mount-block.
    try { return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) !== '1'; } catch { return true; }
  });
  const clusterRef = useRef<HTMLDivElement | null>(null);
  const [introFlying, setIntroFlying] = useState(false);
  const introTimerRef = useRef<number | null>(null);
  const atmosphereRef = useRef<boolean | null>(null);
  const skipCleanupRef = useRef<(() => void) | null>(null);
  const pinchCleanupRef = useRef<(() => void) | null>(null);
  /** Fresh every render so the once-registered pinch listener never goes stale. */
  const zoomInstantRef = useRef<((f: number) => void) | null>(null);
  const statsRef = useRef<Record<string, number>>({});

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSE_STORAGE_KEY, controlsOpen ? '0' : '1');
    } catch { /* private window */ }
  }, [controlsOpen]);

  /**
   * Publish the cluster's rendered height so the LayerPanel stacked above it can
   * anchor off a live value instead of a guessed constant:
   *   bottom: calc(34px + var(--tp-map-cluster-h) + 8px)
   * A ResizeObserver keeps it correct through collapse/expand and window resize.
   */
  useEffect(() => {
    const el = clusterRef.current;
    const root = document.documentElement;
    if (!el) return;
    const publish = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) root.style.setProperty('--tp-map-cluster-h', h + 'px');
    };
    publish();
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(publish);
      ro.observe(el);
    } catch {
      window.addEventListener('resize', publish);
    }
    return () => {
      try { ro?.disconnect(); } catch { /* ignore */ }
      window.removeEventListener('resize', publish);
      root.style.removeProperty('--tp-map-cluster-h');
    };
  }, [controlsOpen, pickerOpen]);

  linesRef.current = props.lines;
  onLinePickRef.current = props.onLinePick;

  /** Straight down over Tokyo Station. Shared by the home button, the map handle
   *  and the tail of the intro flight — one definition, three callers. */
  const flyHome = useCallback((duration = 1.2) => {
    const v = viewerRef.current;
    if (!v) return;
    try {
      v.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
        duration,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
      });
    } catch (e) {
      console.warn('[map] flyHome failed', e);
    }
  }, []);

  /** Instant height change, clamped. Used by the pinch handler where any
   *  animation would fight the gesture. */
  const zoomInstant = useCallback((factor: number) => {
    const v = viewerRef.current;
    if (!v) return;
    try {
      const cam = v.camera;
      const c = cam.positionCartographic;
      const target = Math.min(MAX_ZOOM_M, Math.max(MIN_ZOOM_M, c.height * factor));
      const delta = c.height - target;
      if (Math.abs(delta) < 0.5) return;
      if (delta > 0) cam.zoomIn(delta);
      else cam.zoomOut(-delta);
      v.scene.requestRender();
    } catch (e) {
      console.warn('[map] pinch zoom failed', e);
    }
  }, []);

  zoomInstantRef.current = zoomInstant;

  /** Multiply/divide camera height, clamped to the same bounds the wheel obeys. */
  const zoomByFactor = useCallback((factor: number) => {
    const v = viewerRef.current;
    if (!v) return;
    try {
      const cam = v.camera;
      const c = cam.positionCartographic;
      const target = Math.min(MAX_ZOOM_M, Math.max(MIN_ZOOM_M, c.height * factor));
      if (Math.abs(target - c.height) < 1) return;
      cam.flyTo({
        destination: Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, target),
        orientation: { heading: cam.heading, pitch: cam.pitch, roll: cam.roll },
        duration: 0.32,
        easingFunction: Cesium.EasingFunction.QUADRATIC_OUT,
      });
    } catch (e) {
      console.warn('[map] zoom button failed', e);
    }
  }, []);

  /**
   * Opening shot: full globe with Japan facing the viewer, a beat, then a
   * cinematic descent into central Tokyo (PRD §9 beat 1 — the first thing the
   * judges see). Any input cancels it instantly; a presenter is never trapped
   * inside an animation. Data keeps loading throughout — this touches only the
   * camera. Honours prefers-reduced-motion and VITE_INTRO_FLIGHT.
   */
  const runIntro = useCallback((force = false) => {
    const v = viewerRef.current;
    if (!v) return;
    const reduced = (() => {
      try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
    })();
    if (!force && (!INTRO_ENABLED || reduced)) {
      v.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      });
      return;
    }
    try {
      v.camera.cancelFlight();
      v.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(HOME.lon, HOME.lat, INTRO_HEIGHT_M),
        orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
      });
      setIntroFlying(true);
      if (introTimerRef.current) window.clearTimeout(introTimerRef.current);
      // Hold on the globe for a beat before the descent reads as deliberate.
      introTimerRef.current = window.setTimeout(() => {
        const vv = viewerRef.current;
        if (!vv) return;
        try {
          vv.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(HOME.lon, HOME.lat, HOME.height),
            orientation: { heading: 0, pitch: -Cesium.Math.PI_OVER_TWO, roll: 0 },
            duration: INTRO_SECONDS,
            easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
            complete: () => setIntroFlying(false),
            cancel: () => setIntroFlying(false),
          });
        } catch {
          setIntroFlying(false);
        }
      }, 700);
    } catch (e) {
      console.warn('[map] intro flight skipped', e);
      setIntroFlying(false);
      flyHome(0);
    }
  }, [flyHome]);

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
      flyHome();
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
    // Startup is always synchronous and keyless: the canvas must never wait on a
    // network round-trip to ion. The ion upgrade happens in the swap effect below.
    const { layer, def } = buildFirstWorkingBasemap(SYNC_FALLBACK_ID);
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
    appliedBasemapRef.current = def.id;
    // Exposed for QA / e2e probing. Read-only debugging handle, no secrets.
    (window as unknown as { __tpViewer?: Cesium.Viewer }).__tpViewer = viewer;
    console.info(
      '[map] viewer up, imagery=' + def.id + ' (sync keyless boot), ion token '
      + (ION_TOKEN ? 'present' : 'absent'),
    );
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
      if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
      scene.globe.showGroundAtmosphere = false;
      scene.globe.enableLighting = false;       // a lit globe dims our tiles; HUD wants flat
      scene.globe.depthTestAgainstTerrain = false;
      // NB: godseye's maximumScreenSpaceError 12-16 is on its 3D TILESETS, not the
      // globe. Raising it on the globe visibly blurs the satellite imagery, and
      // with the rail layer collapsed we no longer need to buy frames that way.
      scene.globe.maximumScreenSpaceError = 2;
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

    // Opening shot. Camera only - every layer keeps loading behind it.
    try {
      runIntro();
      console.info(
        '[map] intro flight ' + (INTRO_ENABLED ? 'armed' : 'disabled')
        + ', globe ' + Math.round(INTRO_HEIGHT_M / 1000) + 'km -> Tokyo '
        + Math.round(HOME.height / 1000) + 'km over ' + INTRO_SECONDS + 's',
      );
    } catch (e) {
      console.warn('[map] intro flight failed, jumping to Tokyo', e);
      flyHome(0);
    }

    // Any input cancels the flight where it stands - never trap the presenter.
    try {
      const skip = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      const cancel = () => {
        try {
          // `flying` is present at runtime but absent from Cesium's .d.ts.
          const flying = (viewer.camera as unknown as { flying?: boolean }).flying;
          if (flying || introTimerRef.current) {
            if (introTimerRef.current) {
              window.clearTimeout(introTimerRef.current);
              introTimerRef.current = null;
            }
            viewer.camera.cancelFlight();
            setIntroFlying(false);
          }
        } catch { /* ignore */ }
      };
      for (const t of [
        Cesium.ScreenSpaceEventType.LEFT_DOWN,
        Cesium.ScreenSpaceEventType.RIGHT_DOWN,
        Cesium.ScreenSpaceEventType.MIDDLE_DOWN,
        Cesium.ScreenSpaceEventType.WHEEL,
        Cesium.ScreenSpaceEventType.PINCH_START,
      ]) skip.setInputAction(cancel, t);
      window.addEventListener('keydown', cancel);
      skipCleanupRef.current = () => {
        window.removeEventListener('keydown', cancel);
        try { skip.destroy(); } catch { /* ignore */ }
      };
    } catch (e) {
      console.warn('[map] intro skip handler unavailable', e);
    }

    // Trackpad pinch. Browsers deliver a pinch as a `wheel` event with
    // ctrlKey=true, and Cesium's ScreenSpaceCameraController ignores those
    // outright — so on a laptop the natural zoom gesture silently does nothing.
    // Measured: three ctrl+wheel events left the camera at 27,776m unchanged.
    // Handle it ourselves, instantly, against the same clamps the wheel obeys.
    try {
      const onPinch = (e: WheelEvent) => {
        if (!e.ctrlKey) return;           // plain wheel is Cesium's job
        e.preventDefault();
        const f = Math.min(2, Math.max(0.5, Math.exp(e.deltaY * 0.002)));
        zoomInstantRef.current?.(f);
      };
      viewer.scene.canvas.addEventListener('wheel', onPinch, { passive: false });
      pinchCleanupRef.current = () => {
        try { viewer.scene.canvas.removeEventListener('wheel', onPinch); } catch { /* ignore */ }
      };
    } catch (e) {
      console.warn('[map] pinch-zoom handler unavailable', e);
    }

    // Globe dressing above GLOBE_ALTITUDE_M, flat tactical city view below it.
    // Guarded by a ref so this writes only when the threshold is actually crossed.
    try {
      viewer.scene.preRender.addEventListener(() => {
        const high = viewer.camera.positionCartographic.height > GLOBE_ALTITUDE_M;
        if (atmosphereRef.current === high) return;
        atmosphereRef.current = high;
        try {
          if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = high;
          viewer.scene.globe.showGroundAtmosphere = high;
          if (viewer.scene.skyBox) viewer.scene.skyBox.show = high;
        } catch { /* ignore */ }
      });
    } catch (e) {
      console.warn('[map] atmosphere altitude hook unavailable', e);
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
    // Two things this has to get right:
    //  1. The handler is registered once, so it must NOT close over `props` — that
    //     captures the mount-time callback and silently stops working.
    //     onLinePickRef is refreshed every render instead.
    //  2. drillPick, not pick: station markers sit above the lines with
    //     disableDepthTestDistance, so a plain pick loses a click that visually
    //     landed on a line. Drill through and take the first line we find.
    try {
      const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      handler.setInputAction((click: { position: Cesium.Cartesian2 }) => {
        try {
          const now = Cesium.JulianDate.now();
          const picks = viewer.scene.drillPick(click.position, 8, 12, 12) || [];
          for (const p of picks) {
            const entity = p && (p.id as Cesium.Entity | undefined);
            const kind = entity?.properties?.kind?.getValue?.(now);
            if (kind !== 'line') continue;
            const lineId = entity?.properties?.lineId?.getValue?.(now);
            if (lineId) {
              onLinePickRef.current?.(String(lineId));
              return;
            }
          }
        } catch (err) {
          console.warn('[map] line pick failed', err);
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
      if (introTimerRef.current) window.clearTimeout(introTimerRef.current);
      introTimerRef.current = null;
      skipCleanupRef.current?.();
      skipCleanupRef.current = null;
      pinchCleanupRef.current?.();
      pinchCleanupRef.current = null;
      floodRef.current = null;
      baseLayerRef.current = null;
      labelLayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- basemap swap. The base layer always sits at index 0 so the label
  // overlay and the flood raster (both added above it) keep compositing.
  // Async because the ion path is a network call; a failure leaves the current
  // surface untouched rather than blanking the canvas.
  useEffect(() => {
    if (!ready) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (appliedBasemapRef.current === basemapId) return;
    const def = basemapById(basemapId);
    if (!def) return;

    let cancelled = false;
    void (async () => {
      let built = await buildBasemapLayerAsync(def);
      if (!built && def.ion) {
        // ion refused (bad/expired/rate-limited token): degrade to keyless Esri.
        const fb = basemapById('satellite');
        built = await buildBasemapLayerAsync(fb);
        if (built) {
          console.warn('[map] imagery=esri-fallback (ion unavailable)');
          if (!cancelled) setBasemapId(fb.id);
        }
      }
      if (!built || cancelled || !viewerRef.current) return;
      const current = baseLayerRef.current;
      try {
        viewer.imageryLayers.add(built.layer, 0);
        if (current) viewer.imageryLayers.remove(current, true);
        baseLayerRef.current = built.layer;
        appliedBasemapRef.current = built.def.id;
        built.layer.imageryProvider.errorEvent.addEventListener((err: unknown) => {
          console.warn('[map] imagery tile error', err);
        });
        console.info('[map] imagery=' + built.path);
        viewer.scene.requestRender();
      } catch (e) {
        console.warn('[map] basemap swap failed, keeping current surface', e);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, basemapId]);

  // ---- minimal reference overlay (place names). Composited over the basemap,
  // godseye-style, so plain satellite imagery still reads like a city map.
  // Skipped for basemaps that already carry their own labels.
  useEffect(() => {
    if (!ready) return;
    const viewer = viewerRef.current;
    if (!viewer) return;
    const def = basemapById(basemapId);
    const want = labelsOn && !def.hasOwnLabels && !!def.labelUrl;
    try { window.localStorage.setItem(LABELS_STORAGE_KEY, labelsOn ? '1' : '0'); } catch { /* ignore */ }
    try {
      // Different basemaps want different label tiles (ward-scale over the grey
      // canvas, place-scale over imagery), so a stale overlay is torn down too.
      const wantSrc = want ? String(def.labelUrl) : '';
      if (labelLayerRef.current && labelSrcRef.current !== wantSrc) {
        viewer.imageryLayers.remove(labelLayerRef.current, true);
        labelLayerRef.current = null;
        labelSrcRef.current = '';
      }
      if (want && !labelLayerRef.current) {
        const layer = buildLabelOverlay(def);
        if (layer) {
          // index 1 = directly above the basemap, below the flood raster.
          viewer.imageryLayers.add(layer, 1);
          labelLayerRef.current = layer;
          labelSrcRef.current = wantSrc;
        }
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
      bump('crowd', renderCrowd(
        ds, props.stations, props.selectedLineId, props.lang,
        props.showStationLabels !== false,
      ));
      viewerRef.current?.scene.requestRender();
    } catch (e) {
      console.warn('[map] crowd layer failed', e);
    }
    // showStationLabels is in the deps so flipping it repaints immediately
    // instead of waiting for the next zoom or pan.
  }, [ready, props.stations, props.selectedLineId, props.lang, props.showStationLabels]);

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

      {/* Bottom-left control cluster: camera buttons, basemap chip, rail legend.
          Uses A8's shared PanelHeader so the collapse affordance is identical to
          WEATHER and every other widget. The zoom buttons live in the header's
          `actions` slot, so + / − / home / replay stay reachable while collapsed —
          losing the home button behind a collapse would be an on-stage downgrade.
          Height is published as --tp-map-cluster-h for the LayerPanel above. */}
      <div
        ref={clusterRef}
        className={'tp-panel map-controls' + (controlsOpen ? '' : ' tp-panel-collapsed')}
      >
        <PanelHeader
          title="MAP"
          label="Map controls"
          collapsed={!controlsOpen}
          onToggleCollapse={() => setControlsOpen((o) => !o)}
          actions={(
            <span className="map-zoom" role="group" aria-label="Zoom">
              <button type="button" onClick={() => zoomByFactor(1 / ZOOM_STEP)} title="Zoom in" aria-label="Zoom in">+</button>
              <button type="button" onClick={() => zoomByFactor(ZOOM_STEP)} title="Zoom out" aria-label="Zoom out">−</button>
              <button type="button" onClick={() => flyHome()} title="Reset view to central Tokyo" aria-label="Reset to Tokyo">⌂</button>
              <button
                type="button"
                className={introFlying ? 'is-active' : ''}
                onClick={() => runIntro(true)}
                title="Replay the globe → Tokyo intro flight"
                aria-label="Replay intro flight"
              >
                ⟳
              </button>
            </span>
          )}
        />

        {controlsOpen && (
          <div className="map-controls-body">
            {/* Basemap switcher — one chip; the menu opens upward. */}
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
                onClick={() => {
                  // Persist only an explicit choice: an automatic ion->Esri
                  // fallback must not become a sticky preference.
                  try { window.localStorage.setItem(BASEMAP_STORAGE_KEY, b.id); } catch { /* ignore */ }
                  setBasemapId(b.id);
                  setPickerOpen(false);
                }}
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

            {/* Rail status legend. Lines carry their official livery colour, so
                the status encoding has to be readable without explanation. */}
            <div className="map-legend" aria-label="Rail line status legend">
              <span className="map-legend-title">RAIL</span>
              <span className="map-legend-item"><i className="map-legend-swatch is-normal" />normal</span>
              <span className="map-legend-item"><i className="map-legend-swatch is-delay" />delay</span>
              <span className="map-legend-item"><i className="map-legend-swatch is-suspended" />suspended</span>
              <span className="map-legend-item"><i className="map-legend-swatch is-unknown" />no feed</span>
            </div>
          </div>
        )}
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
