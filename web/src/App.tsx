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
import { Timeline } from './panels/Timeline';
import { LayerPanel } from './panels/LayerPanel';
import { LineSearch } from './panels/LineSearch';
import { ForecastStrip } from './panels/ForecastStrip';
import { BriefCard } from './panels/BriefCard';
import { ImpactPanel } from './panels/ImpactPanel';
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
};

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
};

export default function App() {
  const mapRef = useRef<MapHandle | null>(null);

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

  // ---- data (polling intervals per the brief)
  const eventsRes = usePolling(() => fetchEvents(timeWindow), 15_000, [timeWindow]);
  const linesRes = usePolling(fetchLines, 30_000);
  const layersRes = usePolling(fetchLayers, 20_000);
  const sandboxRes = usePolling(fetchSandboxes, 20_000);
  const stationsRes = usePolling(fetchStations, 0);
  const forecastRes = usePolling(fetchForecast, 0);
  const briefRes = usePolling(fetchBrief, 0);

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

  // ---- layer health rows for LayerPanel (always all layers, never hidden)
  const layerStates: LayerState[] = useMemo(() => {
    const api = layersRes.data?.data.layers ?? [];
    const origin = layersRes.data?.origin ?? 'none';
    const byId = new Map(api.map((l) => [l.id, l]));
    return LAYER_IDS.map((id) => {
      const a = byId.get(id);
      let state: LayerState['state'] = a?.state ?? (origin === 'api' ? 'off' : 'mock');
      if (id === 'flood') state = 'live';           // GSI raster, keyless and live
      if (id === 'peopleflow') state = peopleFlow ? state : 'off';
      const count = mapStats[id] ?? a?.count ?? 0;
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

  const degraded = (eventsRes.data?.origin ?? 'none') !== 'api';

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
        <div className="tp-left-column">
          <ErrorBoundary label="LineSearch">
            <LineSearch
              lines={lineList}
              value={search}
              onChange={setSearch}
              onPick={onPickLine}
              selectedLineId={selectedLineId}
            />
          </ErrorBoundary>

          <ErrorBoundary label="LayerPanel">
            <LayerPanel layers={layerStates} visible={visible} onToggle={onToggleLayer} />
          </ErrorBoundary>

          {selectedLineId && (
            <ErrorBoundary label="ImpactPanel">
              <ImpactPanel
                impact={impact}
                loading={impactLoading}
                onClose={() => { setSelectedLineId(null); setSearch(''); }}
                onStationClick={onStationClick}
              />
            </ErrorBoundary>
          )}
        </div>

        <ErrorBoundary label="Timeline">
          <Timeline
            events={events}
            loading={eventsRes.loading}
            meta={eventsMeta}
            selectedId={selectedEventId}
            onSelect={onSelectEvent}
            lang={lang}
          />
        </ErrorBoundary>

        <ErrorBoundary label="BriefCard">
          <BriefCard
            brief={briefRes.data?.data ?? null}
            loading={briefRes.loading}
            lang={lang}
            onRefresh={briefRes.refresh}
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
