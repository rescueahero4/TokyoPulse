import { useEffect, useMemo, useRef, useState } from 'react';
import type { Lang, PulseEvent } from '../lib/types';
import { formatClockWithRelative } from './time';

const SEVERITY_RANK: Record<string, number> = { critical: 2, warning: 1, info: 0 };

const TYPE_ICON: Record<string, string> = {
  quake: '\u{1F30D}', // 🌍
  train: '\u{1F686}', // 🚆
  warning: '\u{26A0}\u{FE0F}', // ⚠️
  weather: '\u{2614}', // ☔
};

/** Severity first, then newest — a stable order, so polling never reshuffles the carousel. */
function sortAlerts(events: PulseEvent[]): PulseEvent[] {
  return [...events].sort((a, b) => {
    const rank = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (rank !== 0) return rank;
    return new Date(b.time).getTime() - new Date(a.time).getTime();
  });
}

function titleFor(e: PulseEvent, lang: Lang): string {
  if (lang === 'ja') return e.titleJa ?? e.title;
  return e.title;
}

/**
 * Dismissal key. NOT the bare event id — `POST /demo/replay` re-injects the
 * SAME id (`replay-quake`) with a fresh timestamp, so keying on the id alone
 * meant a presenter who had dismissed alerts a minute earlier would fire the
 * scripted replay on stage and see NOTHING. Verified against the live endpoint.
 * Keying on id + time means: you dismissed that alert AS IT WAS; re-issued with
 * a newer timestamp it is news again. Re-issued JMA advisories (継続) behave the
 * same way, which is also what you want.
 */
function dismissKey(e: PulseEvent): string {
  return `${e.id}@${e.time}`;
}

/**
 * Pinned top-centre over the map.
 *
 * COLLAPSED BY DEFAULT — the map is the hero, so alerts announce themselves as a
 * compact chip instead of a banner covering Tokyo. The chip still carries the
 * top alert's title (and its REPLAY chip), so the alert text is in the DOM
 * without expanding: nothing that reads this component has to expand it first.
 *
 * Expanding gives a carousel: ‹ / › arrows (mouse or keyboard), a position
 * counter and dots, and ONE button that dismisses everything and collapses.
 *
 * Dismissal is per-EVENT-ID in component state and is deliberately NOT persisted
 * to localStorage: /events re-polls every 15s, so suppressing "the banner"
 * wholesale would either flash the same alert back or silence a genuinely new
 * one — and a reload must bring alerts back. A new id (the scripted
 * /demo/replay quake, say) is not in the dismissed set, so it surfaces even
 * seconds after a dismiss-all. A NEW critical additionally auto-expands: a
 * critical alert silently hiding inside a collapsed chip would be the one
 * failure mode worse than an occluded map.
 */
