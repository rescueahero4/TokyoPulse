const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('requestfailed', r => console.log('[requestfailed]', r.url(), r.failure()?.errorText));
  page.on('response', r => { if (r.status() >= 400) console.log('[response>=400]', r.status(), r.url()); });
  await page.goto('http://127.0.0.1:5173/');
  await page.waitForFunction(() => !!window.__tpViewer, null, { timeout: 20000 });
  await page.waitForTimeout(1000);
  // toggle flood on
  const checkboxes = page.locator('.tp-layer-row input[type="checkbox"]');
  const n = await checkboxes.count();
  for (let i=0;i<n;i++){
    const label = await checkboxes.nth(i).locator('xpath=../span[1]').textContent().catch(()=>'?');
    if (/flood/i.test(label||'')) {
      console.log('toggling flood at index', i);
      await checkboxes.nth(i).click();
      await page.waitForTimeout(4000);
      break;
    }
  }
  await browser.close();
})();
