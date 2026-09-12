import type { ConsoleMessage, Page } from '@playwright/test';

export const API_BASE = 'http://127.0.0.1:8000';
export const WEB_BASE = 'http://127.0.0.1:5173';

/**
 * Benign noise we explicitly allowlist (spec 2). Everything else that logs at
 * console.error level, or any uncaught pageerror, fails the run.
 *
 * - Cesium's own dev-build "Cesium Ion" resource/attribution warnings and its
 *   WebGL extension advisory notices are logged via console.log/info in this
 *   build, not console.error, so they do not need allowlisting here — this
 *   list exists for things that DO land on console.error but are not demo bugs.
 */
const ALLOWLIST_PATTERNS: RegExp[] = [
  // Cesium prints a one-time "WebGL rendering context 'experimental-webgl' was
  // given instead of 'webgl'" style advisory on some software-GL CI machines;
  // harmless, does not affect the rendered frame.
  /experimental-webgl/i,
  // React DevTools suggestion, present on every CRA/Vite React app in dev mode.
  /Download the React DevTools/i,
];

export interface ConsoleCapture {
  errors: string[];
  pageErrors: string[];
  all: { type: string; text: string }[];
}

/** Attach console + pageerror listeners. Call before navigation. */
export function captureConsole(page: Page): ConsoleCapture {
  const capture: ConsoleCapture = { errors: [], pageErrors: [], all: [] };
  page.on('console', (msg: ConsoleMessage) => {
    capture.all.push({ type: msg.type(), text: msg.text() });
    if (msg.type() === 'error') {
      const text = msg.text();
      if (!ALLOWLIST_PATTERNS.some((re) => re.test(text))) {
        capture.errors.push(text);
      }
    }
  });
  page.on('pageerror', (err) => {
    capture.pageErrors.push(err.message + (err.stack ? `\n${err.stack}` : ''));
  });
  return capture;
}

/** Fails (throws) if any non-allowlisted console error or pageerror fired. */
export function assertNoConsoleErrors(capture: ConsoleCapture) {
  const problems = [...capture.pageErrors, ...capture.errors];
  if (problems.length) {
    throw new Error(
      `Unexpected console/page errors (${problems.length}):\n` + problems.map((p, i) => `  [${i}] ${p}`).join('\n'),
    );
  }
}

/**
 * Samples pixels off the canvas via a temporary 2D copy (drawImage from the
 * WebGL canvas onto a 2D canvas, which Chromium allows same-origin) and
 * returns simple colour-variance stats. A blank/solid canvas (loading spinner
 * frozen, WebGL context lost, all-black globe) has ~0 variance.
 *
 * Cesium's WebGL context is created with `preserveDrawingBuffer: false`
 * (verified via getContextAttributes()), so the drawing buffer's contents
 * are only guaranteed valid for the JS turn right after a draw. We force a
 * render via `viewer.scene.requestRender()` and wait two rAF ticks before
 * sampling — reading "whenever the test happens to call this" without that
 * nudge reliably samples a cleared/undefined buffer and reports a false
 * "blank canvas", which is exactly the failure mode this check exists to
 * catch for real, so it must not misfire on its own.
 */
export async function canvasColorVariance(page: Page, selector = 'canvas'): Promise<{
  width: number;
  height: number;
  uniqueColors: number;
  variance: number;
}> {
  return page.evaluate((sel) => {
    return new Promise((resolve) => {
      const finish = () => {
        const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
        if (!canvas) return resolve({ width: 0, height: 0, uniqueColors: 0, variance: 0 });
        const w = canvas.width;
        const h = canvas.height;
        if (!w || !h) return resolve({ width: w, height: h, uniqueColors: 0, variance: 0 });
        const copy = document.createElement('canvas');
        // Downsample for speed; 128x128 grid is plenty to detect a blank frame.
        const sw = Math.min(128, w);
        const sh = Math.min(128, h);
        copy.width = sw;
        copy.height = sh;
        const ctx = copy.getContext('2d');
        if (!ctx) return resolve({ width: w, height: h, uniqueColors: 0, variance: 0 });
        ctx.drawImage(canvas, 0, 0, w, h, 0, 0, sw, sh);
        let data: Uint8ClampedArray;
        try {
          data = ctx.getImageData(0, 0, sw, sh).data;
        } catch {
          // Tainted/cross-origin canvas read failure -> treat as no signal.
          return resolve({ width: w, height: h, uniqueColors: 0, variance: 0 });
        }
        const colors = new Set<string>();
        let sum = 0;
        let sumSq = 0;
        let n = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          colors.add(`${r},${g},${b}`);
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          sum += lum;
          sumSq += lum * lum;
          n++;
        }
        const mean = sum / n;
        const variance = sumSq / n - mean * mean;
        resolve({ width: w, height: h, uniqueColors: colors.size, variance });
      };

      const viewer = (window as unknown as { __tpViewer?: { scene: { requestRender(): void } } }).__tpViewer;
      try {
        viewer?.scene.requestRender();
      } catch {
        /* ignore */
      }
      requestAnimationFrame(() => requestAnimationFrame(finish));
    });
  }, selector);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads the Cesium camera's cartographic position via the QA probe handle A1a exposed on window.__tpViewer. */
export async function getCameraPosition(page: Page): Promise<{ lat: number; lon: number; height: number } | null> {
  return page.evaluate(() => {
    const w = window as unknown as { __tpViewer?: any };
    const viewer = w.__tpViewer;
    if (!viewer) return null;
    const c = viewer.camera.positionCartographic;
    const toDeg = (rad: number) => (rad * 180) / Math.PI;
    return { lat: toDeg(c.latitude), lon: toDeg(c.longitude), height: c.height };
  });
}

export async function waitForViewer(page: Page, timeoutMs = 20000) {
  await page.waitForFunction(() => !!(window as unknown as { __tpViewer?: unknown }).__tpViewer, null, {
    timeout: timeoutMs,
  });
}
