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
  /** contracts/api.md AMENDED post-freeze: the real upstream request URL, so a
   *  viewer can click through and verify the numbers themselves. Optional/null
   *  on an older cached payload that predates the amendment. */
  sourceUrl?: string | null;
  sourceName?: string | null;
  attribution?: string | null;
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
