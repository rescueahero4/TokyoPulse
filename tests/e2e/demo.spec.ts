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
 * Assumes A1a (http://localhost:5173) and A3 (http://127.0.0.1:8000) are both
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
    test.setTimeout(60_000);
    const capture = captureConsole(page);
    await page.goto('/');
    await waitForViewer(page);
    await page.waitForTimeout(1500);

    // line search
    const searchInput = page.locator('.tp-line-search-input');
    await searchInput.click();
    await searchInput.fill('Mita');
    await page.waitForTimeout(300);
    // Close the results dropdown (LineSearch.tsx closes on onBlur). A DOM
    // .blur() fires that handler directly and reliably, unlike clicking
    // elsewhere on the HUD - the top-left corner is covered by StatusBar
    // (ui-contract: "StatusBar very top-left corner strip"), so a synthetic
    // click there is exactly the overlap this suite exists to catch, not a
    // valid way to dismiss a dropdown.
    await searchInput.evaluate((el: HTMLElement) => el.blur());
    await page.waitForTimeout(200);

    // time + language toggles
    await page.locator('.tp-status-toggles').getByRole('button', { name: '7d', exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator('.tp-status-toggles').getByRole('button', { name: 'Now', exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator('.tp-status-toggles').getByRole('button', { name: 'JA', exact: true }).click();
    await page.waitForTimeout(300);
    await page.locator('.tp-status-toggles').getByRole('button', { name: 'EN', exact: true }).click();
    await page.waitForTimeout(300);

    // one layer toggle off/on
    const firstCheckbox = page.locator('.tp-layer-row .tp-toggle-switch:not([disabled])').first();
    if (await firstCheckbox.count()) {
      await firstCheckbox.scrollIntoViewIfNeeded();
      await firstCheckbox.click({ timeout: 20_000 });
      await firstCheckbox.click({ timeout: 20_000 });
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

    // /events.json itself must be sorted time DESC (the contract's promise;
    // Timeline, AlertBanner and BriefCard all key off this one ordering).
    const apiRes = await request.get(`${API_BASE}/events.json?window=now&limit=60`).catch(() => null);
    if (apiRes && apiRes.ok()) {
      const body = await apiRes.json();
      const events: { time: string; title: string }[] = body.events ?? [];
      expect(events.length, '/events.json returned zero events').toBeGreaterThan(0);

      const times = events.map((e) => new Date(e.time).getTime());
      const isDesc = times.every((t, i) => i === 0 || t <= times[i - 1]);
      expect(isDesc, '/events.json is not sorted time DESC as the contract requires').toBeTruthy();
    }

    // The UI splits into an "Upcoming" section (future-dated rows) and a
    // "NOW" section, and collapses runs of normal-operation train rows into
    // a group. That's a legitimate presentation choice on top of the DESC
    // feed, so assert newest-first on each section's plain (ungrouped) rows,
    // which is what "newest first" means for a person actually reading it.
    //
    // Compare via the "Xm/Xh/Xd ago" relative text (time.ts's
    // formatRelative), not the bare "HH:MM" clock - a 7d/history view
    // legitimately spans multiple days, where e.g. "20:42" from yesterday is
    // OLDER than "14:57" from today despite sorting later by clock digits
    // alone; only the relative "ago" figure is monotonic with real time.
    const nowRows = page.locator('.tp-timeline-row:not(.tp-timeline-row-upcoming):not(.tp-timeline-row-group)');
    const nowCount = await nowRows.count();
    const minutesAgo: number[] = [];
    for (let i = 0; i < nowCount; i++) {
      const text = (await nowRows.nth(i).locator('.tp-timeline-time').textContent()) ?? '';
      if (/just now/i.test(text)) {
        minutesAgo.push(0);
        continue;
      }
      const m = text.match(/(\d+)\s*(m|h|d)\s*ago/i);
      if (!m) continue; // e.g. "in 5m" (future) shouldn't appear in the NOW section at all
      const n = Number(m[1]);
      const unit = m[2].toLowerCase();
      const mins = unit === 'm' ? n : unit === 'h' ? n * 60 : n * 1440;
      minutesAgo.push(mins);
    }
    expect(minutesAgo.length, 'no parsable "...ago" timestamps found in the NOW section').toBeGreaterThan(0);
    for (let i = 1; i < minutesAgo.length; i++) {
      expect(
        minutesAgo[i],
        `NOW section row ${i} (${minutesAgo[i]}m ago) is newer than row ${i - 1} (${minutesAgo[i - 1]}m ago) - timeline is not newest-first`,
      ).toBeGreaterThanOrEqual(minutesAgo[i - 1]);
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
    // Avoid a candidate that Timeline.tsx would collapse into a "N lines:
    // normal operation" group row (type=train && severity=info) - those
    // don't render their own title text unless the group is expanded.
    const candidate = (body.events ?? []).find(
      (e: { lat: number | null; lon: number | null; type: string; severity: string }) =>
        e.lat != null && e.lon != null && !(e.type === 'train' && e.severity === 'info'),
    );
    expect(candidate, 'no non-grouped event with a non-null lat/lon found in /events.json').toBeTruthy();

    const row = page.locator('.tp-timeline-row', { hasText: candidate.title });
    await expect(row.first()).toBeVisible({ timeout: 20000 });
    await row.first().click();

    // flyTo animates over 1.4s (CesiumViewer.tsx). Poll instead of a single
    // fixed-delay read: events.json polls every 15s and can re-render the row
    // list at an unlucky moment right around a click, occasionally swallowing
    // it - one observed instance of the camera staying at the exact HOME
    // value (not "still animating", literally never started) confirmed this
    // is a click-timing race, not a flyTo bug. Retry the click once if
    // nothing moved after a few seconds, then keep polling - the >moved
    // threshold itself is unchanged either way.
    const hasMoved = (a: { lat: number; lon: number; height: number }) =>
      Math.abs(a.lat - before!.lat) > 0.0005 ||
      Math.abs(a.lon - before!.lon) > 0.0005 ||
      Math.abs(a.height - before!.height) > 50;

    let after = await getCameraPosition(page);
    let retried = false;
    await expect
      .poll(
        async () => {
          after = await getCameraPosition(page);
          if (!after) return 'unreadable';
          if (hasMoved(after)) return 'moved';
          if (!retried) {
            retried = true;
            await row.first().click().catch(() => undefined);
          }
          return 'unmoved';
        },
        { timeout: 8_000, message: () => `camera did not move: before=${JSON.stringify(before)} after=${JSON.stringify(after)}` },
      )
      .toBe('moved');
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

  test('7. Layer toggles: each switch flips off/on without throwing', async ({ page }) => {
    // This sandbox renders Cesium in software (no real GPU - "GPU stall due
    // to ReadPixels" in the console confirms it), so each toggle's re-render
    // can take 1-3.5s. That's an environment characteristic, not a bug; give
    // it real headroom rather than let a slow-but-correct pass read as a hang.
    test.setTimeout(120_000);
    const capture = captureConsole(page);
    await page.goto('/');
    await waitForViewer(page);
    await page.waitForTimeout(1000);

    const checkboxes = page.locator('.tp-layer-row .tp-toggle-switch');
    const n = await checkboxes.count();
    expect(n, 'LayerPanel rendered zero toggle switches').toBeGreaterThan(0);

    for (let i = 0; i < n; i++) {
      const cb = checkboxes.nth(i);
      if (await cb.isDisabled()) continue; // "off" layers render disabled by design (ui-contract rule)
      await cb.scrollIntoViewIfNeeded();
      await cb.click({ timeout: 20_000 });
      await cb.click({ timeout: 20_000 });
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

    await page.locator('.tp-status-toggles').getByRole('button', { name: '7d', exact: true }).click();
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
    // ForecastStrip.tsx renders the <svg> and its bars/path/marker in one
    // commit, so a 0-child read right after "visible" is a render/poll race,
    // not a real empty state (confirmed by re-running this in isolation and
    // by manual inspection - see the QA-E2E report). Poll instead of a
    // single-shot read so a transient race can't produce a false failure;
    // the >5 threshold itself is unchanged.
    await expect
      .poll(() => svg.locator(':scope > *').count(), { timeout: 10_000 })
      .toBeGreaterThan(5);
  });

  test('10. Brief card shows non-empty text and a provider label (demo beat 5)', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);

    const brief = page.locator('.tp-cf-brief');
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

  test('12. POST /demo/replay injects a REPLAY event at the top of the NOW section (single most important test)', async ({ page, request }) => {
    test.setTimeout(45_000);

    // Clean slate: /demo/reset deletes only source:"replay" events, so a
    // leftover replay from an earlier run/test can't make this test a false
    // pass. Best-effort - not in the frozen api.md contract, so tolerate it
    // being absent.
    await request.post(`${API_BASE}/demo/reset`, { data: {} }).catch(() => null);

    await page.goto('/');
    await waitForViewer(page);
    await expect(page.locator('.tp-timeline-row').first()).toBeVisible({ timeout: 20000 });
    // No REPLAY chip left over from the reset.
    await expect(page.locator('.tp-chip-replay')).toHaveCount(0);

    const res = await request.post(`${API_BASE}/demo/replay`, { data: { scenario: 'quake' } });
    expect(res.ok(), `POST /demo/replay failed: ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();
    const body = await res.json();
    expect(body.injected, 'replay response reported zero injected events').toBeGreaterThan(0);

    // UI polls /events.json every 15s; allow margin for the poll + a render pass.
    // Timeline.tsx pins a separate "Upcoming" (future-dated) section above the
    // "NOW" section, so "top of the timeline" means top of the NOW section,
    // i.e. the first row that isn't tagged upcoming.
    const topNowRow = page.locator('.tp-timeline-row:not(.tp-timeline-row-upcoming)').first();
    await expect(topNowRow.locator('.tp-chip-replay')).toBeVisible({ timeout: 20000 });
  });
});
