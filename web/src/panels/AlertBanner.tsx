import { useState } from 'react';
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
  // Dismissal is per-EVENT-ID, held in component state only.
  //  - per id, because /events is re-polled every 15s: suppressing "the banner"
  //    would either flash the same alert back or silence a genuinely new one;
  //  - state only (NOT localStorage, unlike the panel collapse state): a reload
  //    must bring alerts back. The presenter is clearing the view for a moment,
  //    not muting the demo.
  // A more severe alert arriving later is a different id, so it still breaks through.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const events = p.events ?? [];
  const qualifying = events.filter((e) => (SEVERITY_RANK[e.severity] ?? 0) >= 1);
  const top = pickTopEvent(qualifying.filter((e) => !dismissed.has(e.id)));

  // Contract: no qualifying event at all -> render nothing.
  if (qualifying.length === 0) return null;

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  };

  // Everything qualifying has been dismissed: leave one small, honest handle
  // so the presenter can bring the alerts back without a reload.
  if (!top) {
    return (
      <div className="tp-alert-banner-wrap">
        <button
          type="button"
          className="tp-alert-restore"
          onClick={() => setDismissed(new Set())}
          title="Show dismissed alerts again"
        >
          <span aria-hidden="true">⚠</span> {qualifying.length} alert{qualifying.length === 1 ? '' : 's'} dismissed
          <span className="tp-alert-restore-cta">show</span>
        </button>
      </div>
    );
  }

  const icon = TYPE_ICON[top.type] ?? '\u{2139}\u{FE0F}';

  return (
    <div className="tp-alert-banner-wrap">
      <div className={`tp-alert-banner tp-severity-${top.severity}`}>
        <button type="button" className="tp-alert-main" onClick={() => p.onSelect(top)}>
          <span className="tp-alert-icon" aria-hidden="true">{icon}</span>
          <span className="tp-alert-body">
            <span className="tp-alert-title">{top.title}</span>
            <span className="tp-alert-meta">
              {top.severity.toUpperCase()} · {formatClockWithRelative(top.time)}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="tp-alert-dismiss"
          aria-label={`Dismiss alert: ${top.title}`}
          title="Dismiss this alert"
          onClick={(ev) => {
            // Must not reach the banner body, or dismissing would also fly the camera.
            ev.stopPropagation();
            dismiss(top.id);
          }}
        >
          ×
        </button>
      </div>
    </div>
  );
}
