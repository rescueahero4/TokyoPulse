// InspectorPanel — click anything on the map, get a card that says WHAT it is,
// WHAT its data says, and WHERE that data came from.
//
// The SOURCE footer is not decoration: AGENT-BRIEF rule 5 (honest labelling) is
// only credible if a judge can click a thing and read the caveat attached to it.
// So every card states its feed, its freshness, and — where it matters — what
// the data is NOT ("static annual survey, not live crowding"; "national quake
// feed, not Tokyo-only"; "hazard zone, not a live measurement").
//
// This panel fetches NOTHING. It resolves the clicked entity id against the
// events / lines / stations already held by App.tsx. It subscribes to map clicks
// via its own Cesium handler (web/src/map/inspector.ts), which leaves
// CesiumViewer.tsx untouched and coexists with A6's line-select handler.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Lang, Meta, PulseEvent } from '../lib/types';
import type { LineCollection, StationCollection } from '../lib/geo';
import { attachInspector, type MapPick } from '../map/inspector';
import { LAYER_INFO, railSource } from './dataSources';
import { wardCentroid } from '../lib/wards';
import { formatClock, formatClockWithRelative } from './time';
import { PanelHeader } from './PanelHeader';
import { useCollapse } from './useCollapse';

/** Tokyo Station — the reference point for "how far away was that quake". */
const TOKYO = { lat: 35.6812, lon: 139.7671 };

/** P2PQuake `maxScale` code -> JMA shindo label. 45 is "5-", 50 is "5+", etc. */
const SHINDO: Record<number, string> = {
  10: '1', 20: '2', 30: '3', 40: '4', 45: '5-', 50: '5+', 55: '6-', 60: '6+', 70: '7',
};

const SEVERITY_COLOR: Record<string, string> = {
  info: '#00b4ff',
  warning: '#ffaa00',
  critical: '#ff3333',
};

const STATUS_COLOR: Record<string, string> = {
  normal: '#00ff41',
  delay: '#ffaa00',
  suspended: '#ff3333',
  unknown: '#6b7280',
};

function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Never render a raw null / empty string into a row. */
function Row(p: { label: string; value: ReactNode; mono?: boolean; accent?: string }): JSX.Element {
  const empty =
    p.value === null ||
    p.value === undefined ||
    p.value === '' ||
    (typeof p.value === 'number' && Number.isNaN(p.value));
  return (
    <div className="tp-insp-row">
      <span className="tp-insp-row-label">{p.label}</span>
      <span
        className={`tp-insp-row-value${p.mono ? ' tp-insp-mono' : ''}${empty ? ' tp-insp-empty' : ''}`}
        style={!empty && p.accent ? { color: p.accent } : undefined}
      >
        {empty ? '—' : p.value}
      </span>
    </div>
  );
}

function freshness(meta: Meta | null | undefined): string {
  if (!meta) return 'freshness unknown';
  const when = meta.generatedAt ? formatClock(meta.generatedAt) : null;
  const bits = [meta.source ? meta.source.toUpperCase() : 'UNKNOWN'];
  if (when) bits.push(`payload ${when}`);
  if (meta.degraded) bits.push('CACHED / DEGRADED');
  return bits.join(' · ');
}

function SourceFooter(p: { text: string; meta?: Meta | null; note?: string; fresh?: string }): JSX.Element {
  return (
    <div className="tp-insp-source">
      <div className="tp-insp-source-head">
        <span className="tp-insp-source-label">Source</span>
        <span className="tp-insp-source-fresh">{p.fresh ?? freshness(p.meta)}</span>
      </div>
      <div className="tp-insp-source-text">{p.text}</div>
      {p.note ? <div className="tp-insp-source-note">{p.note}</div> : null}
    </div>
  );
}

