# UI Component Contract — FROZEN at 0:15

This file exists so **A1a (map/shell) and A1b (panels) never touch the same file.** A1a imports; A1b exports. Both code to these signatures immediately, in parallel, with no waiting on each other.

## File ownership inside /web — DO NOT CROSS

| Path | Owner |
|---|---|
| `web/package.json`, `web/vite.config.ts`, `web/index.html`, `web/tsconfig*.json` | **A1a** |
| `web/src/main.tsx`, `web/src/App.tsx`, `web/src/styles/app.css` | **A1a** |
| `web/src/map/**` (Cesium viewer + all map layers) | **A1a** |
| `web/src/lib/**` (api client, types, hooks) | **A1a** |
| `web/src/panels/**` | **A1b** |
| `web/src/styles/panels.css` | **A1b** |

## Shared types

A1a writes `web/src/lib/types.ts` FIRST (within its first 5 minutes), exactly as below. A1b imports from `../lib/types` and may assume this file exists — if it does not yet, A1b re-declares nothing and waits zero seconds by writing against these exact names.

```ts
export type Severity = 'info' | 'warning' | 'critical';
export type EventType = 'quake' | 'train' | 'warning' | 'weather';
export type LineStatus = 'normal' | 'delay' | 'suspended' | 'unknown';
export type SourceKind = 'live' | 'cache' | 'mock';

export interface Meta {
  source: SourceKind;
  generatedAt: string;
  degraded: boolean;
  note: string | null;
}

export interface PulseEvent {
  id: string;
  type: EventType;
  severity: Severity;
  time: string;
  lat: number | null;
  lon: number | null;
  title: string;
  titleJa: string | null;
  affects: string[];
  source: string;
  url: string | null;
  magnitude?: number | null;
  maxScale?: number | null;
}

export interface LineProps {
  lineId: string;
  name: string;
  nameJa: string | null;
  operator: string | null;
  status: LineStatus;
  statusText: string;
  statusTextJa: string | null;
  color: string;
  statusSource: 'live' | 'cache' | 'mock' | 'none';
  updatedAt: string | null;
}

export interface ForecastHour {
  time: string;
  temperature: number;
  precipitation: number;
  isPast: boolean;
}

export interface Forecast {
  location: { lat: number; lon: number; name: string };
  nowIndex: number;
  hourly: ForecastHour[];
  summary: { maxPrecip24h: number; minTemp: number; maxTemp: number; rainHoursNext48: number };
  meta: Meta;
}

export interface Brief {
  en: string;
  ja: string;
  provider: string;
  providerLabel: string;
  eventCount: number;
  meta: Meta;
}

export interface SandboxInfo {
  name: string;
  feed: string;
  status: string;
  eventsWritten: number;
  lastWriteAt: string | null;
  startupMs: number | null;
}

export interface LayerState {
  id: string;
  label: string;
  state: 'live' | 'cache' | 'mock' | 'off';
  count: number;
  lastUpdate: string | null;
}

export interface Impact {
  lineId: string;
  name: string;
  nameJa: string | null;
  status: LineStatus;
  statusText: string;
  wards: { ward: string; wardJa: string; stationCount: number; activeEventCount: number }[];
  stations: {
    stationId: string; name: string; nameJa: string | null;
    lat: number; lon: number; ward: string | null;
    inFloodZone: boolean; ridershipBand: number;
  }[];
  events: PulseEvent[];
  stationsInFloodZone: number;
  meta: Meta;
}

export type TimeWindow = 'now' | '7d';
export type Lang = 'en' | 'ja';
```

## A1b exports — exact paths and props

A1a imports exactly these names from exactly these paths.

