// LayerPanel — godseye toggle switches (not checkboxes), and the whole panel
// collapses into a narrow vertical rail docked against the left edge of the
// viewport (the rail sits in the left column's 16px gutter via a negative
// margin, so it touches x=0 without overlapping anything).
//
// FROZEN RULE: a layer with state === 'off' renders DISABLED AND GREYED,
// never hidden. Every row is always present.

import type { LayerState } from '../lib/types';
import { formatClock } from './time';
import { PanelHeader } from './PanelHeader';
import { useCollapse } from './useCollapse';

const STATE_LABEL: Record<LayerState['state'], string> = {
  live: 'LIVE',
  cache: 'CACHED',
  mock: 'MOCK',
  off: 'OFF',
};

export function LayerPanel(p: {
  layers: LayerState[];
  visible: Record<string, boolean>;
  onToggle(id: string): void;
}): JSX.Element {
  const layers = p.layers ?? [];
  const [collapsed, toggleCollapsed] = useCollapse('layers');

  const activeCount = layers.reduce(
    (acc, l) => acc + (l.state !== 'off' && p.visible?.[l.id] ? 1 : 0),
    0,
  );

  // Collapsed: an icon-only rail stuck to the left edge of the viewport.
  if (collapsed) {
    return (
      <button
        type="button"
        className="tp-panel tp-layer-rail"
        onClick={toggleCollapsed}
        aria-expanded={false}
        aria-label="Expand layers panel"
        title={`Layers — ${activeCount}/${layers.length} on`}
      >
        <span className="tp-layer-rail-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" d="M10 3l7 3.5-7 3.5-7-3.5L10 3z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" d="M3 10.5L10 14l7-3.5" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" d="M3 14.5L10 18l7-3.5" />
          </svg>
        </span>
        <span className="tp-layer-rail-text">LAYERS</span>
        <span className="tp-layer-rail-count">{activeCount}</span>
      </button>
    );
  }

  return (
    <div className="tp-panel tp-layer-panel">
      <PanelHeader
        title="Layers"
        label="Layers"
        collapsed={false}
        onToggleCollapse={toggleCollapsed}
        chips={<span className="tp-chip tp-chip-count">{activeCount}/{layers.length}</span>}
      />
      <div className="tp-layer-list">
        {layers.length === 0 ? (
          <div className="tp-empty-row">No layers</div>
        ) : (
          layers.map((layer) => {
            const isOff = layer.state === 'off';
            const on = !isOff && !!p.visible?.[layer.id];
            return (
              <div key={layer.id} className={`tp-layer-row${isOff ? ' tp-layer-off' : ''}`}>
                <span className="tp-layer-main">
                  <span className="tp-layer-label">{layer.label}</span>
                  <span className="tp-layer-meta">
                    <span className={`tp-chip tp-chip-state-${layer.state}`}>{STATE_LABEL[layer.state]}</span>
                    <span className="tp-layer-count">{layer.count}</span>
                    <span className="tp-layer-updated">
                      {layer.lastUpdate ? formatClock(layer.lastUpdate) : '—'}
                    </span>
                  </span>
                </span>
                <button
                  type="button"
                  className={`tp-toggle-switch${on ? ' tp-toggle-on' : ''}`}
                  role="switch"
                  aria-checked={on}
                  aria-label={`${layer.label} layer`}
                  disabled={isOff}
                  title={isOff ? `${layer.label}: feed off` : `${layer.label}: ${on ? 'on' : 'off'}`}
                  onClick={() => { if (!isOff) p.onToggle(layer.id); }}
                />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