function Band(p: { band: number }): JSX.Element {
  const n = Math.max(1, Math.min(5, Math.round(p.band || 1)));
  return (
    <span className="tp-insp-band" title={`ridership band ${n} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={`tp-insp-band-pip${i <= n ? ' tp-insp-band-pip-on' : ''}`} />
      ))}
      <span className="tp-insp-band-num">{n}/5</span>
    </span>
  );
}

export function InspectorPanel(p: {
  events: PulseEvent[];
  lines: LineCollection | null;
  stations: StationCollection | null;
  lang: Lang;
  /** When the GSI flood raster is on, a click on bare map explains the raster. */
  floodVisible?: boolean;
  peopleFlowVisible?: boolean;
  eventsMeta?: Meta | null;
  linesMeta?: Meta | null;
  stationsMeta?: Meta | null;
  onOpenImpact?(lineId: string): void;
}): JSX.Element | null {
  const [pick, setPick] = useState<MapPick>(null);
  const [collapsed, toggleCollapsed] = useCollapse('inspector');

  useEffect(() => attachInspector(setPick), []);

  if (!pick) return null;

  // A click on bare map only means something when an overlay without clickable
  // entities is on (the GSI flood raster, or the people-flow grid); otherwise
  // "clicked empty space" clears the inspector.
  if (pick.kind === 'ground' && !p.floodVisible && !p.peopleFlowVisible) return null;

  const close = () => setPick(null);

  let title = 'Inspector';
  let kindLabel = '';
  let body: ReactNode = null;
  let footer: ReactNode = null;

  if (pick.kind === 'station') {
    const f = (p.stations?.features ?? []).find((s) => s.properties?.stationId === pick.stationId);
    const s = f?.properties;
    title = s ? s.name : 'Station';
    kindLabel = 'Station · crowd layer';
    const servingIds = s?.lineIds ?? [];
    const serving = servingIds
      .map((id) => {
        const lf = (p.lines?.features ?? []).find((x) => x.properties?.lineId === id);
        return lf?.properties?.name || id;
      })
      .join(', ');
    body = s ? (
      <>
        <Row label="Name (JA)" value={s.nameJa} />
        <Row label="Station ID" value={s.stationId} mono />
        <Row label="Lines serving" value={serving} />
        <Row label="Ward" value={s.ward} />
        <Row
          label="Daily ridership"
          value={typeof s.ridership === 'number' ? `${s.ridership.toLocaleString()} passengers/day` : 'no data'}
          mono
        />
        <Row label="Ridership band" value={<Band band={s.ridershipBand} />} />
        <Row
          label="Flood zone"
          value={s.inFloodZone ? 'YES — inside GSI flood hazard zone' : 'No'}
          accent={s.inFloodZone ? '#00b4ff' : undefined}
        />
      </>
    ) : (
      <div className="tp-empty-row">Station {pick.stationId} is not in the loaded station set.</div>
    );
    footer = (
      <SourceFooter text={LAYER_INFO.crowd.source} meta={p.stationsMeta} note={LAYER_INFO.crowd.caveat} />
    );
  } else if (pick.kind === 'line') {
    const f = (p.lines?.features ?? []).find((x) => x.properties?.lineId === pick.lineId);
    const l = f?.properties;
    title = l ? l.name : pick.lineId;
    kindLabel = 'Rail line';
    const stationCount = (p.stations?.features ?? []).filter((s) =>
      (s.properties?.lineIds ?? []).includes(pick.lineId),
    ).length;
    // Provenance is per-OPERATOR, not per-status value — THREE different feeds
    // back this map now, and they do not agree on what counts as a delay:
    //   Toei       -> ODPT odpt:TrainInformation, publishes 15min+ delays
    //   JR East    -> traininfo.jreast.co.jp scrape, publishes 30min+ delays
    //   TokyoMetro -> no keyless feed at all; status stays honestly unknown
    const operator = l?.operator ?? '';
    const isJr = operator === 'JR-East';
    const hasFeed = !!l && l.statusSource !== 'none';
    const threshold = !hasFeed ? null : isJr ? '30 min or more (JR East)' : '15 min or more (ODPT)';
    body = l ? (
      <>
        <Row label="Name (JA)" value={l.nameJa} />
        <Row label="Operator" value={l.operator} />
        <Row
          label="Livery"
          value={
            <span className="tp-insp-swatch-wrap">
              <span className="tp-insp-swatch" style={{ backgroundColor: l.color || '#6b7280' }} />
              <span className="tp-insp-mono">{l.color || '—'}</span>
            </span>
          }
        />
        <Row
          label="Status"
          value={l.status ? l.status.toUpperCase() : 'unknown'}
          accent={STATUS_COLOR[l.status] ?? STATUS_COLOR.unknown}
        />
        <Row label="Status text" value={p.lang === 'ja' ? l.statusTextJa || l.statusText : l.statusText} />
        <Row label="Delay threshold" value={threshold ?? 'no feed — nothing is published'} />
        <Row label="Stations on line" value={stationCount > 0 ? String(stationCount) : 'no data'} mono />
        <Row label="Status updated" value={l.updatedAt ? formatClockWithRelative(l.updatedAt) : 'never'} mono />
        {p.onOpenImpact ? (
          <button type="button" className="tp-insp-action" onClick={() => p.onOpenImpact?.(pick.lineId)}>
            Open full impact (wards · stations · flood) →
          </button>
        ) : null}
      </>
    ) : (
      <div className="tp-empty-row">Line {pick.lineId} is not in the loaded line set.</div>
    );
    // Same strings the LayerPanel ⓘ popover shows — one source of truth.
    const rail = railSource(operator, hasFeed);
    footer = (
      <SourceFooter
        text={rail.source}
        meta={p.linesMeta}
        // The /lines payload itself is live; a Metro LINE's status is not. Saying
        // "LIVE" there would undo the whole point of the card.
        fresh={hasFeed ? undefined : 'NO STATUS FEED · geometry only'}
        note={rail.caveat}
      />
    );
  } else if (pick.kind === 'event') {
    const e = (p.events ?? []).find((x) => x.id === pick.eventId);
    if (!e) {
      body = <div className="tp-empty-row">This event has scrolled out of the current window.</div>;
      title = 'Event';
    } else if (e.type === 'quake') {
      title = p.lang === 'ja' && e.titleJa ? e.titleJa : e.title;
      kindLabel = 'Earthquake · epicentre';
      const dist =
        typeof e.lat === 'number' && typeof e.lon === 'number'
          ? haversineKm(TOKYO.lat, TOKYO.lon, e.lat, e.lon)
          : null;
      const shindo =
        typeof e.maxScale === 'number' ? SHINDO[e.maxScale] ?? (e.maxScale / 10).toFixed(0) : null;
      body = (
        <>
          <Row label="Magnitude" value={typeof e.magnitude === 'number' ? `M ${e.magnitude}` : 'no data'} mono />
          <Row label="JMA max intensity" value={shindo ? `shindo ${shindo}` : 'no data'} mono />
          <Row label="Epicentre (JA)" value={e.titleJa} />
          <Row
            label="Distance from Tokyo"
            value={dist === null ? 'no data' : `${Math.round(dist)} km`}
            mono
            accent={dist !== null && dist > 150 ? '#ffaa00' : undefined}
          />
          <Row
            label="Coordinates"
            value={
              typeof e.lat === 'number' && typeof e.lon === 'number'
                ? `${e.lat.toFixed(3)}, ${e.lon.toFixed(3)}`
                : 'no data'
            }
            mono
          />
          <Row label="Time" value={formatClockWithRelative(e.time)} mono />
          <Row label="Severity" value={e.severity.toUpperCase()} accent={SEVERITY_COLOR[e.severity]} />
          {dist !== null && dist > 150 ? (
            <div className="tp-insp-callout">
              {Math.round(dist)} km from Tokyo — felt shaking in Tokyo from this event is unlikely.
            </div>
          ) : null}
          {e.url ? (
            <a className="tp-insp-action" href={e.url} target="_blank" rel="noopener noreferrer">
              Verify on P2PQuake ↗
            </a>
          ) : null}
        </>
      );
      footer = (
        <SourceFooter
          text={`${LAYER_INFO.quakes.source}${e.source === 'replay' ? ' (REPLAYED for the demo)' : ''}`}
          meta={p.eventsMeta}
          note={LAYER_INFO.quakes.caveat}
        />
      );
    } else {
      // warning / weather
      title = p.lang === 'ja' && e.titleJa ? e.titleJa : e.title;
      kindLabel = e.type === 'warning' ? 'Government advisory' : 'Weather advisory';
      const wards = (e.affects || [])
        .map((t) => {
          const w = wardCentroid(t);
          return w ? (p.lang === 'ja' ? w.wardJa : w.ward) : null;
        })
        .filter(Boolean)
        .join(', ');
      body = (
        <>
          <Row label="Title (JA)" value={e.titleJa} />
          <Row label="Affected ward(s)" value={wards || 'Tokyo-wide / not ward-scoped'} />
          <Row label="Severity" value={e.severity.toUpperCase()} accent={SEVERITY_COLOR[e.severity]} />
          <Row label="Issued" value={formatClockWithRelative(e.time)} mono />
          <Row label="Feed" value={e.source} mono />
          {e.url ? (
            <a className="tp-insp-action" href={e.url} target="_blank" rel="noopener noreferrer">
              Open the original advisory ↗
            </a>
          ) : null}
        </>
      );
      footer = (
        <SourceFooter
          text={e.type === 'warning' ? LAYER_INFO.warnings.source : 'Open-Meteo hourly forecast for Tokyo'}
          meta={p.eventsMeta}
          note={e.type === 'warning' ? LAYER_INFO.warnings.caveat : 'Model forecast, not an observation.'}
        />
      );
    }
  } else if (pick.kind === 'ground' && !p.floodVisible && p.peopleFlowVisible) {
    title = 'People flow (typical pattern)';
    kindLabel = 'Derived grid · not live';
    body = (
      <>
        <Row label="What this is" value="A typical-pattern density surface, shown to give the map a human baseline." />
        <Row
          label="How it is derived"
          value="Distance-weighted from STATIC annual station ridership — it is a proxy, computed, not measured."
        />
        <Row label="What it is NOT" value="Real-time telco / GPS people-flow. No phone is being counted." />
        <Row
          label="Clicked point"
          value={
            typeof pick.lat === 'number' && typeof pick.lon === 'number'
              ? `${pick.lat.toFixed(4)}, ${pick.lon.toFixed(4)}`
              : 'no data'
          }
          mono
        />
      </>
    );
    footer = (
      <SourceFooter
        text={LAYER_INFO.peopleflow.source}
        meta={p.stationsMeta}
        note={LAYER_INFO.peopleflow.caveat}
      />
    );
  } else if (pick.kind === 'ground') {
    title = 'Flood hazard overlay';
    kindLabel = 'Raster layer · GSI';
    body = (
      <>
        <Row
          label="What this is"
          value="Predicted maximum inundation depth for a planning-scale flood (L2 scenario)."
        />
        <Row label="What it is NOT" value="A live water-level measurement. Nothing here is happening right now." />
        <Row
          label="Clicked point"
          value={
            typeof pick.lat === 'number' && typeof pick.lon === 'number'
              ? `${pick.lat.toFixed(4)}, ${pick.lon.toFixed(4)}`
              : 'no data'
          }
          mono
        />
        <Row label="Per-pixel depth" value="no data — the overlay is a raster image, not queryable values" />
      </>
    );
    footer = (
      <SourceFooter
        text={LAYER_INFO.flood.source}
        fresh="STATIC TILES · no timestamp"
        note={LAYER_INFO.flood.caveat}
      />
    );
  }

  return (
    <div className={`tp-panel tp-inspector${collapsed ? ' tp-panel-collapsed' : ''}`}>
      <PanelHeader
        title={title}
        sub={kindLabel}
        label="inspector"
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
        actions={
          <button type="button" className="tp-impact-close" onClick={close} aria-label="Close inspector">
            ×
          </button>
        }
      />
      {collapsed ? null : (
        <div className="tp-insp-body">
          {body}
          {footer}
        </div>
      )}
    </div>
  );
}
