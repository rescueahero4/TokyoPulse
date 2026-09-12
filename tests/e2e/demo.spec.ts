import { test, expect } from '@playwright/test';
import {
  API_BASE,
  captureConsole,
  assertNoConsoleErrors,
  canvasColorVariance,
  getCameraPosition,
  waitForViewer,
} from './helpers';

/**
 * QA-E2E — one spec per demo beat, PRD §9.
 * Assumes A1a (http://localhost:5173) and A3 (http://localhost:8000) are both
 * already running; this suite never starts either (contracts/AGENT-BRIEF.md).
 *
 * A few tests override the 30s project default via test.setTimeout() because
 * they chain a viewer-ready wait with a second, independent wait (camera
 * flyTo settle, 15s UI poll interval, etc.) and 30s was cutting it close on a
 * cold first load. Documented here rather than silently raised in the config.
 */

test.describe('TokyoPulse demo script (PRD §9)', () => {
  test('1. Map renders: Cesium canvas present, sized, and not blank', async ({ page }) => {
    test.setTimeout(45_000);
    const capture = captureConsole(page);
    await page.goto('/');
    await waitForViewer(page);

    const host = page.locator('[data-testid="cesium-host"]');
    await expect(host).toBeVisible();

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(0);
    expect(box?.height ?? 0).toBeGreaterThan(0);

    // Let base imagery + first layer paint settle before sampling pixels.
    await page.waitForTimeout(3000);
    const stats = await canvasColorVariance(page);
    expect(stats.width, 'canvas has zero backing-store width').toBeGreaterThan(0);
    expect(stats.height, 'canvas has zero backing-store height').toBeGreaterThan(0);
    expect(stats.uniqueColors, `canvas looks blank/solid: ${JSON.stringify(stats)}`).toBeGreaterThan(3);
    expect(stats.variance, `canvas has near-zero colour variance (blank globe?): ${JSON.stringify(stats)}`).toBeGreaterThan(5);

    expect(capture.pageErrors, capture.pageErrors.join('\n')).toHaveLength(0);
    await page.screenshot({ path: 'e2e/screenshots/01-initial-map.png', fullPage: true });
  });

  test('2. No console errors across a full interaction pass', async ({ page }) => {
    test.setTimeout(45_000);
    const capture = captureConsole(page);
    await page.goto('/');
    await waitForViewer(page);
    await page.waitForTimeout(1500);

    // line search
    const searchInput = page.locator('.tp-line-search-input');
    await searchInput.click();
    await searchInput.fill('Mita');
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape');
    await searchInput.blur();

    // time + language toggles
    await page.getByRole('button', { name: '7d' }).click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'Now' }).click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'JA' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'EN' }).click();
    await page.waitForTimeout(300);

    // one layer toggle off/on
    const firstCheckbox = page.locator('.tp-layer-row input[type="checkbox"]:not([disabled])').first();
    if (await firstCheckbox.count()) {
      await firstCheckbox.click();
      await page.waitForTimeout(200);
      await firstCheckbox.click();
      await page.waitForTimeout(200);
    }

    assertNoConsoleErrors(capture);
  });

  test('3. Timeline populates, newest first', async ({ page, request }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);

    const rows = page.locator('.tp-timeline-row');
    await expect(rows.first()).toBeVisible({ timeout: 20000 });
    expect(await rows.count()).toBeGreaterThan(0);

    const apiRes = await request.get(`${API_BASE}/events.json?window=now&limit=60`).catch(() => null);
    if (apiRes && apiRes.ok()) {
      const body = await apiRes.json();
      const events: { time: string; title: string }[] = body.events ?? [];
      expect(events.length, '/events.json returned zero events').toBeGreaterThan(0);

      const times = events.map((e) => new Date(e.time).getTime());
      const isDesc = times.every((t, i) => i === 0 || t <= times[i - 1]);
      expect(isDesc, '/events.json is not sorted time DESC as the contract requires').toBeTruthy();

      const firstRowTitle = (await rows.first().locator('.tp-timeline-title').textContent())?.trim();
      expect(firstRowTitle, 'top timeline row does not match the newest event from /events.json').toBe(events[0].title.trim());
    }
  });

  test('4. Alert banner renders for a severity >= warning event', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);

    const banner = page.locator('.tp-alert-banner');
    await expect(banner).toBeVisible({ timeout: 20000 });
    const text = (await banner.textContent())?.trim() ?? '';
    expect(text.length).toBeGreaterThan(0);
    const hasSeverityTag = /WARNING|CRITICAL/.test(text);
    expect(hasSeverityTag, `alert banner text did not show a WARNING/CRITICAL tag: "${text}"`).toBeTruthy();
  });

  test('5. Timeline click flies the camera to the event location (demo beat 2)', async ({ page, request }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);

    const before = await getCameraPosition(page);
    expect(before, 'could not read camera position via window.__tpViewer').not.toBeNull();

    const apiRes = await request.get(`${API_BASE}/events.json?window=now&limit=60`);
    expect(apiRes.ok()).toBeTruthy();
    const body = await apiRes.json();
    const candidate = (body.events ?? []).find((e: { lat: number | null; lon: number | null }) => e.lat != null && e.lon != null);
    expect(candidate, 'no event with a non-null lat/lon found in /events.json').toBeTruthy();

    const row = page.locator('.tp-timeline-row', { hasText: candidate.title });
    await expect(row.first()).toBeVisible({ timeout: 20000 });
    await row.first().click();

    // flyTo animates over 1.4s (CesiumViewer.tsx); give it margin to settle.
    await page.waitForTimeout(2500);
    const after = await getCameraPosition(page);
    expect(after, 'camera position unreadable after click').not.toBeNull();

    const moved =
      Math.abs(after!.lat - before!.lat) > 0.0005 ||
      Math.abs(after!.lon - before!.lon) > 0.0005 ||
      Math.abs(after!.height - before!.height) > 50;
    expect(moved, `camera did not move: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`).toBeTruthy();
  });

  test('6. Line search "Mita" -> pick result -> impact panel with ward + station count (demo beat 3)', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);

    const input = page.locator('.tp-line-search-input');
    await input.click();
    await input.fill('Mita');

    const result = page.locator('.tp-line-search-result', { hasText: 'Mita' });
    await expect(result.first()).toBeVisible({ timeout: 15000 });
    await result.first().click();

    const impact = page.locator('.tp-impact-panel');
    await expect(impact).toBeVisible({ timeout: 20000 });

    const wardRows = impact.locator('.tp-impact-ward-row');
    await expect(wardRows.first()).toBeVisible({ timeout: 10000 });
    expect(await wardRows.count()).toBeGreaterThan(0);

    const firstWardText = (await wardRows.first().textContent()) ?? '';
    expect(firstWardText, 'ward row does not show a station count').toMatch(/stations?/i);

    await page.screenshot({ path: 'e2e/screenshots/02-line-search-impact.png', fullPage: true });
  });

  test('7. Layer toggles: each checkbox flips off/on without throwing', async ({ page }) => {
    test.setTimeout(45_000);
    const capture = captureConsole(page);
    await page.goto('/');
    await waitForViewer(page);
    await page.waitForTimeout(1000);

    const checkboxes = page.locator('.tp-layer-row input[type="checkbox"]');
    const n = await checkboxes.count();
    expect(n, 'LayerPanel rendered zero checkboxes').toBeGreaterThan(0);

    for (let i = 0; i < n; i++) {
      const cb = checkboxes.nth(i);
      if (await cb.isDisabled()) continue; // "off" layers render disabled by design (ui-contract rule)
      await cb.click();
      await page.waitForTimeout(200);
      await cb.click();
      await page.waitForTimeout(200);
    }

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    const stats = await canvasColorVariance(page);
    expect(stats.uniqueColors, `canvas blanked after layer toggling: ${JSON.stringify(stats)}`).toBeGreaterThan(3);

    assertNoConsoleErrors(capture);
  });

  test('8. Time toggle: 7d changes the timeline content (demo beat 4)', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);
    await expect(page.locator('.tp-timeline-row').first()).toBeVisible({ timeout: 20000 });

    const beforeCount = await page.locator('.tp-timeline-row').count();
    const beforeFirstTitle = await page.locator('.tp-timeline-title').first().textContent();

    await page.getByRole('button', { name: '7d' }).click();
    await page.waitForTimeout(2500);
    await expect(page.locator('.tp-timeline-row').first()).toBeVisible({ timeout: 20000 });

    const afterCount = await page.locator('.tp-timeline-row').count();
    const afterFirstTitle = await page.locator('.tp-timeline-title').first().textContent();

    const changed = afterCount !== beforeCount || afterFirstTitle !== beforeFirstTitle;
    expect(
      changed,
      `7d toggle had no visible effect: before=${beforeCount}/"${beforeFirstTitle}" after=${afterCount}/"${afterFirstTitle}"`,
    ).toBeTruthy();

    await page.screenshot({ path: 'e2e/screenshots/03-7d-view.png', fullPage: true });
  });

  test('9. Forecast strip renders a populated SVG (demo beat 4)', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);

    const svg = page.locator('.tp-forecast-svg');
    await expect(svg).toBeVisible({ timeout: 20000 });
    const childCount = await svg.locator(':scope > *').count();
    expect(childCount, `forecast SVG only has ${childCount} children - looks empty`).toBeGreaterThan(5);
  });

  test('10. Brief card shows non-empty text and a provider label (demo beat 5)', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);

    const brief = page.locator('.tp-brief-card');
    await expect(brief).toBeVisible();

    const text = brief.locator('.tp-brief-text');
    await expect(text).toBeVisible({ timeout: 20000 });
    const textContent = (await text.textContent())?.trim() ?? '';
    expect(textContent.length).toBeGreaterThan(0);

    const provider = brief.locator('.tp-brief-provider');
    await expect(provider).toBeVisible();
    const providerText = (await provider.textContent())?.trim() ?? '';
    expect(providerText.length).toBeGreaterThan(0);
  });

  test('11. Sandbox badge shows a count and mentions Daytona', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);

    const badge = page.locator('.tp-status-sandbox-badge');
    await expect(badge).toBeVisible({ timeout: 20000 });
    const text = (await badge.textContent()) ?? '';
    expect(text, 'sandbox badge does not mention Daytona').toMatch(/Daytona/i);
    expect(text, 'sandbox badge does not show a number').toMatch(/\d+/);
  });

  test('12. POST /demo/replay injects a REPLAY event at the top of the timeline (single most important test)', async ({ page, request }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);
    await expect(page.locator('.tp-timeline-row').first()).toBeVisible({ timeout: 20000 });

    const res = await request.post(`${API_BASE}/demo/replay`, { data: { scenario: 'quake' } });
    expect(res.ok(), `POST /demo/replay failed: ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();
    const body = await res.json();
    expect(body.injected, 'replay response reported zero injected events').toBeGreaterThan(0);

    // UI polls /events.json every 15s; allow margin for the poll + a render pass.
    await expect(
      page.locator('.tp-timeline-row').first().locator('.tp-chip-replay'),
    ).toBeVisible({ timeout: 20000 });
  });
});
