const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/home/gzheng/.openclaw/tools/node-v22.22.0/lib/node_modules/openclaw/node_modules/playwright-core');
const url = process.env.PLANNER_URL || 'http://127.0.0.1:8766/trip-planner/briefing-viewer.html?region=usec_md';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/home/gzheng/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#bv-frame-label')?.textContent.includes(' ET'), { timeout: 30000 });
    await page.locator('[data-preset=fishing]').click();
    await page.waitForTimeout(500);
    const canvases = '.bv-flow-canvas, .bv-streamlines-canvas, .bv-tide-overlay-canvas, .bv-sla-overlay-canvas';
    const before = await page.locator('.bv-streamlines-canvas').evaluate(c => ({ width: c.width, height: c.height }));
    const origin = await page.locator('.bv-streamlines-canvas').evaluate(c => getComputedStyle(c).transformOrigin);
    assert(/^0px 0px/.test(origin), `overlay transform origin must be 0 0, got ${origin}`);
    await page.locator('.ol-zoom-in').click();
    let observed = null;
    let duringRect = null;
    for (let i = 0; i < 12; i++) {
      duringRect = await page.locator('.bv-streamlines-canvas').evaluate(c => {
        const r = c.getBoundingClientRect();
        const m = c.closest('.bv-map').getBoundingClientRect();
        return { left: r.left, top: r.top, width: r.width, height: r.height,
          canvasCenter: [r.left + r.width / 2, r.top + r.height / 2],
          mapCenter: [m.left + m.width / 2, m.top + m.height / 2] };
      });
      observed = await page.locator('.bv-streamlines-canvas').evaluate(c => getComputedStyle(c).transform);
      if (observed && observed !== 'none' && observed !== 'matrix(1, 0, 0, 1, 0, 0)') break;
      await page.waitForTimeout(16);
    }
    assert(observed && observed !== 'none' && observed !== 'matrix(1, 0, 0, 1, 0, 0)', `zoom must transform overlays during transition: ${observed}`);
    const centerError = Math.hypot(duringRect.canvasCenter[0] - duringRect.mapCenter[0], duringRect.canvasCenter[1] - duringRect.mapCenter[1]);
    assert(centerError <= 2, `zoom overlay center must stay aligned with map center (error ${centerError.toFixed(2)}px): ${JSON.stringify(duringRect)}`);
    await page.waitForTimeout(500);
    const settled = await page.locator(canvases).evaluateAll(es => es.map(e => getComputedStyle(e).transform));
    assert(settled.every(v => v === 'none' || v === 'matrix(1, 0, 0, 1, 0, 0)'), `zoom transform must clear after settled redraw: ${settled}`);
    const after = await page.locator('.bv-streamlines-canvas').evaluate(c => ({ width: c.width, height: c.height }));
    assert(after.width >= before.width && after.height >= before.height, 'overlay canvas remains valid after zoom');
    await page.locator('.ol-zoom-out').click();
    await page.waitForTimeout(500);
    const second = await page.locator(canvases).evaluateAll(es => es.map(e => getComputedStyle(e).transform));
    assert(second.every(v => v === 'none' || v === 'matrix(1, 0, 0, 1, 0, 0)'), 'repeated zoom settles without stale transforms');
    assert.deepEqual(errors, [], 'zoom produces no page errors');
    console.log(`PASS: zoom overlay matrix observed (${observed}); origin=${origin}; center error=${centerError.toFixed(2)}px; settled transforms cleared; repeated zoom clean`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
