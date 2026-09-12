import type { Impact } from '../lib/types';

const STATUS_COLOR: Record<Impact['status'], string> = {
  normal: '#22c55e',
  delay: '#f59e0b',
  suspended: '#ef4444',
  unknown: '#6b7280',
};

export function ImpactPanel(p: {
  impact: Impact | null;
  loading: boolean;
  onClose(): void;
  onStationClick(lat: number, lon: number): void;
}): JSX.Element {
  if (!p.impact) {
    // Rule: impact === null renders nothing at all. Empty fragment keeps the
    // exact JSX.Element return type from the contract while painting nothing.
    return <></>;
  }

  const impact = p.impact;

  return (
    <div className="tp-panel tp-impact-panel">
      <div className="tp-panel-header">
        <span className="tp-panel-title">
          {impact.name}
          {impact.nameJa ? <span className="tp-panel-title-ja"> · {impact.nameJa}</span> : null}
        </span>
        <button type="button" className="tp-impact-close" onClick={() => p.onClose()} aria-label="Close impact panel">
          ×
        </button>
      </div>
      <div className="tp-impact-status" style={{ color: STATUS_COLOR[impact.status] }}>
        <span className="tp-dot" style={{ backgroundColor: STATUS_COLOR[impact.status] }} aria-hidden="true" />
        {impact.statusText}
      </div>

      {p.loading ? <div className="tp-empty-row">Refreshing…</div> : null}

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
    </div>
  );
}
