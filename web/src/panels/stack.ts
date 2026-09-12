// Bottom-left stack geometry, resolved in pixels.
//
// The corner is shared, bottom -> up:
//     API LIVE chip (34px)  ->  A6's MAP cluster  ->  LayerPanel (ours)
// and both upper elements change height when collapsed, so nothing may use a
// fixed offset. A6 publishes its live height as `--tp-map-cluster-h` on <html>.
//
// WHY THIS MODULE EXISTS instead of plain `bottom: calc(... var(...) ...)`:
// measured in this build, a `bottom` (or `max-height`) that references an
// inherited custom property does NOT re-resolve when that property is later
// changed via an inline style on <html>. The declaration keeps the value it had
// when the rule was applied. Observed directly: with the cluster at 125px the
// chip still sat at the 40px offset and landed ON TOP of the cluster, and
// setting the property to 200px moved nothing. The CSS rules are kept as a
// first-paint fallback; these numbers are then applied as inline styles, which
// always take effect.
//
// Consumers: LayerPanel (its own `bottom`) and LinePanel (its `max-height`, so
// the left column never grows down into the stack).

type Listener = () => void;

export const API_CHIP_H = 34;
export const GAP = 8;
/** Breathing room between the top of the stack and the left column above it. */
export const COLUMN_GAP = 12;
/** Where the left column starts (below the StatusBar). */
export const COLUMN_TOP = 52;

const CLUSTER_FALLBACK = 120;
/** Never let the column shrink below this; also the reserve the LayerPanel leaves it. */
export const MIN_COLUMN = 100;
const LAYERS_FALLBACK = 44;

const listeners = new Set<Listener>();
let layersHeight = LAYERS_FALLBACK;
let observer: MutationObserver | null = null;

/** A6's cluster height, read live from the CSS custom property they publish. */
function clusterHeight(): number {
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--tp-map-cluster-h')
      .trim();
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : CLUSTER_FALLBACK;
  } catch {
    return CLUSTER_FALLBACK;
  }
}

/** Distance from the viewport bottom to the underside of the LayerPanel. */
export function layersBottomPx(): number {
  return API_CHIP_H + clusterHeight() + GAP;
}

/** Vertical space the bottom-left stack needs, including the LayerPanel itself. */
export function stackReservePx(): number {
  return layersBottomPx() + layersHeight + COLUMN_GAP;
}

/** Max height available to the top-left column before it would reach the stack. */
export function leftColumnMaxPx(): number {
  const h = typeof window === 'undefined' ? 800 : window.innerHeight;
  // The floor must stay SMALL: it wins over the computed value, so a generous
  // floor is exactly how the column would end up overlapping the stack on a
  // short viewport. 100px still shows the header + search box, and the detail
  // below them scrolls.
  return Math.max(MIN_COLUMN, Math.round(h - COLUMN_TOP - stackReservePx()));
}

/** Max height the expanded LayerPanel may take without squeezing the column above it. */
export function layersMaxHeightPx(): number {
  const h = typeof window === 'undefined' ? 800 : window.innerHeight;
  const room = h - layersBottomPx() - COLUMN_TOP - MIN_COLUMN - COLUMN_GAP;
  return Math.max(120, Math.min(340, Math.round(room)));
}

export function setLayersHeight(h: number): void {
  if (!Number.isFinite(h) || h <= 0) return;
  if (Math.abs(h - layersHeight) < 1) return;
  layersHeight = h;
  notify();
}

function notify(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      /* a broken listener must never take the HUD down */
    }
  }
}

function ensureWatchers(): void {
  if (observer || typeof MutationObserver === 'undefined') return;
  // A6 writes --tp-map-cluster-h as an inline style on <html>; this fires the
  // moment they do, so our geometry follows their collapse/expand exactly.
  observer = new MutationObserver(notify);
  try {
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  } catch {
    observer = null;
  }
  try {
    window.addEventListener('resize', notify);
  } catch {
    /* ignore */
  }
}

/** Subscribe to stack geometry changes. Returns an unsubscribe function. */
export function subscribeStack(cb: Listener): () => void {
  ensureWatchers();
  listeners.add(cb);
  // A6 may have published --tp-map-cluster-h BEFORE we subscribed (nothing
  // orders the two mounts), in which case no mutation is coming and a
  // first-paint read would keep the fallback. Re-read on the next frame and
  // once more after the map has settled.
  try {
    requestAnimationFrame(() => cb());
    window.setTimeout(() => cb(), 1000);
  } catch {
    /* ignore */
  }
  return () => {
    listeners.delete(cb);
  };
}
