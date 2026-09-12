import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CesiumViewer, LAYER_IDS, type MapHandle } from './map/CesiumViewer';
import { PEOPLEFLOW_LABEL } from './map/layers/peopleflow';
import { ErrorBoundary } from './lib/ErrorBoundary';
import { usePolling } from './lib/usePolling';
import {
  FORCE_MOCKS, fetchBrief, fetchEvents, fetchForecast, fetchImpact, fetchLayers, fetchLines,
  fetchSandboxes, fetchStations, linesFromCollection, probePeopleFlow, type Loaded,
} from './lib/api';
import { lineSegments } from './lib/geo';
import { wardCentroid } from './lib/wards';
import type { Impact, LayerState, Lang, PulseEvent, SandboxInfo, TimeWindow } from './lib/types';

import { AlertBanner } from './panels/AlertBanner';
import { CityFeed } from './panels/CityFeed';
import { LayerPanel } from './panels/LayerPanel';
import { LinePanel } from './panels/LinePanel';
import { ForecastStrip } from './panels/ForecastStrip';
import { InspectorPanel } from './panels/InspectorPanel';
import { fetchBuses } from './panels/busData';
import { StatusBar } from './panels/StatusBar';

import './styles/app.css';
import './styles/panels.css';

const DEFAULT_VISIBLE: Record<string, boolean> = {
  trains: true,
  quakes: true,
  warnings: true,
  crowd: true,
  flood: false,
  peopleflow: false,
  buses: false,   // ~360 vehicles: opt-in, never on by default
};

/**
 * Rows the LayerPanel shows. LAYER_IDS is the map's own list; `buses` is served
 * by /layers.json and rendered by the map, but is not in LAYER_IDS yet — without
 * this it would simply never appear in the panel (confirmed against the live
 * endpoint, which returns it). De-duped, so it becomes a no-op the moment the
 * map adds it to LAYER_IDS.
 */
const PANEL_LAYER_IDS: string[] = Array.from(new Set<string>([...LAYER_IDS, 'buses']));

/** Shared with the map (A6) and the LayerPanel control (A8). */
const STATION_LABELS_KEY = 'tp.showStationLabels';

/** Stable empty collections: identity churn here re-fires the map layer effects. */
const EMPTY_EVENTS: PulseEvent[] = [];
const EMPTY_SANDBOXES: SandboxInfo[] = [];

const LAYER_LABELS: Record<string, string> = {
  trains: 'Train lines',
  quakes: 'Earthquakes',
  warnings: 'Weather warnings',
  crowd: 'Station crowding',
  flood: 'Flood hazard (GSI)',
  peopleflow: PEOPLEFLOW_LABEL,
  buses: 'Toei buses (derived)',
};

