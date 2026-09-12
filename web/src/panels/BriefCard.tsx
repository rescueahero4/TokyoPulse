import type { Brief, Lang } from '../lib/types';

export function BriefCard(p: {
  brief: Brief | null;
  loading: boolean;
  lang: Lang;
  onRefresh(): void;
}): JSX.Element {
  const text = p.brief ? (p.lang === 'ja' ? p.brief.ja : p.brief.en) : null;

  return (
    <div className="tp-panel tp-brief-card">
      <div className="tp-panel-header">
        <span className="tp-panel-title">City Brief</span>
        <button type="button" className="tp-brief-refresh" onClick={() => p.onRefresh()}>
          {p.loading ? '…' : '⟳'}
        </button>
      </div>
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
          <span className="tp-brief-provider">{p.brief.providerLabel}</span>
          <span className="tp-brief-count">{p.brief.eventCount} events</span>
        </div>
      ) : null}
    </div>
  );
}
