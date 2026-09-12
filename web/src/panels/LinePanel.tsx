// LinePanel — the line search and the line detail as ONE widget (top-left).
//
// Same pattern as CityFeed (brief + timeline): the search box is the header,
// and picking a line expands its detail INSIDE the same panel instead of
// opening a second floating one. That also removes the defect where the impact
// panel pushed the search box off the top of the column — merged, it cannot
// happen: the panel is bounded and only the detail scrolls.
//
// LineSearch and ImpactPanel stay exported at their frozen signatures; this is
// a new composite, and the detail body is the very same `ImpactBody` component.
//
// A6 depends on the pick behaviour: onPick(lineId) still fires on selection so
// the map highlights the line and labels its stations, and onPick(null) clears.

import { useCallback, useEffect, useRef } from 'react';
import type { Impact, Lang, LineProps } from '../lib/types';
import { PanelHeader } from './PanelHeader';
import { useCollapse } from './useCollapse';
import { ImpactBody, STATUS_COLOR } from './ImpactPanel';
import { leftColumnMaxPx, subscribeStack } from './stack';

function matches(line: LineProps, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    line.name.toLowerCase().includes(q) ||
    (line.nameJa ?? '').toLowerCase().includes(q) ||
    line.lineId.toLowerCase().includes(q)
  );
}

/** Operators in the order a Tokyo resident reads them; anything else falls to the end. */
const OPERATOR_ORDER = ['Toei', 'JR-East', 'TokyoMetro'];
const OPERATOR_LABEL: Record<string, string> = {
  Toei: 'Toei',
  'JR-East': 'JR East',
  TokyoMetro: 'Tokyo Metro',
};

interface LineGroup {
  key: string;
  label: string;
  lines: LineProps[];
  live: number;
}

/**
 * Group by operator. This is deliberately NOT hidden detail: it makes the
 * 11-live / 9-no-feed split legible at a glance, which is the honest shape of
 * what the keyless feeds actually cover.
 */
function groupByOperator(lines: LineProps[]): LineGroup[] {
  const byOp = new Map<string, LineProps[]>();
  for (const l of lines) {
    const key = l.operator || 'Other';
    const arr = byOp.get(key);
    if (arr) arr.push(l);
    else byOp.set(key, [l]);
  }
  const rank = (k: string) => {
    const i = OPERATOR_ORDER.indexOf(k);
    return i === -1 ? OPERATOR_ORDER.length : i;
  };
  return [...byOp.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([key, group]) => ({
      key,
      label: OPERATOR_LABEL[key] ?? key,
      lines: group,
      live: group.filter((l) => l.statusSource !== 'none').length,
    }));
}

