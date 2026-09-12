import type { LayerState } from '../lib/types';
import { formatClock } from './time';

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

  return (
    <div className="tp-panel tp-layer-panel">
      <div className="tp-panel-header">
        <span className="tp-panel-title">Layers</span>
      </div>
      <div className="tp-layer-list">
        {layers.length === 0 ? (
          <div className="tp-empty-row">No layers</div>
        ) : (
          layers.map((layer) => {
            const isOff = layer.state === 'off';
            const checked = !isOff && !!p.visible?.[layer.id];
            return (
              <label
                key={layer.id}
                className={`tp-layer-row${isOff ? ' tp-layer-off' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isOff}
                  onChange={() => p.onToggle(layer.id)}
                />
                <span className="tp-layer-label">{layer.label}</span>
                <span className={`tp-chip tp-chip-state-${layer.state}`}>{STATE_LABEL[layer.state]}</span>
                <span className="tp-layer-count">{layer.count}</span>
                <span className="tp-layer-updated">{layer.lastUpdate ? formatClock(layer.lastUpdate) : '—'}</span>
              </label>
            );
          })
        )}
      </div>
    </div>
  );
}
