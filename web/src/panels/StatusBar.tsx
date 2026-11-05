import { FORCE_MOCKS } from '../lib/api';
import type { LiveFeed } from '../lib/useLiveFeed';
import type { Lang, SandboxInfo, TimeWindow } from '../lib/types';

// godseye neon palette (same semantics as ui-contract rule 5).
const SANDBOX_DOT_COLOR: Record<string, string> = {
  running: '#00ff41',
  starting: '#ffaa00',
  mock: '#00b4ff',
  stopped: '#6b7280',
  failed: '#ff3333',
};

function ago(epochSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function feedLabel({ phase, lastIngestAt }: LiveFeed): string {
  const when = lastIngestAt === null ? null : ago(lastIngestAt);
  if (phase === 'live') return `Live: updated ${when}`;
  if (phase === 'warming') return when ? `Refreshing: data from ${when}` : 'Refreshing feeds';
  if (phase === 'paused') return when ? `Paused: data from ${when}` : 'Paused';
  return 'Feeds refresh while viewed';
}

export function StatusBar(p: {
  sandboxes: SandboxInfo[];
  feed: LiveFeed;
  window: TimeWindow;
  onWindowChange(w: TimeWindow): void;
  lang: Lang;
  onLangChange(l: Lang): void;
}): JSX.Element {
  const sandboxes = p.sandboxes ?? [];

  return (
    <div className="tp-panel tp-status-bar">
      <div className="tp-status-sandbox-wrap">
        <span className="tp-status-sandbox-badge">
          {FORCE_MOCKS
            ? 'Snapshot: no live ingest'
            : sandboxes.length === 0
              ? feedLabel(p.feed)
              : <>{'⚡'} {sandboxes.length} Daytona sandbox{sandboxes.length === 1 ? '' : 'es'} ingesting</>}
        </span>
        {sandboxes.length > 0 && !FORCE_MOCKS ? (
          <div className="tp-status-sandbox-hover">
            {sandboxes.map((sb) => (
              <div key={sb.name} className="tp-status-sandbox-item">
                <span
                  className="tp-dot"
                  style={{ backgroundColor: SANDBOX_DOT_COLOR[sb.status] ?? '#6b7280' }}
                  aria-hidden="true"
                />
                <span className="tp-status-sandbox-name">{sb.name}</span>
                <span className="tp-status-sandbox-feed">{sb.feed}</span>
                <span className="tp-status-sandbox-status">{sb.status}</span>
                <span className="tp-status-sandbox-count">{sb.eventsWritten} events</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="tp-status-toggles">
        <div className="tp-toggle-group" role="group" aria-label="Time window">
          <button
            type="button"
            className={`tp-toggle-btn${p.window === 'now' ? ' tp-toggle-active' : ''}`}
            onClick={() => p.onWindowChange('now')}
          >
            Now
          </button>
          <button
            type="button"
            className={`tp-toggle-btn${p.window === '7d' ? ' tp-toggle-active' : ''}`}
            onClick={() => p.onWindowChange('7d')}
          >
            7d
          </button>
        </div>
        <div className="tp-toggle-group" role="group" aria-label="Language">
          <button
            type="button"
            className={`tp-toggle-btn${p.lang === 'en' ? ' tp-toggle-active' : ''}`}
            onClick={() => p.onLangChange('en')}
          >
            EN
          </button>
          <button
            type="button"
            className={`tp-toggle-btn${p.lang === 'ja' ? ' tp-toggle-active' : ''}`}
            onClick={() => p.onLangChange('ja')}
          >
            JA
          </button>
        </div>
      </div>
    </div>
  );
}
