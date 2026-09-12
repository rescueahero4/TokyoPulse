// LayerPanel — godseye toggle switches (not checkboxes), a per-layer ⓘ that
// explains what the data IS and where it came from, the station-name sub-toggle,
// and a collapsed state that docks as a narrow vertical rail against the left
// edge of the viewport.
//
// The ⓘ copy comes from panels/dataSources.ts, the same module the
// InspectorPanel SOURCE footers read, so the two can never drift apart.
//
// FROZEN RULE: a layer with state === 'off' renders DISABLED AND GREYED,
// never hidden. Every row is always present.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayerState } from '../lib/types';
import { formatClock } from './time';
import { PanelHeader } from './PanelHeader';
import { useCollapse } from './useCollapse';
import { LAYER_INFO } from './dataSources';
import { layersBottomPx, layersMaxHeightPx, setLayersHeight, subscribeStack } from './stack';

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
  /** Station name labels on the map. Optional so the frozen 3-prop call still type-checks. */
  showStationLabels?: boolean;
  onToggleStationLabels?(): void;
}): JSX.Element {
  const layers = p.layers ?? [];
  // Bumped key ('layers' -> 'layers.v2') because the DEFAULT flipped to collapsed:
  // a presenter with a stored `false` from the old default would otherwise still
  // get it expanded on load, which is exactly what was asked to change.
  const [collapsed, toggleCollapsed] = useCollapse('layers.v2', true);
  const [openInfo, setOpenInfo] = useState<string | null>(null);

  // The bottom-left corner is a shared stack (API chip -> A6's MAP cluster ->
  // this panel), and every element in it changes height when collapsed. A6
  // publishes --tp-map-cluster-h; this publishes --tp-layers-h the same way, so
  // the left column above can reserve exactly the right amount and nothing
  // drifts on top of anything else.
  const observerRef = useRef<ResizeObserver | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const publishHeight = useCallback((el: HTMLElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    unsubRef.current?.();
    unsubRef.current = null;
    if (!el) return;

    // Our own bottom offset, applied INLINE — see panels/stack.ts for why the
    // CSS `bottom: calc(... var(--tp-map-cluster-h) ...)` cannot be trusted to
    // re-resolve when A6's cluster changes height.
    const place = () => {
      try {
        el.style.bottom = `${layersBottomPx()}px`;
        // Expanded, this panel must never grow so tall that the column above it
        // has nowhere left to go.
        el.style.maxHeight = el.classList.contains('tp-layer-chip') ? '' : `${layersMaxHeightPx()}px`;
      } catch {
        /* CSS fallback stands */
      }
    };
    place();
    unsubRef.current = subscribeStack(place);

    if (typeof ResizeObserver === 'undefined') return;
    const publish = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      setLayersHeight(h);
      try {
        document.documentElement.style.setProperty('--tp-layers-h', `${h}px`);
      } catch {
        /* non-fatal */
      }
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    observerRef.current = ro;
  }, []);

  useEffect(() => () => {
    observerRef.current?.disconnect();
    unsubRef.current?.();
  }, []);

  const activeCount = layers.reduce(
    (acc, l) => acc + (l.state !== 'off' && p.visible?.[l.id] ? 1 : 0),
    0,
  );

  // Collapsed (the default): a compact chip docked in the bottom-left stack,
  // shaped like the MAP cluster it sits above rather than the old vertical rail,
  // which read as misaligned once this moved out of the top-left column.
  if (collapsed) {
    return (
      <button
        ref={publishHeight}
        type="button"
        className="tp-panel tp-layer-chip"
        onClick={toggleCollapsed}
        aria-expanded={false}
        aria-label="Expand layers panel"
        title={`Layers — ${activeCount}/${layers.length} on`}
      >
        <span className="tp-layer-chip-icon" aria-hidden="true">
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" d="M10 3l7 3.5-7 3.5-7-3.5L10 3z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" d="M3 10.5L10 14l7-3.5" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" d="M3 14.5L10 18l7-3.5" />
          </svg>
        </span>
        <span className="tp-layer-chip-text">Layers</span>
        <span className="tp-layer-chip-count">{activeCount}/{layers.length}</span>
        <span className="tp-layer-chip-cta" aria-hidden="true">▴</span>
      </button>
    );
  }

  return (
    <div className="tp-panel tp-layer-panel" ref={publishHeight}>
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
            const info = LAYER_INFO[layer.id];
            const infoOpen = openInfo === layer.id;
            const showLabelRow = layer.id === 'crowd' && typeof p.onToggleStationLabels === 'function';
            const labelsOn = p.showStationLabels !== false;
            return (
              <div key={layer.id} className="tp-layer-block">
                <div className={`tp-layer-row${isOff ? ' tp-layer-off' : ''}`}>
                  <span className="tp-layer-main">
                    <span className="tp-layer-name-row">
                      <span className="tp-layer-label">{layer.label}</span>
                      {info ? (
                        <button
                          type="button"
                          className={`tp-layer-info-btn${infoOpen ? ' tp-layer-info-btn-open' : ''}`}
                          aria-expanded={infoOpen}
                          aria-label={`About the ${layer.label} layer and its data source`}
                          title="What is this data?"
                          onClick={() => setOpenInfo(infoOpen ? null : layer.id)}
                        >
                          i
                        </button>
                      ) : null}
                    </span>
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

                {infoOpen && info ? (
                  <div className="tp-layer-info" role="note">
                    <p className="tp-layer-info-what">{info.what}</p>
                    <p className="tp-layer-info-source">
                      <span className="tp-layer-info-key">Source</span> {info.source}
                    </p>
                    {info.caveat ? <p className="tp-layer-info-caveat">{info.caveat}</p> : null}
                    {info.url ? (
                      <a
                        className="tp-layer-info-link"
                        href={info.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {info.urlLabel ?? 'Open the source'} →
                      </a>
                    ) : null}
                  </div>
                ) : null}

                {/* Station names ride on the crowd markers: no markers, no labels. */}
                {showLabelRow ? (
                  <div className={`tp-layer-subrow${!on ? ' tp-layer-off' : ''}`}>
                    <span className="tp-layer-sublabel">Station names</span>
                    <button
                      type="button"
                      className={`tp-toggle-switch tp-toggle-switch-sm${labelsOn && on ? ' tp-toggle-on' : ''}`}
                      role="switch"
                      aria-checked={labelsOn && on}
                      aria-label="Station name labels"
                      disabled={!on}
                      title={on ? `Station names: ${labelsOn ? 'on' : 'off'}` : 'Turn on Station crowding first'}
                      onClick={() => { if (on) p.onToggleStationLabels?.(); }}
                    />
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