export function AlertBanner(p: {
  events: PulseEvent[];
  onSelect(e: PulseEvent): void;
  /** Optional: title language. Defaults to 'en' so the frozen 2-prop call still type-checks. */
  lang?: Lang;
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);
  /** The alert being shown, tracked by ID (not index) so a poll can't yank it. */
  const [currentId, setCurrentId] = useState<string | null>(null);
  const carouselRef = useRef<HTMLDivElement | null>(null);
  const seenCriticalRef = useRef<Set<string>>(new Set());

  const lang: Lang = p.lang ?? 'en';
  const events = p.events ?? [];

  const qualifying = useMemo(
    () => sortAlerts(events.filter((e) => (SEVERITY_RANK[e.severity] ?? 0) >= 1)),
    [events],
  );
  const active = useMemo(
    () => qualifying.filter((e) => !dismissed.has(dismissKey(e))),
    [qualifying, dismissed],
  );

  // A critical we have never shown before forces the carousel open on its slide.
  useEffect(() => {
    const fresh = active.find((e) => e.severity === 'critical' && !seenCriticalRef.current.has(dismissKey(e)));
    if (!fresh) return;
    for (const e of active) {
      if (e.severity === 'critical') seenCriticalRef.current.add(dismissKey(e));
    }
    setCurrentId(fresh.id);
    setExpanded(true);
  }, [active]);

  // Arrow keys only work while the carousel holds focus, so they never fight the
  // map camera or the line-search input.
  useEffect(() => {
    if (expanded) carouselRef.current?.focus();
  }, [expanded]);

  // Contract: nothing at severity >= warning -> render nothing at all.
  if (qualifying.length === 0) return null;

  const dismissAll = () => {
    setDismissed(new Set(qualifying.map(dismissKey)));
    setExpanded(false);
  };

  // Everything currently qualifying was dismissed: stay collapsed, but leave one
  // handle so the presenter can bring them back without a reload.
  if (active.length === 0) {
    return (
      <div className="tp-alert-banner-wrap">
        <button
          type="button"
          className="tp-alert-banner tp-alert-restore"
          onClick={() => setDismissed(new Set())}
          title="Show dismissed alerts again"
        >
          <span aria-hidden="true">⚠</span> {qualifying.length} alert{qualifying.length === 1 ? '' : 's'} dismissed
          <span className="tp-alert-restore-cta">show</span>
        </button>
      </div>
    );
  }

  const idx = Math.max(0, active.findIndex((e) => e.id === currentId));
  const current = active[idx];
  const icon = TYPE_ICON[current.type] ?? '\u{2139}\u{FE0F}';
  const step = (delta: number) => {
    const next = (idx + delta + active.length) % active.length;
    setCurrentId(active[next].id);
  };

  // ---- collapsed: a compact chip that still names the top alert
  if (!expanded) {
    const top = active[0];
    return (
      <div className="tp-alert-banner-wrap">
        <button
          type="button"
          className={`tp-alert-banner tp-alert-chip tp-severity-${top.severity}`}
          onClick={() => { setCurrentId(top.id); setExpanded(true); }}
          aria-expanded={false}
          aria-label={`${active.length} active alert${active.length === 1 ? '' : 's'}. Expand`}
        >
          <span className={`tp-dot tp-severity-dot-${top.severity}`} aria-hidden="true" />
          <span className="tp-alert-chip-count">
            {active.length} alert{active.length === 1 ? '' : 's'}
          </span>
          <span className="tp-alert-chip-sep" aria-hidden="true" />
          <span className="tp-alert-icon" aria-hidden="true">{icon}</span>
          <span className="tp-alert-title tp-alert-chip-title">{titleFor(top, lang)}</span>
          {top.source === 'replay' ? <span className="tp-chip tp-chip-replay">REPLAY</span> : null}
          <span className="tp-alert-chip-cta" aria-hidden="true">▾</span>
        </button>
      </div>
    );
  }

  // ---- expanded: the carousel
  return (
    <div className="tp-alert-banner-wrap">
      <div
        ref={carouselRef}
        className={`tp-alert-banner tp-alert-carousel tp-severity-${current.severity}`}
        tabIndex={0}
        role="group"
        aria-label={`Alert ${idx + 1} of ${active.length}`}
        onKeyDown={(ev) => {
          if (ev.key === 'ArrowLeft') { ev.preventDefault(); step(-1); }
          else if (ev.key === 'ArrowRight') { ev.preventDefault(); step(1); }
          else if (ev.key === 'Escape') { ev.preventDefault(); setExpanded(false); }
        }}
      >
        <button
          type="button"
          className="tp-alert-arrow"
          aria-label="Previous alert"
          disabled={active.length < 2}
          onClick={(ev) => { ev.stopPropagation(); step(-1); }}
        >
          ‹
        </button>

        <button type="button" className="tp-alert-main" onClick={() => p.onSelect(current)}>
          <span className="tp-alert-icon" aria-hidden="true">{icon}</span>
          <span className="tp-alert-body">
            <span className="tp-alert-title">{titleFor(current, lang)}</span>
            <span className="tp-alert-meta">
              {current.severity.toUpperCase()} · {formatClockWithRelative(current.time)}
              {current.source === 'replay' ? <span className="tp-chip tp-chip-replay">REPLAY</span> : null}
            </span>
          </span>
        </button>

        <button
          type="button"
          className="tp-alert-arrow"
          aria-label="Next alert"
          disabled={active.length < 2}
          onClick={(ev) => { ev.stopPropagation(); step(1); }}
        >
          ›
        </button>

        <span className="tp-alert-counter" aria-hidden="true">{idx + 1} / {active.length}</span>

        <button
          type="button"
          className="tp-alert-dismiss"
          aria-label={`Dismiss all ${active.length} alerts`}
          title="Dismiss all alerts"
          onClick={(ev) => { ev.stopPropagation(); dismissAll(); }}
        >
          ×
        </button>
      </div>

      {active.length > 1 ? (
        <div className="tp-alert-dots" role="tablist" aria-label="Alert position">
          {active.map((e, i) => (
            <button
              key={e.id}
              type="button"
              role="tab"
              aria-selected={i === idx}
              aria-label={`Alert ${i + 1}: ${titleFor(e, lang)}`}
              className={`tp-alert-dot${i === idx ? ' tp-alert-dot-on' : ''} tp-alert-dot-${e.severity}`}
              onClick={(ev) => { ev.stopPropagation(); setCurrentId(e.id); }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
