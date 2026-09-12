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

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Impact, LineProps } from '../lib/types';
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

export function LinePanel(p: {
  lines: LineProps[];
  value: string;
  onChange(v: string): void;
  onPick(lineId: string | null): void;
  selectedLineId: string | null;
  impact: Impact | null;
  impactLoading: boolean;
  onStationClick(lat: number, lon: number): void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [collapsed, toggleCollapsed] = useCollapse('lines');
  const lines = p.lines ?? [];
  const results = lines.filter((l) => matches(l, p.value));
  const selected = lines.find((l) => l.lineId === p.selectedLineId) ?? null;

  const clear = () => {
    p.onPick(null);
    p.onChange('');
    setOpen(false);
  };

  return (
    <div className={`tp-panel tp-line-panel${collapsed ? ' tp-panel-collapsed' : ''}`}>
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
              placeholder="Search line…"
              value={p.value}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onChange={(ev) => p.onChange(ev.target.value)}
            />
            {p.selectedLineId ? (
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

          {open ? (
            <div className="tp-line-search-results" role="listbox">
              {results.length === 0 ? (
                <div className="tp-empty-row">No lines</div>
              ) : (
                results.map((line) => (
                  <button
                    type="button"
                    key={line.lineId}
                    className={`tp-line-search-result${line.lineId === p.selectedLineId ? ' tp-row-selected' : ''}`}
                    style={{ borderLeft: `3px solid ${line.color || '#6b7280'}` }}
                    onMouseDown={(ev) => {
                      // onMouseDown fires before the input's onBlur, so the click still registers.
                      ev.preventDefault();
                      p.onPick(line.lineId);
                      p.onChange(line.name);
                      setOpen(false);
                    }}
                  >
                    {/* Status dot MUST encode line.status, never livery (P0-1) —
                        livery is shown via the row's left border above. */}
                    <span
                      className="tp-dot"
                      style={{ backgroundColor: STATUS_COLOR[line.status] }}
                      title={line.statusText}
                      aria-hidden="true"
                    />
                    <span className="tp-line-search-name">{line.name}</span>
                    <span className="tp-line-search-status" style={{ color: STATUS_COLOR[line.status] }}>
                      {line.statusText}
                    </span>
                  </button>
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
