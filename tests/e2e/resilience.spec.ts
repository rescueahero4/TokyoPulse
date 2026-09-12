import { test, expect } from '@playwright/test';
import { captureConsole, assertNoConsoleErrors, canvasColorVariance, waitForViewer } from './helpers';

/**
 * QA-E2E — the godseye "every layer fails independently" guarantee
 * (contracts/AGENT-BRIEF.md rule 3, PRD §10 risk table, PRD 1:50 rehearsal).
 */

test.describe('Resilience: layers fail independently', () => {
  test('13. Forced-offline: app still renders map + timeline from checked-in mocks when the API is fully unreachable', async ({ page }) => {
    test.setTimeout(45_000);
    const capture = captureConsole(page);

    await page.route('http://127.0.0.1:8000/**', (route) => route.abort());
    await page.goto('/');
    await waitForViewer(page);
    await page.waitForTimeout(3000);

    // No blank screen.
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    const stats = await canvasColorVariance(page);
    expect(stats.uniqueColors, `map blanked with API offline: ${JSON.stringify(stats)}`).toBeGreaterThan(3);

    // Timeline still populated, from mock fallback.
    const rows = page.locator('.tp-timeline-row');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });
    expect(await rows.count()).toBeGreaterThan(0);

    // Honest "cached" labelling somewhere (Timeline chip per ui-contract; LayerPanel
    // state chips also read MOCK/CACHED — either satisfies the "honest labelling" rule).
    const cachedSignal = page.locator('.tp-chip-cached, .tp-chip-state-mock, .tp-chip-state-cache');
    await expect(cachedSignal.first()).toBeVisible({ timeout: 10000 });

    // No panel crashed into the ErrorBoundary fallback.
    expect(await page.locator('.panel-error').count(), 'a panel crashed while offline').toBe(0);

    assertNoConsoleErrors(capture);
    await page.screenshot({ path: 'e2e/screenshots/04-forced-offline.png', fullPage: true });
  });

  test('14. Partial failure: only /brief and /forecast.json down - map, timeline, alert banner stay fine; dead panels degrade honestly', async ({ page }) => {
    test.setTimeout(45_000);
    const capture = captureConsole(page);

    await page.route('http://127.0.0.1:8000/brief**', (route) => route.abort());
    await page.route('http://127.0.0.1:8000/forecast.json**', (route) => route.abort());
    await page.goto('/');
    await waitForViewer(page);
    await page.waitForTimeout(3000);

    // Map unaffected.
    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    const stats = await canvasColorVariance(page);
    expect(stats.uniqueColors).toBeGreaterThan(3);

    // Timeline unaffected (different endpoint).
    const rows = page.locator('.tp-timeline-row');
    await expect(rows.first()).toBeVisible({ timeout: 15000 });

    // Alert banner unaffected (same /events.json query; live data currently has warnings).
    await expect(page.locator('.tp-alert-banner')).toBeVisible({ timeout: 15000 });

    // Neither dead panel crashed into the ErrorBoundary fallback...
    expect(await page.locator('.panel-error').count(), 'a panel crashed instead of degrading').toBe(0);

    // ...and each shows SOME content: either a real value served by its own
    // fallback rung (mock/brief.json, mock/forecast.json are both checked in,
    // so the api.ts ladder recovers automatically) or an honest empty state.
    const briefCard = page.locator('.tp-brief-card');
    await expect(briefCard).toBeVisible();
    const briefHasText = await briefCard.locator('.tp-brief-text').count();
    const briefHasEmpty = await briefCard.locator('.tp-empty-row').count();
    expect(briefHasText + briefHasEmpty, 'brief card is blank, neither content nor an empty state').toBeGreaterThan(0);

    const forecastPanel = page.locator('.tp-forecast-strip');
    await expect(forecastPanel).toBeVisible();
    const forecastHasSvg = await forecastPanel.locator('.tp-forecast-svg').count();
    const forecastHasEmpty = await forecastPanel.locator('.tp-empty-row').count();
    expect(forecastHasSvg + forecastHasEmpty, 'forecast strip is blank, neither content nor an empty state').toBeGreaterThan(0);

    assertNoConsoleErrors(capture);
  });

  for (const vp of [
    { width: 1280, height: 720, label: '1280x720' },
    { width: 1920, height: 1080, label: '1920x1080' },
  ]) {
    test(`15. Viewport ${vp.label}: no panel overflows off-screen, timeline stays visible`, async ({ page }) => {
      // Software-rendered Cesium in this sandbox is slow to settle (see test 7's
      // comment); a screenshot taken while it's still painting can stall well
      // past 45s without indicating any actual app problem.
      test.setTimeout(75_000);
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await waitForViewer(page);
      await page.waitForTimeout(2000);

      const timeline = page.locator('.tp-timeline');
      await expect(timeline).toBeVisible({ timeout: 15000 });

      const panelSelectors = [
        '.tp-status-bar',
        '.tp-alert-banner-wrap',
        '.tp-line-search',
        '.tp-layer-panel',
        '.tp-timeline',
        '.tp-brief-card',
        '.tp-forecast-strip',
      ];

      for (const sel of panelSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.count() === 0) continue; // optional panel (e.g. no alert today) - fine
        if (!(await loc.isVisible())) continue;
        const box = await loc.boundingBox();
        if (!box) continue;
        expect(box.x, `${sel} overflows left edge at ${vp.label}: x=${box.x}`).toBeGreaterThanOrEqual(-1);
        expect(box.y, `${sel} overflows top edge at ${vp.label}: y=${box.y}`).toBeGreaterThanOrEqual(-1);
        expect(
          box.x + box.width,
          `${sel} overflows right edge at ${vp.label}: right=${box.x + box.width}, viewport width=${vp.width}`,
        ).toBeLessThanOrEqual(vp.width + 1);
        expect(
          box.y + box.height,
          `${sel} overflows bottom edge at ${vp.label}: bottom=${box.y + box.height}, viewport height=${vp.height}`,
        ).toBeLessThanOrEqual(vp.height + 1);
      }

      await page.screenshot({ path: `e2e/screenshots/05-viewport-${vp.label}.png`, fullPage: false });
    });
  }
});
