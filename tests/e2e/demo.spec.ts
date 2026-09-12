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

    // one layer toggle off/on - LayerPanel now docks bottom-left, collapsed
    // by default (a "Layers N/6" chip); expand it before its switches exist.
    const layerChip = page.locator('.tp-layer-chip');
    if (await layerChip.count()) {
      await layerChip.click();
    }
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

  test('4. Alert banner renders for a severity >= warning event (collapsed chip + expanded carousel)', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);

    // AlertBanner is collapsed-by-default (a compact chip) so the map stays
    // the hero. The chip still carries the top alert's title (and its REPLAY
    // chip if any) directly in the DOM - assert that first.
    const banner = page.locator('.tp-alert-banner');
    await expect(banner).toBeVisible({ timeout: 20000 });
    const chip = page.locator('.tp-alert-chip');
    await expect(chip).toBeVisible({ timeout: 5000 });
    const chipText = (await chip.textContent())?.trim() ?? '';
    expect(chipText.length).toBeGreaterThan(0);
    const chipTitle = (await chip.locator('.tp-alert-chip-title').textContent())?.trim() ?? '';
    expect(chipTitle.length, 'collapsed alert chip has no title text').toBeGreaterThan(0);

    // Expanding reveals the carousel, where the severity tag lives (WARNING/
    // CRITICAL is only ever printed in the expanded .tp-alert-meta, per the
    // component - the collapsed chip deliberately omits it to stay compact).
    await chip.click();
    const carousel = page.locator('.tp-alert-carousel');
    await expect(carousel).toBeVisible({ timeout: 5000 });
    const metaText = (await page.locator('.tp-alert-meta').first().textContent()) ?? '';
    expect(/WARNING|CRITICAL/.test(metaText), `expanded alert meta did not show a WARNING/CRITICAL tag: "${metaText}"`).toBeTruthy();
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

  test('6. Line search "Mita" -> pick result -> line detail with ward + station count (demo beat 3)', async ({ page }) => {
    test.setTimeout(45_000);
    await page.goto('/');
    await waitForViewer(page);

    // LineSearch + ImpactPanel are now ONE widget, LinePanel: picking a line
    // expands its detail INSIDE the panel (.tp-line-detail), not a second
    // floating .tp-impact-panel (that class only appears if ImpactPanel is
    // mounted standalone, which the app no longer does).
    const input = page.locator('.tp-line-search-input');
    await input.click();
    await input.fill('Mita');

    const result = page.locator('.tp-line-search-result', { hasText: 'Mita' });
    await expect(result.first()).toBeVisible({ timeout: 15000 });
    await result.first().click();

    const detail = page.locator('.tp-line-detail');
    await expect(detail).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.tp-line-detail-head')).toBeVisible();
    expect(await page.locator('.tp-impact-panel').count(), '.tp-impact-panel should not be mounted standalone by App').toBe(0);

    const wardRows = detail.locator('.tp-impact-ward-row');
    await expect(wardRows.first()).toBeVisible({ timeout: 10000 });
    expect(await wardRows.count()).toBeGreaterThan(0);

    const firstWardText = (await wardRows.first().textContent()) ?? '';
    expect(firstWardText, 'ward row does not show a station count').toMatch(/stations?/i);

    await page.screenshot({ path: 'e2e/screenshots/02-line-search-impact.png', fullPage: true });

    // Clear and repeat with a JR East line - live status coverage grew from
    // 6 to 11 lines (Toei-only -> +JR East), so this is now real, populated
    // data rather than an empty "no live feed" placeholder.
    await page.locator('.tp-line-search-clear').click();
    await input.click();
    await input.fill('Chuo');
    const chuoResult = page.locator('.tp-line-search-result', { hasText: 'Chuo' });
    await expect(chuoResult.first()).toBeVisible({ timeout: 15000 });
    await chuoResult.first().click();

    await expect(detail).toBeVisible({ timeout: 20000 });
    const chuoWardRows = detail.locator('.tp-impact-ward-row');
    await expect(chuoWardRows.first()).toBeVisible({ timeout: 10000 });
    expect(await chuoWardRows.count(), 'Chuo (JR East, live status) should have a populated ward list, not an empty one').toBeGreaterThan(0);
    const chuoStationRows = detail.locator('.tp-impact-station-row');
    expect(await chuoStationRows.count(), 'Chuo should have a populated station list').toBeGreaterThan(0);
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

    // LayerPanel now defaults to collapsed (a "Layers N/6" chip docked
    // bottom-left) - expand it before its switches are reachable.
    const layerChip = page.locator('.tp-layer-chip');
    await expect(layerChip).toBeVisible({ timeout: 10000 });
    await layerChip.click();
    await expect(page.locator('.tp-layer-panel')).toBeVisible({ timeout: 10000 });

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

  test('7b. Regression: basemap menu opens and is clickable while the MAP cluster is collapsed', async ({ page }) => {
    // The MAP cluster (web/src/map/CesiumViewer.tsx) is collapsed by default.
    // Until minutes before this test was written, the basemap picker's portal
    // was nested INSIDE the collapsed cluster body and rendered nothing - the
    // fix moves it to a document.body portal (#tp-basemap-menu) triggered by a
    // button that lives in the header's always-rendered actions slot. Pin the
    // exact regression: collapsed cluster, menu opens, options are real and
    // clickable, and the portal really is body-level (not just visually
    // similar while still trapped inside the collapsed ancestor).
    test.setTimeout(45_000);
    const capture = captureConsole(page);
    await page.goto('/');
    await waitForViewer(page);

    const mapCluster = page.locator('.map-controls');
    await expect(mapCluster).toBeVisible({ timeout: 15000 });
    const clusterClass = (await mapCluster.getAttribute('class')) ?? '';
    expect(clusterClass, 'MAP cluster is expected to be collapsed by default').toMatch(/tp-panel-collapsed/);

    const trigger = page.locator('.map-zoom-basemap');
    await expect(trigger).toBeVisible({ timeout: 10000 });
    const beforeSwatch = await trigger.locator('.map-basemap-swatch').getAttribute('data-bm');

    await trigger.click();

    const menu = page.locator('#tp-basemap-menu');
    await expect(menu).toBeVisible({ timeout: 10000 });
    const insideCollapsedCluster = await menu.evaluate((el) => !!el.closest('.map-controls'));
    expect(
      insideCollapsedCluster,
      'basemap menu rendered nested inside the collapsed .map-controls cluster - it would be invisible/unclickable, the exact regression',
    ).toBe(false);
    const menuParentTag = await menu.evaluate((el) => el.parentElement?.tagName);
    expect(menuParentTag, 'basemap menu is not a direct child of <body>, so it is not really portal-level').toBe('BODY');

    const options = menu.locator('.map-basemap-opt:not(.map-basemap-labels)');
    const optCount = await options.count();
    expect(optCount, 'basemap menu rendered zero style options').toBeGreaterThan(0);
    let target = options.first();
    for (let i = 0; i < optCount; i++) {
      const cls = (await options.nth(i).getAttribute('class')) ?? '';
      if (!/is-active/.test(cls)) { target = options.nth(i); break; }
    }
    const targetSwatch = await target.locator('.map-basemap-swatch').getAttribute('data-bm');
    expect(targetSwatch, 'candidate basemap option has no data-bm').toBeTruthy();
    await target.click();

    // Picking an option closes the portal and updates the trigger's own swatch.
    await expect(menu).toHaveCount(0, { timeout: 10000 });
    await expect(trigger.locator('.map-basemap-swatch')).toHaveAttribute('data-bm', targetSwatch as string, { timeout: 10000 });
    expect(targetSwatch).not.toBe(beforeSwatch);

    const canvas = page.locator('canvas').first();
    await expect(canvas).toBeVisible();
    const stats = await canvasColorVariance(page);
    expect(stats.uniqueColors, `canvas blanked after basemap switch: ${JSON.stringify(stats)}`).toBeGreaterThan(3);

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

  test('12b. Regression: dismiss-all alerts, then /demo/replay must still surface an alert', async ({ page, request }) => {
    // A8 found and fixed: /demo/replay reuses the stable id "replay-quake",
    // so dismissing everything and then firing the replay showed NOTHING -
    // the scripted earthquake would have silently failed on stage. The fix
    // keys dismissal on id+time (AlertBanner.tsx's dismissKey), so a replay's
    // fresh timestamp makes it "news again" even if every alert was just
    // dismissed. This test pins exactly that sequence.
    test.setTimeout(45_000);

    await page.goto('/');
    await waitForViewer(page);

    // There must be something to dismiss - live JMA warning-level events are
    // present on this deployment; if that ever isn't true, seed one via replay
    // first so the test still exercises the real dismiss-all path.
    let chip = page.locator('.tp-alert-chip');
    if (!(await chip.isVisible().catch(() => false))) {
      const seed = await request.post(`${API_BASE}/demo/replay`, { data: { scenario: 'quake' } });
      expect(seed.ok(), 'could not seed an alert via /demo/replay to set up the dismiss-all regression test').toBeTruthy();
      await page.waitForTimeout(16_000); // one poll cycle
      chip = page.locator('.tp-alert-chip');
    }
    await expect(chip).toBeVisible({ timeout: 20000 });

    // Expand -> dismiss ALL.
    await chip.click();
    const carousel = page.locator('.tp-alert-carousel');
    await expect(carousel).toBeVisible({ timeout: 5000 });
    await page.locator('.tp-alert-dismiss').click();

    // Everything qualifying was just dismissed: the banner must show the
    // honest "N alerts dismissed / show" state, not the chip or carousel.
    await expect(page.locator('.tp-alert-restore')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.tp-alert-chip')).toHaveCount(0);
    await expect(page.locator('.tp-alert-carousel')).toHaveCount(0);

    // Fire the scripted replay exactly as the demo does.
    const res = await request.post(`${API_BASE}/demo/replay`, { data: { scenario: 'quake' } });
    expect(res.ok(), `POST /demo/replay failed: ${res.status()} ${await res.text().catch(() => '')}`).toBeTruthy();
    const body = await res.json();
    expect(body.injected, 'replay response reported zero injected events').toBeGreaterThan(0);

    // The alert must resurface (collapsed chip is enough - the new replay
    // event is severity "warning", so it won't auto-force-expand; only a
    // never-before-seen CRITICAL does that). Assert on the REPLAY chip
    // anywhere inside .tp-alert-banner so this holds regardless of whether
    // it renders collapsed or expanded.
    await expect(
      page.locator('.tp-alert-banner .tp-chip-replay'),
      'the alert did not resurface after dismiss-all + replay - this is the exact bug A8 fixed',
    ).toBeVisible({ timeout: 20000 });
  });

  test('API regression: /lines.geojson and /impact/{lineId} must never disagree on a line\'s status', async ({ request }) => {
    test.setTimeout(45_000);
    const linesRes = await request.get(`${API_BASE}/lines.geojson`);
    expect(linesRes.ok()).toBeTruthy();
    const linesBody = await linesRes.json();
    const lines: { properties: { lineId: string; status: string; name: string } }[] = linesBody.features ?? [];
    expect(lines.length, '/lines.geojson returned zero features').toBeGreaterThan(0);

    const mismatches: string[] = [];
    for (const f of lines) {
      const { lineId, status, name } = f.properties;
      const impactRes = await request.get(`${API_BASE}/impact/${encodeURIComponent(lineId)}`);
      if (!impactRes.ok()) {
        mismatches.push(`${lineId} (${name}): /impact/${lineId} returned ${impactRes.status()}`);
        continue;
      }
      const impact = await impactRes.json();
      if (impact.status !== status) {
        mismatches.push(`${lineId} (${name}): /lines.geojson says "${status}", /impact/${lineId} says "${impact.status}"`);
      }
    }
    expect(mismatches, `status disagreement between /lines.geojson and /impact/{lineId}:\n${mismatches.join('\n')}`).toEqual([]);
  });
});
