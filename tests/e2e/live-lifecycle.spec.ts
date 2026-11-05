import { expect, test, type Page } from '@playwright/test';
import { API_BASE } from './helpers';

/**
 * Cold -> warm -> hot -> cold, seen from the browser. The API is stubbed and the
 * clock is simulated, so this needs only the web dev server, started with
 * VITE_USE_MOCKS=false and VITE_API_BASE_URL=http://127.0.0.1:8000.
 */

const NOW_S = Date.parse('2026-11-05T03:00:00Z') / 1000;
const BADGE = '.tp-status-sandbox-badge';
const META = { source: 'live', generatedAt: '2026-11-05T12:00:00+09:00', degraded: false, note: null };

interface Stub {
  lastIngestAt: number | null;
  requests: string[];
}

async function open(page: Page, lastIngestAt: number | null): Promise<Stub> {
  const stub: Stub = { lastIngestAt, requests: [] };
  await page.clock.install({ time: NOW_S * 1000 });
  await page.addInitScript(() => {
    const w = window as unknown as { __hidden: boolean };
    w.__hidden = false;
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (w.__hidden ? 'hidden' : 'visible'),
    });
  });
  await page.route(`${API_BASE}/**`, (route) => {
    const url = new URL(route.request().url());
    stub.requests.push(url.pathname + url.search);
    const json = (body: unknown) => route.fulfill({
      json: body,
      headers: { 'access-control-allow-origin': '*' },
    });
    if (url.pathname === '/tick') return json({ ran: false, lastIngestAt: stub.lastIngestAt });
    if (url.pathname === '/events.json') return json({ events: [], counts: {}, meta: META });
    if (url.pathname === '/layers.json') return json({ layers: [], meta: META });
    if (url.pathname === '/sandboxes.json') return json({ count: 0, sandboxes: [], meta: META });
    return route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' } });
  });
  await page.goto('/');
  return stub;
}

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    (window as unknown as { __hidden: boolean }).__hidden = h;
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

const hits = (stub: Stub, path: string) => stub.requests.filter((r) => r.startsWith(path));

test('cold start shows the stored data age, then goes live with versioned reads', async ({ page }) => {
  const stub = await open(page, NOW_S - 2 * 3600);
  await expect(page.locator(BADGE)).toHaveText('Refreshing: data from 2h ago');

  stub.lastIngestAt = NOW_S;
  stub.requests.length = 0;
  await page.clock.fastForward(16_000);
  await expect(page.locator(BADGE)).toContainText('Live: updated');
  for (const path of ['/events.json', '/layers.json', '/lines.geojson', '/brief']) {
    await expect.poll(() => hits(stub, path).some((r) => r.includes(`v=${NOW_S}`)), path).toBe(true);
  }
});

test('a hidden tab makes no requests and resumes at once when shown', async ({ page }) => {
  const stub = await open(page, NOW_S);
  await expect(page.locator(BADGE)).toContainText('Live');

  await setHidden(page, true);
  await expect(page.locator(BADGE)).toContainText('Paused');
  stub.requests.length = 0;
  await page.clock.fastForward(10 * 60_000);
  await page.waitForTimeout(300);
  expect(stub.requests).toEqual([]);

  await setHidden(page, false);
  await expect.poll(() => hits(stub, '/tick').length).toBeGreaterThan(0);
  await expect.poll(() => hits(stub, '/events.json').length).toBeGreaterThan(0);
});

test('a forgotten visible tab goes cold after 15 idle minutes and input wakes it', async ({ page }) => {
  const stub = await open(page, NOW_S);
  await expect(page.locator(BADGE)).toContainText('Live');

  await page.clock.fastForward(16 * 60_000);
  await expect(page.locator(BADGE)).toContainText('Paused');
  await page.waitForTimeout(300);
  stub.requests.length = 0;
  await page.clock.fastForward(10 * 60_000);
  await page.waitForTimeout(300);
  expect(stub.requests).toEqual([]);

  await page.mouse.move(200, 200);
  await page.mouse.move(220, 220);
  await expect(page.locator(BADGE)).not.toContainText('Paused');
  await expect.poll(() => hits(stub, '/tick').length).toBeGreaterThan(0);
});
