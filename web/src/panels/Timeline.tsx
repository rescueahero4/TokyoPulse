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

export function Timeline(p: {
  events: PulseEvent[];
  loading: boolean;
  meta: Meta | null;
  selectedId: string | null;
  onSelect(e: PulseEvent): void;
  lang: Lang;
}): JSX.Element {
  const events = p.events ?? [];

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
          events.map((e) => {
            const icon = TYPE_ICON[e.type] ?? '\u{2139}\u{FE0F}';
            const selected = p.selectedId === e.id;
            return (
              <button
                key={e.id}
                type="button"
                role="listitem"
                className={`tp-timeline-row tp-severity-${e.severity}${selected ? ' tp-row-selected' : ''}`}
                onClick={() => p.onSelect(e)}
              >
                <span className={`tp-dot tp-severity-dot-${e.severity}`} aria-hidden="true" />
                <span className="tp-timeline-icon" aria-hidden="true">{icon}</span>
                <span className="tp-timeline-text">
                  <span className="tp-timeline-title">{titleFor(e, p.lang)}</span>
                  <span className="tp-timeline-sub">
                    <span className="tp-timeline-time">{formatClockWithRelative(e.time)}</span>
                    {e.source === 'replay' ? <span className="tp-chip tp-chip-replay">REPLAY</span> : null}
                  </span>
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
