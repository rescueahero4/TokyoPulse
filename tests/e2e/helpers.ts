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

/**
 * Chromium logs a *generic*, URL-less "Failed to load resource: the server
 * responded with a status of NNN" console error for every failed HTTP
 * request, so we can't tell from the message text alone whether a given
 * occurrence is one of the two confirmed-benign sources below or a real
 * broken asset. We instead count matching network-level failures via
 * page.on('response')/'requestfailed' and only forgive that many generic
 * messages - anything beyond that budget still fails the run.
 *
 * Confirmed via a standalone debug run (see QA-E2E final report) - not
 * guessed:
 *   1. GET /mock/peopleflow.json and /fallback/peopleflow.json - 404 by
 *      design. web/src/lib/api.ts's probePeopleFlow() deliberately probes
 *      both paths and treats "not found" as "layer unavailable"; there is no
 *      peopleflow data file in this build (contracts/AGENT-BRIEF.md: "we do
 *      not claim live-ness we do not have").
 *   2. GET https://disaportaldata.gsi.go.jp/raster/.../{z}/{x}/{y}.png (flood
 *      hazard overlay) and https://cyberjapandata.gsi.go.jp/xyz/.../{z}/{x}/{y}.png
 *      (std/pale basemap tiles) at low zoom (z=0,1) - GSI's tile servers are
 *      Japan-only, higher-zoom-only rasters with no whole-world overview
 *      tiles. Cesium's imagery LOD pyramid requests low-zoom tiles first;
 *      they 404, the tile is just left transparent, and real coverage
 *      appears once zoomed to city level. Harmless, and confirmed for two
 *      independent GSI tile sets (flood + pale basemap) via standalone debug
 *      runs, not guessed.
 */
// Two distinct generic, URL-less console.error shapes Chromium emits for a
// failed request: a real HTTP error status, and a request that never got a
// response at all (aborted, DNS failure, etc - what page.route(...).abort()
// itself produces in tests 13/14, which is our own deliberate fault
// injection, not an app bug).
const GENERIC_HTTP_FAIL_RE = /^Failed to load resource: the server responded with a status of \d+/;
const GENERIC_NET_FAIL_RE = /^Failed to load resource: net::/;
const BENIGN_NETWORK_URL_PATTERNS: RegExp[] = [
  /\/mock\/peopleflow\.json(\?|$)/,
  /\/fallback\/peopleflow\.json(\?|$)/,
  /disaportaldata\.gsi\.go\.jp\/raster\//,
  /cyberjapandata\.gsi\.go\.jp\/xyz\//,
];

export interface ConsoleCapture {
  errors: string[];
  pageErrors: string[];
  all: { type: string; text: string }[];
  /** Count of >=400 responses / failed requests matched against the benign patterns for this capture. */
  benignNetworkFailures: number;
  /** Every >=400 response / failed request URL seen, for debugging a real failure. */
  networkFailures: string[];
}

/**
 * Attach console + pageerror + network-failure listeners. Call before navigation.
 *
 * @param extraBenignUrlPatterns Additional URL patterns to treat as expected
 *   network failures for THIS test only - use this for a test's own
 *   deliberate fault injection (e.g. resilience.spec.ts aborting
 *   http://localhost:8000/** on purpose), never to paper over a real one.
 */
export function captureConsole(page: Page, extraBenignUrlPatterns: RegExp[] = []): ConsoleCapture {
  const capture: ConsoleCapture = { errors: [], pageErrors: [], all: [], benignNetworkFailures: 0, networkFailures: [] };
  const benignPatterns = [...BENIGN_NETWORK_URL_PATTERNS, ...extraBenignUrlPatterns];
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
  const noteNetworkFailure = (url: string) => {
    capture.networkFailures.push(url);
    if (benignPatterns.some((re) => re.test(url))) capture.benignNetworkFailures += 1;
  };
  page.on('response', (res) => {
    if (res.status() >= 400) noteNetworkFailure(res.url());
  });
  page.on('requestfailed', (req) => {
    noteNetworkFailure(req.url());
  });
  return capture;
}

/**
 * Fails (throws) if any non-allowlisted console error or pageerror fired.
 * Generic "Failed to load resource" errors (HTTP-status or net::ERR_* shaped)
 * are forgiven up to the number of confirmed-benign network failures observed
 * (see BENIGN_NETWORK_URL_PATTERNS / captureConsole's extraBenignUrlPatterns) -
 * any beyond that budget, or any other error, still fails.
 */
export function assertNoConsoleErrors(capture: ConsoleCapture) {
  let genericBudget = capture.benignNetworkFailures;
  const problems: string[] = [...capture.pageErrors];
  for (const e of capture.errors) {
    if ((GENERIC_HTTP_FAIL_RE.test(e) || GENERIC_NET_FAIL_RE.test(e)) && genericBudget > 0) {
      genericBudget -= 1;
      continue;
    }
    problems.push(e);
  }
  if (problems.length) {
    throw new Error(
      `Unexpected console/page errors (${problems.length}):\n${problems.map((p, i) => `  [${i}] ${p}`).join('\n')}\n` +
        `(network failures seen: ${capture.networkFailures.join(', ') || 'none'})`,
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