export function LinePanel(p: {
  lines: LineProps[];
  /** Row language. Optional with a safe default so older call sites still type-check. */
  lang?: Lang;
  value: string;
  onChange(v: string): void;
  onPick(lineId: string | null): void;
  selectedLineId: string | null;
  impact: Impact | null;
  impactLoading: boolean;
  onStationClick(lat: number, lon: number): void;
}): JSX.Element {
  const [collapsed, toggleCollapsed] = useCollapse('lines');
  const unsubRef = useRef<(() => void) | null>(null);

  // The panel bounds ITSELF (inline px) so it can never grow down into the
  // bottom-left stack — see panels/stack.ts. Only the detail below scrolls, so
  // the search box stays put no matter how long a line's detail is.
  const bindHeight = useCallback((el: HTMLElement | null) => {
    unsubRef.current?.();
    unsubRef.current = null;
    if (!el) return;
    const apply = () => {
      try {
        el.style.maxHeight = `${leftColumnMaxPx()}px`;
      } catch {
        /* CSS fallback stands */
      }
    };
    apply();
    unsubRef.current = subscribeStack(apply);
  }, []);

  useEffect(() => () => unsubRef.current?.(), []);
  const lang: Lang = p.lang ?? 'en';
  const lines = p.lines ?? [];
  // The list is ALWAYS shown — the search box filters it rather than summoning
  // it, so a user who does not already know a line name still sees all 20.
  const results = lines.filter((l) => matches(l, p.value));
  const groups = groupByOperator(results);
  const selected = lines.find((l) => l.lineId === p.selectedLineId) ?? null;
  const hasDetail = !!p.selectedLineId;
  const hasQuery = p.value.trim().length > 0;
  // With a line selected the list gets out of the way entirely so the detail
  // has the whole panel. The search input NEVER hides though — it is the only
  // route back to the list, so typing re-summons the filtered list (compact,
  // above the detail) and picking from it swaps the detail in place.
  const showList = !hasDetail || hasQuery;

  const clear = () => {
    p.onPick(null);
    p.onChange('');
  };

  return (
    <div ref={bindHeight} className={`tp-panel tp-line-panel${collapsed ? ' tp-panel-collapsed' : ''}`}>
      <PanelHeader
        title="Lines"
        label="Lines"
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
        chips={<span className="tp-chip tp-chip-count">{lines.length}</span>}
      />

      {collapsed ? null : (
        <>
          <div className="tp-line-search-input-row">
            <input
              type="text"
              className="tp-line-search-input"
              /* With the list hidden the input is the only way back to it, so say so. */
              placeholder={hasDetail && !hasQuery ? 'Type to switch line…' : 'Filter lines…'}
              value={p.value}
              onChange={(ev) => p.onChange(ev.target.value)}
            />
            {p.value || p.selectedLineId ? (
              <button
                type="button"
                className="tp-line-search-clear"
                onClick={clear}
                aria-label="Clear line selection"
              >
                ×
              </button>
            ) : null}
          </div>

          {showList ? (
          <div
            className={`tp-line-search-results${hasDetail ? ' tp-line-search-results-compact' : ''}`}
            role="listbox"
          >
            {results.length === 0 ? (
              <div className="tp-empty-row">No lines match “{p.value}”</div>
            ) : (
              groups.map((g) => (
                <div key={g.key} className="tp-line-group">
                  <div className="tp-line-group-head">
                    <span>{g.label}</span>
                    <span className="tp-line-group-stat">
                      {g.live === 0
                        ? `${g.lines.length} · no live feed`
                        : `${g.live}/${g.lines.length} live`}
                    </span>
                  </div>
                  {g.lines.map((line) => (
                    <button
                      type="button"
                      key={line.lineId}
                      className={`tp-line-search-result${line.lineId === p.selectedLineId ? ' tp-row-selected' : ''}`}
                      style={{ borderLeft: `3px solid ${line.color || '#6b7280'}` }}
                      onClick={() => { p.onPick(line.lineId); p.onChange(''); }}
                      title={line.statusText}
                    >
                      {/* Status dot MUST encode line.status, never livery (P0-1) —
                          livery is shown via the row's left border above. */}
                      <span
                        className="tp-dot"
                        style={{ backgroundColor: STATUS_COLOR[line.status] }}
                        title={line.statusText}
                        aria-hidden="true"
                      />
                      <span className="tp-line-search-name">
                        {lang === 'ja' && line.nameJa ? line.nameJa : line.name}
                      </span>
                      {/* Short status word in a 20-row list — the full statusText
                          would wrap every name onto three lines. It is still on
                          the row's title, and in full in the detail below. */}
                      <span className="tp-line-search-status" style={{ color: STATUS_COLOR[line.status] }}>
                        {line.status === 'unknown' ? 'no feed' : line.status}
                      </span>
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
          ) : null}

          {p.selectedLineId ? (
            <div className="tp-line-detail">
              <div className="tp-line-detail-head">
                <span className="tp-line-detail-title">
                  {p.impact?.name ?? selected?.name ?? p.selectedLineId}
                  {(p.impact?.nameJa ?? selected?.nameJa) ? (
                    <span className="tp-panel-title-ja"> · {p.impact?.nameJa ?? selected?.nameJa}</span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="tp-impact-close"
                  onClick={clear}
                  aria-label="Close line detail"
                >
                  ×
                </button>
              </div>
              {p.impact ? (
                <ImpactBody impact={p.impact} loading={p.impactLoading} onStationClick={p.onStationClick} />
              ) : (
                <div className="tp-empty-row">
                  {p.impactLoading ? 'Loading line detail…' : 'No detail available for this line'}
                </div>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
