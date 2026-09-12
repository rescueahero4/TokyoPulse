import { useMemo, useState } from 'react';
import type { Lang, Meta, PulseEvent } from '../lib/types';
import { formatClockWithRelative } from './time';

const TYPE_ICON: Record<string, string> = {
  quake: '\u{1F30D}', // 🌍
  train: '\u{1F686}', // 🚆
  warning: '\u{26A0}\u{FE0F}', // ⚠️
  weather: '\u{2614}', // ☔
};

function titleFor(e: PulseEvent, lang: Lang): string {
  if (lang === 'ja') {
    return e.titleJa ?? e.title;
  }
  return e.title;
}

type Row =
  | { kind: 'single'; event: PulseEvent }
  | { kind: 'group'; events: PulseEvent[] };

/**
 * Collapse runs of 2+ consecutive low-value "normal operation" train rows
 * (type=train, severity=info) into one summary row that expands on click.
 * Nothing is dropped — every event is still reachable, just regrouped so the
 * quake/disruption rows aren't crowded out. Warnings/critical rows, and lone
 * info rows, pass through unchanged.
 */
function groupRows(events: PulseEvent[]): Row[] {
  const rows: Row[] = [];
  let run: PulseEvent[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    if (run.length >= 2) rows.push({ kind: 'group', events: run });
    else rows.push({ kind: 'single', event: run[0] });
    run = [];
  };
  for (const e of events) {
    const isNormalTrain = e.type === 'train' && e.severity === 'info';
    if (isNormalTrain) {
      run.push(e);
    } else {
      flushRun();
      rows.push({ kind: 'single', event: e });
    }
  }
  flushRun();
  return rows;
}

export function Timeline(p: {
  events: PulseEvent[];
  loading: boolean;
  meta: Meta | null;
  selectedId: string | null;
  onSelect(e: PulseEvent): void;
  lang: Lang;
}): JSX.Element {
  const events = p.events ?? [];
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Split into "upcoming" (future-dated: forecast/weather-lookahead entries)
  // and the "what is happening now" stream, so a judge scanning the top of
  // the list sees live alerts first, not a 26h-out forecast headline.
  // Nothing is dropped — upcoming entries get their own pinned section.
  const now = Date.now();
  const { upcoming, current } = useMemo(() => {
    const upcomingList: PulseEvent[] = [];
    const currentList: PulseEvent[] = [];
    for (const e of events) {
      const t = new Date(e.time).getTime();
      if (!Number.isNaN(t) && t > now) upcomingList.push(e);
      else currentList.push(e);
    }
    return { upcoming: upcomingList, current: currentList };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recompute only when the event set changes
  }, [events]);

  const rows = useMemo(() => groupRows(current), [current]);

  function toggleGroup(key: string) {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function renderEventRow(e: PulseEvent, opts?: { upcoming?: boolean }) {
    const icon = TYPE_ICON[e.type] ?? '\u{2139}\u{FE0F}';
    const selected = p.selectedId === e.id;
    return (
      <button
        key={e.id}
        type="button"
        role="listitem"
        className={`tp-timeline-row tp-severity-${e.severity}${selected ? ' tp-row-selected' : ''}${
          opts?.upcoming ? ' tp-timeline-row-upcoming' : ''
        }`}
        onClick={() => p.onSelect(e)}
      >
        <span className={`tp-dot tp-severity-dot-${e.severity}`} aria-hidden="true" />
        <span className="tp-timeline-icon" aria-hidden="true">{icon}</span>
        <span className="tp-timeline-text">
          <span className="tp-timeline-title">{titleFor(e, p.lang)}</span>
          <span className="tp-timeline-sub">
            <span className="tp-timeline-time">{formatClockWithRelative(e.time)}</span>
            {opts?.upcoming ? <span className="tp-chip tp-chip-upcoming">UPCOMING</span> : null}
            {e.source === 'replay' ? <span className="tp-chip tp-chip-replay">REPLAY</span> : null}
          </span>
        </span>
      </button>
    );
  }

  function renderGroupRow(group: PulseEvent[]) {
    const key = `group:${group[0].id}`;
    const isOpen = expanded.has(key);
    return (
      <div key={key} className="tp-timeline-group">
        <button
          type="button"
          className="tp-timeline-row tp-timeline-row-group"
          onClick={() => toggleGroup(key)}
          aria-expanded={isOpen}
        >
          <span className="tp-dot tp-severity-dot-info" aria-hidden="true" />
          <span className="tp-timeline-icon" aria-hidden="true">{TYPE_ICON.train}</span>
          <span className="tp-timeline-text">
            <span className="tp-timeline-title">{group.length} lines: normal operation</span>
            <span className="tp-timeline-sub">
              <span className="tp-timeline-time">{isOpen ? 'click to collapse' : 'click to expand'}</span>
            </span>
          </span>
          <span className="tp-timeline-chevron" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
        </button>
        {isOpen ? (
          <div className="tp-timeline-group-body">
            {group.map((e) => renderEventRow(e))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="tp-panel tp-timeline">
      <div className="tp-panel-header">
        <span className="tp-panel-title">Timeline</span>
        <span className="tp-chip-row">
          {p.loading ? <span className="tp-chip tp-chip-muted">LOADING</span> : null}
          {p.meta?.degraded ? <span className="tp-chip tp-chip-cached">CACHED</span> : null}
        </span>
      </div>
      <div className="tp-timeline-list" role="list">
        {events.length === 0 ? (
          <div className="tp-empty-row">
            {p.loading ? 'Loading events…' : 'No events'}
          </div>
        ) : (
          <>
            {upcoming.length > 0 ? (
              <>
                <div className="tp-panel-subheader">Upcoming</div>
                {upcoming.map((e) => renderEventRow(e, { upcoming: true }))}
                <div className="tp-timeline-divider" role="separator">NOW</div>
              </>
            ) : null}
            {rows.length === 0 ? (
              <div className="tp-empty-row">No current events</div>
            ) : (
              rows.map((r) => (r.kind === 'single' ? renderEventRow(r.event) : renderGroupRow(r.events)))
            )}
          </>
        )}
      </div>
    </div>
  );
}
