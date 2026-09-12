// Standalone City Brief card — kept exported at its frozen signature.
// The demo HUD now renders the brief as the summary header inside `CityFeed`;
// this component remains usable on its own (and collapsible).

import type { Brief, Lang } from '../lib/types';
import { PanelHeader } from './PanelHeader';
import { useCollapse } from './useCollapse';

export function BriefCard(p: {
  brief: Brief | null;
  loading: boolean;
  lang: Lang;
  onRefresh(): void;
}): JSX.Element {
  const text = p.brief ? (p.lang === 'ja' ? p.brief.ja : p.brief.en) : null;
  const [collapsed, toggleCollapsed] = useCollapse('brief-card');

  return (
    <div className={`tp-panel tp-brief-card${collapsed ? ' tp-panel-collapsed' : ''}`}>
      <PanelHeader
        title="City Brief"
        label="City Brief"
        collapsed={collapsed}
        onToggleCollapse={toggleCollapsed}
        chips={collapsed && p.brief ? <span className="tp-chip tp-chip-provider">{p.brief.providerLabel}</span> : null}
        actions={
          <button
            type="button"
            className="tp-brief-refresh"
            onClick={() => p.onRefresh()}
            aria-label="Regenerate city brief"
          >
            {p.loading ? '…' : '⟳'}
          </button>
        }
      />
      {collapsed ? null : (
        <>
          <div className="tp-brief-body">
            {p.loading && !p.brief ? (
              <span className="tp-empty-row">Generating brief…</span>
            ) : text ? (
              <p className="tp-brief-text">{text}</p>
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
    </div>
  );
}
