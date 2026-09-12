import type { Impact } from '../lib/types';
import { PanelHeader } from './PanelHeader';
import { useCollapse } from './useCollapse';

// Line status on the godseye neon palette (same semantics as ui-contract rule 5).
const STATUS_COLOR: Record<Impact['status'], string> = {
  normal: '#00ff41',
  delay: '#ffaa00',
  suspended: '#ff3333',
  unknown: '#6b7280',
};

export function ImpactPanel(p: {
  impact: Impact | null;
  loading: boolean;
  onClose(): void;
  onStationClick(lat: number, lon: number): void;
}): JSX.Element {
  const [collapsed, toggleCollapsed] = useCollapse('impact');

  if (!p.impact) {
    // Rule: impact === null renders nothing at all. Empty fragment keeps the
    // exact JSX.Element return type from the contract while painting nothing.
    return <></>;
  }

  const impact = p.impact;

  // No graph rows for this line at all -> show one honest explanation instead of
  // four blank lists (wards, stations, the flood count, and its "0 of nothing").
  const noGraphData =
    (!impact.stations || impact.stations.length === 0) &&
    (!impact.wards || impact.wards.length === 0);

  return (
    <div className={`tp-panel tp-impact-panel${collapsed ? ' tp-panel-collapsed' : ''}`}>
      <PanelHeader
        title={
          <>
            {impact.name}
            {impact.nameJa ? <span className="tp-panel-title-ja"> · {impact.nameJa}</span> : null}
          </>
        }
        label="line impact"
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
        actions={
          <button type="button" className="tp-impact-close" onClick={() => p.onClose()} aria-label="Close impact panel">
            ×
          </button>
        }
      />
      {collapsed ? null : (
      <>
      <div className="tp-impact-status" style={{ color: STATUS_COLOR[impact.status] }}>
        <span className="tp-dot" style={{ backgroundColor: STATUS_COLOR[impact.status] }} aria-hidden="true" />
        {impact.statusText}
      </div>

      {p.loading ? <div className="tp-empty-row">Refreshing…</div> : null}

      {noGraphData ? (
        /* JR East and Tokyo Metro have no (Line)-[:SERVES]->(Station) rows: the
           keyless ODPT mirror only ever supplied Toei's 149 stations. Four empty
           lists would read as a bug; say what is actually missing and why. */
        <div className="tp-impact-nograph">
          <div className="tp-impact-nograph-title">Live status only</div>
          <p className="tp-impact-nograph-text">
            Station and ward data for this line isn&apos;t in the graph — the keyless ODPT feed
            covers Toei stations only.
          </p>
        </div>
      ) : (
      <>
      <div className="tp-impact-flood-banner">
        <span className="tp-impact-flood-count">{impact.stationsInFloodZone}</span>
        <span className="tp-impact-flood-label">stations in flood zone</span>
      </div>

      <div className="tp-impact-section">
        <div className="tp-panel-subheader">Wards affected</div>
        {(!impact.wards || impact.wards.length === 0) ? (
          <div className="tp-empty-row">No wards affected</div>
        ) : (
          <ul className="tp-impact-ward-list">
            {impact.wards.map((w) => (
              <li key={w.ward} className="tp-impact-ward-row">
                <span className="tp-impact-ward-name">
                  {w.ward}
                  {w.wardJa ? <span className="tp-panel-title-ja"> · {w.wardJa}</span> : null}
                </span>
                <span className="tp-impact-ward-stats">
                  {w.stationCount} stations · {w.activeEventCount} active
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="tp-impact-section">
        <div className="tp-panel-subheader">Stations</div>
        {(!impact.stations || impact.stations.length === 0) ? (
          <div className="tp-empty-row">No station data</div>
        ) : (
          <ul className="tp-impact-station-list">
            {impact.stations.map((s) => (
              <li key={s.stationId}>
                <button
                  type="button"
                  className="tp-impact-station-row"
                  onClick={() => p.onStationClick(s.lat, s.lon)}
                >
                  <span className="tp-impact-station-name">{s.name}</span>
                  {s.inFloodZone ? <span className="tp-chip tp-chip-flood">FLOOD</span> : null}
                  <span className="tp-impact-station-band">band {s.ridershipBand}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      </>
      )}

      {/* Events are graph-independent (they attach to the Line node itself), so
          this section renders for every operator, empty state or not. */}
      <div className="tp-impact-section">
        <div className="tp-panel-subheader">Events</div>
        {(!impact.events || impact.events.length === 0) ? (
          <div className="tp-empty-row">No events</div>
        ) : (
          <ul className="tp-impact-event-list">
            {impact.events.map((e) => (
              <li key={e.id} className={`tp-impact-event-row tp-severity-${e.severity}`}>
                <span className={`tp-dot tp-severity-dot-${e.severity}`} aria-hidden="true" />
                {e.title}
              </li>
            ))}
          </ul>
        )}
      </div>
      </>
      )}
    </div>
  );
}
