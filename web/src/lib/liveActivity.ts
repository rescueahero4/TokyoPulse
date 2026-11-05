import { useSyncExternalStore } from 'react';

// A page counts as an active viewer only while it is visible and recently used.
// Everything that polls goes through here, so a hidden or forgotten tab stops
// calling the API, and with no active viewers nothing runs at all.

const IDLE_MS = 15 * 60_000;
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];

const listeners = new Set<(live: boolean) => void>();
let lastInput = Date.now();

function compute(): boolean {
  return document.visibilityState === 'visible' && Date.now() - lastInput < IDLE_MS;
}

let live = compute();

function update(): void {
  const next = compute();
  if (next === live) return;
  live = next;
  listeners.forEach((l) => l(next));
}

function markInput(): void {
  lastInput = Date.now();
  update();
}

document.addEventListener('visibilitychange', () => {
  // Coming back to the tab is itself activity, however long it was hidden.
  if (document.visibilityState === 'visible') lastInput = Date.now();
  update();
});
for (const name of INPUT_EVENTS) {
  // Capture phase, because the map canvas handles its own pointer events.
  window.addEventListener(name, markInput, { capture: true, passive: true });
}
window.setInterval(update, 30_000);

export function isLive(): boolean {
  return live;
}

export function subscribeLive(listener: (live: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useLive(): boolean {
  return useSyncExternalStore(subscribeLive, isLive);
}

/** Run `fn` now and every `intervalMs` while live; on returning to live, run it straight away. */
export function whileLive(fn: () => void, intervalMs: number): () => void {
  let timer: number | null = null;
  const stop = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
  };
  const start = () => {
    stop();
    fn();
    timer = window.setInterval(fn, intervalMs);
  };
  if (live) start();
  const unsubscribe = subscribeLive((nowLive) => (nowLive ? start() : stop()));
  return () => {
    unsubscribe();
    stop();
  };
}
