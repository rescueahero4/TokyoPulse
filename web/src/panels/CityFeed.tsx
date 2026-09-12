// CityFeed — the merged right rail: CITY BRIEF (summary header) + pill type
// filters + the live event feed, in ONE panel.
//
// Why merged: the brief and the timeline are two renderings of the same /events
// query (AGENT-BRIEF "the single most important design idea"), so they read as
// one story — headline, then the rows the headline came from.
//
// Filtering is pure client-side over the `events` prop. This panel fetches
// NOTHING: App.tsx owns all data (ui-contract hard rule 3).

import { useMemo, useState } from 'react';
import type { Brief, EventType, Lang, Meta, PulseEvent } from '../lib/types';
import { PanelHeader } from './PanelHeader';
import { TimelineFeed } from './Timeline';
import { useCollapse } from './useCollapse';

type FilterId = 'all' | EventType;

/**
 * Our Event.type enum is frozen as quake | train | warning | weather.
 * These labels are the human-facing names for those same four values —
 * `warning` is the JMA government advisory feed, so it reads "Government".
 */
const FILTERS: { id: FilterId; label: string; title: string }[] = [
  { id: 'all', label: 'All', title: 'Every event type' },
  { id: 'quake', label: 'Earthquake', title: 'Earthquakes (P2PQuake / JMA seismic)' },
  { id: 'train', label: 'Trains', title: 'Train line status (ODPT)' },
  { id: 'warning', label: 'Government', title: 'Government advisories and warnings (JMA, Tokyo 130000)' },
  { id: 'weather', label: 'Weather', title: 'Weather / rain (Open-Meteo)' },
];

export function CityFeed(p: {
  events: PulseEvent[];
  loading: boolean;
  meta: Meta | null;
  selectedId: string | null;
  onSelect(e: PulseEvent): void;
  lang: Lang;
  brief: Brief | null;
  briefLoading: boolean;
  onRefreshBrief(): void;
}): JSX.Element {
  const events = p.events ?? [];
  const [collapsed, toggleCollapsed] = useCollapse('cityfeed');
  const [briefCollapsed, toggleBriefCollapsed] = useCollapse('cityfeed.brief');
  const [filter, setFilter] = useState<FilterId>('all');

  const counts = useMemo(() => {
    const c: Record<FilterId, number> = { all: events.length, quake: 0, train: 0, warning: 0, weather: 0 };
    for (const e of events) {
      if (e.type === 'quake' || e.type === 'train' || e.type === 'warning' || e.type === 'weather') {
        c[e.type] += 1;
      }
    }
    return c;
  }, [events]);

  const filtered = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => e.type === filter)),
    [events, filter],
  );

  const briefText = p.brief ? (p.lang === 'ja' ? p.brief.ja : p.brief.en) : null;
  const activeLabel = FILTERS.find((f) => f.id === filter)?.label ?? 'All';

  return (
    <div className={`tp-panel tp-city-feed${collapsed ? ' tp-panel-collapsed' : ''}`}>
      <PanelHeader
        title="City Feed"
        sub="brief + timeline"
        label="City Feed"
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
        chips={
          <>
            {p.loading ? <span className="tp-chip tp-chip-muted">LOADING</span> : null}
            {p.meta?.degraded ? <span className="tp-chip tp-chip-cached">CACHED</span> : null}
            <span className="tp-chip tp-chip-count">{counts.all}</span>
          </>
        }
      />

      {collapsed ? null : (
        <>
          {/* ---- CITY BRIEF: the summary header, collapsible on its own so the
                   feed can take the full rail height. ---- */}
          <section className={`tp-cf-brief${briefCollapsed ? ' tp-cf-brief-collapsed' : ''}`}>
            <div className="tp-cf-brief-head">
              <button
                type="button"
                className="tp-cf-brief-toggle"
                onClick={toggleBriefCollapsed}
                aria-expanded={!briefCollapsed}
                aria-label={`${briefCollapsed ? 'Expand' : 'Collapse'} city brief`}
              >
                <svg
                  className={`tp-chevron${briefCollapsed ? ' tp-chevron-collapsed' : ''}`}
                  viewBox="0 0 20 20"
                  fill="none"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 7.5l5 5 5-5" />
                </svg>
                <span>City Brief</span>
              </button>
              <span className="tp-chip-row">
                {/* providerLabel stays visible even collapsed — honest labelling. */}
                {briefCollapsed && p.brief ? (
                  <span className="tp-chip tp-chip-provider">{p.brief.providerLabel}</span>
                ) : null}
                <button
                  type="button"
                  className="tp-brief-refresh"
                  onClick={() => p.onRefreshBrief()}
                  aria-label="Regenerate city brief"
                  title="Regenerate city brief"
                >
                  {p.briefLoading ? '…' : '⟳'}
                </button>
              </span>
            </div>

            {briefCollapsed ? null : (
              <>
                <div className="tp-brief-body">
                  {p.briefLoading && !p.brief ? (
                    <span className="tp-empty-row">Generating brief…</span>
                  ) : briefText ? (
                    <p className="tp-brief-text">{briefText}</p>
                  ) : (
                    <span className="tp-empty-row">Brief unavailable</span>
                  )}
                </div>
                {p.brief ? (
                  <div className="tp-brief-footer">
                    {/* providerLabel printed VERBATIM — honesty requirement. */}
                    <span className="tp-brief-provider">{p.brief.providerLabel}</span>
                    <span className="tp-brief-count">{p.brief.eventCount} events</span>
                  </div>
                ) : null}
              </>
            )}
          </section>

          {/* ---- pill type filters ---- */}
          <div className="tp-pill-row" role="group" aria-label="Filter feed by event type">
            {FILTERS.map((f) => {
              const active = filter === f.id;
              const n = counts[f.id];
              return (
                <button
                  key={f.id}
                  type="button"
                  className={`tp-pill${active ? ' tp-pill-active' : ''}${n === 0 ? ' tp-pill-empty' : ''}`}
                  onClick={() => setFilter(f.id)}
                  aria-pressed={active}
                  title={f.title}
                >
                  <span className="tp-pill-label">{f.label}</span>
                  <span className="tp-pill-count">{n}</span>
                </button>
              );
            })}
          </div>

          <TimelineFeed
            events={filtered}
            loading={p.loading}
            selectedId={p.selectedId}
            onSelect={p.onSelect}
            lang={p.lang}
            emptyLabel={filter === 'all' ? 'No events' : `No ${activeLabel.toLowerCase()} events`}
          />
        </>
      )}
    </div>
  );
}
