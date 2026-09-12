// Shared collapsible panel header. Every widget in the HUD uses this so the
// collapse affordance is in the same place, looks the same, and behaves the
// same — godseye's chevron-in-the-header pattern.

import type { ReactNode } from 'react';

export function Chevron(p: { collapsed: boolean }): JSX.Element {
  return (
    <svg
      className={`tp-chevron${p.collapsed ? ' tp-chevron-collapsed' : ''}`}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 7.5l5 5 5-5" />
    </svg>
  );
}

export function PanelHeader(p: {
  title: ReactNode;
  /** Small mono caption beside the title (units, provenance, ranges). */
  sub?: ReactNode;
  /** Status chips (LOADING / CACHED / LIVE …). */
  chips?: ReactNode;
  /** Extra buttons (refresh, close) placed before the chevron. */
  actions?: ReactNode;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Accessible name for the collapse button, e.g. "Weather". */
  label?: string;
}): JSX.Element {
  const collapsible = typeof p.onToggleCollapse === 'function';
  const collapsed = !!p.collapsed;

  return (
    <div className={`tp-panel-header${collapsed ? ' tp-panel-header-collapsed' : ''}`}>
      {collapsible ? (
        <button
          type="button"
          className="tp-panel-heading tp-panel-heading-btn"
          onClick={p.onToggleCollapse}
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${p.label ?? 'panel'}`}
        >
          <Chevron collapsed={collapsed} />
          <span className="tp-panel-title">{p.title}</span>
          {p.sub ? <span className="tp-panel-sub">{p.sub}</span> : null}
        </button>
      ) : (
        <span className="tp-panel-heading">
          <span className="tp-panel-title">{p.title}</span>
          {p.sub ? <span className="tp-panel-sub">{p.sub}</span> : null}
        </span>
      )}
      <span className="tp-chip-row">
        {p.chips}
        {p.actions}
      </span>
    </div>
  );
}
