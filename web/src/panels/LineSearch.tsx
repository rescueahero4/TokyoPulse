import { useState } from 'react';
import type { LineProps } from '../lib/types';

const STATUS_COLOR: Record<LineProps['status'], string> = {
  normal: '#22c55e',
  delay: '#f59e0b',
  suspended: '#ef4444',
  unknown: '#6b7280',
};

function matches(line: LineProps, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    line.name.toLowerCase().includes(q) ||
    (line.nameJa ?? '').toLowerCase().includes(q) ||
    line.lineId.toLowerCase().includes(q)
  );
}

export function LineSearch(p: {
  lines: LineProps[];
  value: string;
  onChange(v: string): void;
  onPick(lineId: string | null): void;
  selectedLineId: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const lines = p.lines ?? [];
  const results = lines.filter((l) => matches(l, p.value));

  return (
    <div className="tp-panel tp-line-search">
      <div className="tp-panel-header">
        <span className="tp-panel-title">Lines</span>
      </div>
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
            onClick={() => {
              p.onPick(null);
              p.onChange('');
            }}
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
                onMouseDown={(ev) => {
                  // onMouseDown fires before input's onBlur, so the click still registers.
                  ev.preventDefault();
                  p.onPick(line.lineId);
                  p.onChange(line.name);
                  setOpen(false);
                }}
              >
                <span
                  className="tp-dot"
                  style={{ backgroundColor: line.color || STATUS_COLOR[line.status] }}
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
    </div>
  );
}