export default function App() {
  const mapRef = useRef<MapHandle | null>(null);
  const leftColumnRef = useRef<HTMLDivElement | null>(null);

  // ---- UI state (App owns all of it; panels are pure)
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('now');
  const [lang, setLang] = useState<Lang>('en');
  const [visible, setVisible] = useState<Record<string, boolean>>(DEFAULT_VISIBLE);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [impact, setImpact] = useState<Impact | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [mapStats, setMapStats] = useState<Record<string, number>>({});
  const [peopleFlow, setPeopleFlow] = useState(false);
  // Station name labels: presenter toggle in LayerPanel, consumed by the map.
  // Persisted so the layout survives a reload; localStorage can throw in a
  // private window, so every read/write is guarded.
  const [showStationLabels, setShowStationLabels] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(STATION_LABELS_KEY) !== '0';
    } catch {
      return true;
    }
  });

  // ---- data (polling intervals per the brief)
  const eventsRes = usePolling(() => fetchEvents(timeWindow), 15_000, [timeWindow]);
  const linesRes = usePolling(fetchLines, 30_000);
  const layersRes = usePolling(fetchLayers, 20_000);
  const sandboxRes = usePolling(fetchSandboxes, 20_000);
  const stationsRes = usePolling(fetchStations, 0);
  const forecastRes = usePolling(fetchForecast, 0);
  // P1-8: interval 0 fetched the brief once, ever — it went stale next to a
  // scrolling timeline. /brief is already cached 60s server-side, so this costs
  // nothing extra.
  const briefRes = usePolling(fetchBrief, 60_000);
  // Bus vehicles: only polled while the layer is on (~360 features, and each
  // payload is valid for ~30s). Feeds the inspector's bus card.
  const busesRes = usePolling(
    () => (visible.buses ? fetchBuses() : Promise.resolve(null)),
    visible.buses ? 15_000 : 0,
    [visible.buses],
  );

  useEffect(() => {
    let alive = true;
    probePeopleFlow().then((ok) => { if (alive) setPeopleFlow(ok); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  // NB: a fresh [] literal here would change identity on every render and spin
  // the map layer effects into an update loop. Keep the empty case stable.
  const events: PulseEvent[] = eventsRes.data?.data.events ?? EMPTY_EVENTS;
  const eventsMeta = eventsRes.data?.data.meta ?? null;
  const lines = linesRes.data?.data ?? null;
  const lineList = useMemo(() => linesFromCollection(lines), [lines]);
  const stations = stationsRes.data?.data ?? null;

  /** lang toggle: swap title/titleJa everywhere, without destroying titleJa. */
  const localizedEvents = useMemo(
    () => events.map((e) => (lang === 'ja' && e.titleJa ? { ...e, title: e.titleJa } : e)),
    [events, lang],
  );

  // ---- impact, fetched when a line is selected
  useEffect(() => {
    if (!selectedLineId) {
      setImpact(null);
      setImpactLoading(false);
      return;
    }
    let alive = true;
    setImpactLoading(true);
    fetchImpact(selectedLineId)
      .then((res: Loaded<Impact>) => { if (alive) setImpact(res.data); })
      .catch(() => { if (alive) setImpact(null); })
      .finally(() => { if (alive) setImpactLoading(false); });
    return () => { alive = false; };
  }, [selectedLineId]);

  // ImpactPanel renders as the last item in the scrollable left column, below
  // LineSearch + LayerPanel — auto-scroll it into view so demo beat 3 ("click a
  // delayed line") shows the ward/flood breakdown immediately, no manual scroll.
  // Depends on `impact` too: ImpactPanel renders nothing until the fetch resolves,
  // so the .tp-impact-panel node doesn't exist yet on the tick selectedLineId changes.
  useEffect(() => {
    const col = leftColumnRef.current;
    if (!col) return;
    if (selectedLineId && impact) {
      const panel = col.querySelector('.tp-impact-panel');
      panel?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    } else if (!selectedLineId) {
      col.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [selectedLineId, impact]);

  // ---- layer health rows for LayerPanel (always all layers, never hidden)
  const layerStates: LayerState[] = useMemo(() => {
    const api = layersRes.data?.data.layers ?? [];
    const origin = layersRes.data?.origin ?? 'none';
    const byId = new Map(api.map((l) => [l.id, l]));
    return PANEL_LAYER_IDS.map((id) => {
      const a = byId.get(id);
      let state: LayerState['state'] = a?.state ?? (origin === 'api' ? 'off' : 'mock');
      // P1-5: flood used to be force-pinned 'live' here regardless of what the
      // API actually reported. /layers.json already gets this right (it says
      // 'cache' when Neo4j/the feed is down) — let that honest value through
      // instead of overclaiming on a layer that can be zero-count and still
      // show LIVE.
      if (id === 'peopleflow') state = peopleFlow ? state : 'off';
      // The API's count is the domain count (6 lines with live status); mapStats
      // is the Cesium entity count, which is a rendering detail and must never
      // be shown as if it were data. API first, map only as the fallback.
      const count = a?.count ?? mapStats[id] ?? 0;
      return {
        id,
        label: a?.label || LAYER_LABELS[id] || id,
        state,
        count,
        lastUpdate: a?.lastUpdate ?? null,
      };
    });
  }, [layersRes.data, mapStats, peopleFlow]);

  // ---- handlers
  const onToggleLayer = useCallback((id: string) => {
    setVisible((v) => ({ ...v, [id]: !v[id] }));
  }, []);

  const onToggleStationLabels = useCallback(() => {
    setShowStationLabels((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(STATION_LABELS_KEY, next ? '1' : '0'); } catch { /* private window */ }
      return next;
    });
  }, []);

  const onSelectEvent = useCallback((e: PulseEvent) => {
    setSelectedEventId(e.id);
    if (typeof e.lat === 'number' && typeof e.lon === 'number') {
      mapRef.current?.flyTo(e.lat, e.lon, e.type === 'quake' ? 300_000 : 12_000);
      return;
    }
    for (const token of e.affects || []) {
      const w = wardCentroid(token);
      if (w) { mapRef.current?.flyTo(w.lat, w.lon, 15_000); return; }
      const lineId = token.replace(/^line:/, '');
      const f = (lines?.features || []).find((x) => x.properties?.lineId === lineId);
      const segs = f ? lineSegments(f) : [];
      if (segs.length && segs[0].length) {
        const mid = segs[0][Math.floor(segs[0].length / 2)];
        mapRef.current?.flyTo(mid[1], mid[0], 20_000);
        return;
      }
    }
  }, [lines]);

  const onPickLine = useCallback((lineId: string | null) => {
    setSelectedLineId(lineId);
    if (!lineId) return;
    const f = (lines?.features || []).find((x) => x.properties?.lineId === lineId);
    const segs = f ? lineSegments(f) : [];
    if (segs.length && segs[0].length) {
      const all = segs.flat();
      const lon = all.reduce((s, c) => s + c[0], 0) / all.length;
      const lat = all.reduce((s, c) => s + c[1], 0) / all.length;
      mapRef.current?.flyTo(lat, lon, 28_000);
    }
  }, [lines]);

  const onStationClick = useCallback((lat: number, lon: number) => {
    mapRef.current?.flyTo(lat, lon, 4_000);
  }, []);

  // P1-4: `origin === 'api'` only means the HTTP request succeeded — a
  // degraded-but-200 response (e.g. dead Neo4j, API serving its cached mock
  // payload) kept `origin` at 'api' while the tooltip admitted the truth.
  // Drive the chip from the envelope's own honesty fields instead.
  const degraded = eventsMeta ? (eventsMeta.degraded || eventsMeta.source !== 'live') : true;

  return (
    <div className="app-root">
      <CesiumViewer
        ref={mapRef}
        lines={lines}
        stations={stations}
        events={localizedEvents}
        visible={visible}
        selectedLineId={selectedLineId}
        selectedEventId={selectedEventId}
        lang={lang}
        peopleFlowAvailable={peopleFlow}
        showStationLabels={showStationLabels}
        onLinePick={(id) => { setSearch(''); onPickLine(id); }}
        onStats={setMapStats}
      />

      <div className="hud">
        <ErrorBoundary label="StatusBar">
          <StatusBar
            sandboxes={sandboxRes.data?.data.sandboxes ?? EMPTY_SANDBOXES}
            window={timeWindow}
            onWindowChange={setTimeWindow}
            lang={lang}
            onLangChange={setLang}
          />
        </ErrorBoundary>

        <ErrorBoundary label="AlertBanner">
          <AlertBanner events={localizedEvents} onSelect={onSelectEvent} />
        </ErrorBoundary>

        {/* Single stacked left column (LineSearch -> LayerPanel -> ImpactPanel) so they
            never overlap each other or CityBrief below, and never reach as far into
            the map centre as two side-by-side columns did. Internally scrollable. */}
        {/* Line search + line detail are ONE widget (LinePanel): picking a line
            expands its detail inside the same panel, so the search box can never
            be scrolled off. LineSearch and ImpactPanel stay exported for the
            frozen UI contract. */}
        <div className="tp-left-column" ref={leftColumnRef}>
          <ErrorBoundary label="LinePanel">
            <LinePanel
              lines={lineList}
              value={search}
              onChange={setSearch}
              onPick={onPickLine}
              selectedLineId={selectedLineId}
              impact={impact}
              impactLoading={impactLoading}
              onStationClick={onStationClick}
            />
          </ErrorBoundary>
        </div>

        {/* Bottom-left stack: API chip -> A6's MAP cluster -> Layers. */}
        <ErrorBoundary label="LayerPanel">
          <LayerPanel
            layers={layerStates}
            visible={visible}
            onToggle={onToggleLayer}
            showStationLabels={showStationLabels}
            onToggleStationLabels={onToggleStationLabels}
          />
        </ErrorBoundary>

        {/* City Brief + Timeline are ONE right-rail panel (CityFeed): the brief is
            the summary header, the filtered feed is the rows it came from.
            Timeline and BriefCard stay exported for the frozen UI contract. */}
        <ErrorBoundary label="CityFeed">
          <CityFeed
            events={events}
            loading={eventsRes.loading}
            meta={eventsMeta}
            selectedId={selectedEventId}
            onSelect={onSelectEvent}
            lang={lang}
            brief={briefRes.data?.data ?? null}
            briefLoading={briefRes.loading}
            onRefreshBrief={briefRes.refresh}
          />
        </ErrorBoundary>

        {/* Map-click inspector. It subscribes to its own Cesium pick handler
            (panels/../map/inspector.ts), so no map file changes; it only reads
            data App already holds. */}
        <ErrorBoundary label="InspectorPanel">
          <InspectorPanel
            events={events}
            lines={lines}
            stations={stations}
            lang={lang}
            floodVisible={!!visible.flood}
            peopleFlowVisible={!!visible.peopleflow && peopleFlow}
            eventsMeta={eventsMeta}
            linesMeta={lines?.meta ?? null}
            stationsMeta={stations?.meta ?? null}
            buses={busesRes.data ?? null}
            onOpenImpact={onPickLine}
          />
        </ErrorBoundary>

        <ErrorBoundary label="ForecastStrip">
          <ForecastStrip forecast={forecastRes.data?.data ?? null} loading={forecastRes.loading} />
        </ErrorBoundary>

        <div className="source-chip" title={eventsMeta?.note || ''}>
          {FORCE_MOCKS ? 'MOCKS FORCED' : degraded ? 'API UNREACHABLE / MOCK' : 'API LIVE'}
        </div>
      </div>
    </div>
  );
}