```ts
// web/src/panels/AlertBanner.tsx
export function AlertBanner(p: {
  events: PulseEvent[];
  onSelect(e: PulseEvent): void;
}): JSX.Element | null;
// Renders the single highest-severity event at severity >= warning. Returns null when there are none.
// Pinned top-centre over the map. Must NOT block map clicks outside its own box.

// web/src/panels/Timeline.tsx
export function Timeline(p: {
  events: PulseEvent[];
  loading: boolean;
  meta: Meta | null;
  selectedId: string | null;
  onSelect(e: PulseEvent): void;
  lang: Lang;
}): JSX.Element;
// Right rail, newest first, scrollable. Row click -> onSelect (App performs the camera flyTo).
// Shows a "CACHED" chip when meta.degraded is true. Shows a "REPLAY" chip when event.source === 'replay'.

// web/src/panels/LayerPanel.tsx
export function LayerPanel(p: {
  layers: LayerState[];
  visible: Record<string, boolean>;
  onToggle(id: string): void;
}): JSX.Element;
// One checkbox per layer. A layer with state === 'off' renders disabled and greyed — never hidden.

// web/src/panels/LineSearch.tsx
export function LineSearch(p: {
  lines: LineProps[];
  value: string;
  onChange(v: string): void;
  onPick(lineId: string | null): void;
  selectedLineId: string | null;
}): JSX.Element;
// Typeahead over name / nameJa / lineId. onPick(null) clears the selection.
// Each result shows a status dot coloured from LineProps.color plus its status label.

// web/src/panels/ForecastStrip.tsx
export function ForecastStrip(p: {
  forecast: Forecast | null;
  loading: boolean;
}): JSX.Element;
// Bottom strip. Static inline SVG: precipitation bars + temperature line, vertical "now" marker at nowIndex.
// Deliberately NOT an interactive scrubber (PRD risk row: time toggle overruns).

// web/src/panels/BriefCard.tsx
export function BriefCard(p: {
  brief: Brief | null;
  loading: boolean;
  lang: Lang;
  onRefresh(): void;
}): JSX.Element;
// Shows brief.en or brief.ja per lang. Footer prints brief.providerLabel verbatim.

// web/src/panels/ImpactPanel.tsx
export function ImpactPanel(p: {
  impact: Impact | null;
  loading: boolean;
  onClose(): void;
  onStationClick(lat: number, lon: number): void;
}): JSX.Element;
// Demo beat 3. Lists affected wards with station counts and shows stationsInFloodZone prominently.

// web/src/panels/StatusBar.tsx
export function StatusBar(p: {
  sandboxes: SandboxInfo[];
  window: TimeWindow;
  onWindowChange(w: TimeWindow): void;
  lang: Lang;
  onLangChange(l: Lang): void;
}): JSX.Element;
// Left: the "⚡ N Daytona sandboxes ingesting" badge (N = sandboxes.length, with per-sandbox dots on hover).
// Right: Now / 7d toggle and EN / JA toggle.
```

## Hard UI rules

Swarm rule #4: the orchestrator reviews the rendered browser, not the diff. These rules are what make that review fast.

1. **Every panel renders with empty or null input.** `events=[]` produces a "No events" row — not a crash, not an empty box.
2. **A1a wraps every panel in an error boundary.** One dead panel must never blank the Cesium canvas.
3. **No panel fetches anything.** A1a owns all data fetching and passes it down as props.
4. Panels are `position: absolute` over the map. Panel containers set `pointer-events: auto`; the map surface between them stays clickable.
5. Dark tactical HUD palette: panel bg `#0b0f14` at 80% alpha, border `#1f2a37`, text `#e6edf3`, accent `#38bdf8`. Severity colours: info `#38bdf8`, warning `#f59e0b`, critical `#ef4444`. Line status: normal `#22c55e`, delay `#f59e0b`, suspended `#ef4444`, unknown `#6b7280`.
6. Layout regions, so nothing overlaps: AlertBanner top-centre · LineSearch + LayerPanel top-left column · Timeline right rail (width 340px, full height minus strip) · ImpactPanel left, below LayerPanel · ForecastStrip bottom-centre (height 120px) · BriefCard bottom-left · StatusBar very top-left corner strip.
