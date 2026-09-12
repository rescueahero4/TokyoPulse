import type { PulseEvent } from '../lib/types';
import { formatClockWithRelative } from './time';

const SEVERITY_RANK: Record<string, number> = { critical: 2, warning: 1, info: 0 };

const TYPE_ICON: Record<string, string> = {
  quake: '\u{1F30D}', // 🌍
  train: '\u{1F686}', // 🚆
  warning: '\u{26A0}\u{FE0F}', // ⚠️
  weather: '\u{2614}', // ☔
};

function pickTopEvent(events: PulseEvent[]): PulseEvent | null {
  let best: PulseEvent | null = null;
  for (const e of events) {
    if (SEVERITY_RANK[e.severity] === undefined || SEVERITY_RANK[e.severity] < 1) continue;
    if (!best) {
      best = e;
      continue;
    }
    const bestRank = SEVERITY_RANK[best.severity] ?? 0;
    const eRank = SEVERITY_RANK[e.severity] ?? 0;
    if (eRank > bestRank) {
      best = e;
    } else if (eRank === bestRank) {
      const bestTime = new Date(best.time).getTime();
      const eTime = new Date(e.time).getTime();
      if (eTime > bestTime) best = e;
    }
  }
  return best;
}

export function AlertBanner(p: {
  events: PulseEvent[];
  onSelect(e: PulseEvent): void;
}): JSX.Element | null {
  const top = pickTopEvent(p.events ?? []);
  if (!top) return null;

  const icon = TYPE_ICON[top.type] ?? '\u{2139}\u{FE0F}';

  return (
    <div className="tp-alert-banner-wrap">
      <button
        type="button"
        className={`tp-alert-banner tp-severity-${top.severity}`}
        onClick={() => p.onSelect(top)}
      >
        <span className="tp-alert-icon" aria-hidden="true">{icon}</span>
        <span className="tp-alert-body">
          <span className="tp-alert-title">{top.title}</span>
          <span className="tp-alert-meta">
            {top.severity.toUpperCase()} · {formatClockWithRelative(top.time)}
          </span>
        </span>
      </button>
    </div>
  );
}
