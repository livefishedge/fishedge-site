const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/home/gzheng/.openclaw/tools/node-v22.22.0/lib/node_modules/openclaw/node_modules/playwright-core');
const url = process.env.PLANNER_URL || 'http://127.0.0.1:8766/trip-planner/briefing-viewer.html?region=usec_md';
const executablePath = process.env.CHROMIUM_PATH || '/home/gzheng/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome';

(async () => {
  for (const dpr of [1, 2, 3]) {
    const browser = await chromium.launch({ headless: true, executablePath, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr, isMobile: true });
      await page.addInitScript(() => {
        window.__sstFillScales = [];
        const fill = CanvasRenderingContext2D.prototype.fill;
        CanvasRenderingContext2D.prototype.fill = function(...args) {
          if (this.canvas?.classList.contains('bv-streamlines-canvas')) {
            window.__sstFillScales.push(this.getTransform().a);
          }
          return fill.apply(this, args);
        };
      });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.querySelector('#bv-frame-label')?.textContent.includes(' ET'), { timeout: 30000 });
      await page.locator('[data-preset=fishing]').click();
      await page.locator('input[data-layer="current"]').first().uncheck().catch(() => {});
      await page.locator('input[data-layer="surface_height"]').first().uncheck().catch(() => {});
      await page.locator('select[data-map-field]').selectOption('sea_surface_temperature_f');
      await page.waitForTimeout(500);
      const result = await page.evaluate(() => {
        const c = document.querySelector('.bv-streamlines-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let minX = c.width, minY = c.height, maxX = -1, maxY = -1, pixels = 0;
        for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
          if (d[(y * c.width + x) * 4 + 3] > 20) { pixels++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
        }
        return { width: c.width, height: c.height, pixels, minX, minY, maxX, maxY, scales: window.__sstFillScales };
      });
      const expectedScale = Math.max(1, Math.min(1.5, dpr));
      assert(Math.abs(result.width / 390 - expectedScale) < 0.02, `DPR ${dpr}: backing width must match capped DPR`);
      assert(result.pixels > 1000, `DPR ${dpr}: SST must paint pixels`);
      assert(result.maxX > result.width * 0.75, `DPR ${dpr}: SST must reach the right side of the region`);
      assert(result.maxY > result.height * 0.75, `DPR ${dpr}: SST must reach the bottom of the region`);
      assert(result.scales.some(scale => Math.abs(scale - expectedScale) < 0.02), `DPR ${dpr}: SST fill must use canvas scale`);
      assert.deepEqual(errors, [], `DPR ${dpr}: no page errors`);
      console.log(`PASS DPR ${dpr}: ${result.pixels} pixels, bounds ${result.minX},${result.minY}–${result.maxX},${result.maxY}, scale ${expectedScale}`);
    } finally { await browser.close(); }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
