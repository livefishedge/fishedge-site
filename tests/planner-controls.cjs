const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/home/gzheng/.openclaw/tools/node-v22.22.0/lib/node_modules/openclaw/node_modules/playwright-core');
const url = process.env.PLANNER_URL || 'http://127.0.0.1:8766/trip-planner/briefing-viewer.html?region=usec_md';
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH || '/home/gzheng/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args:['--no-sandbox']});
  try {
    const page=await browser.newPage({viewport:{width:1200,height:850}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(()=>document.querySelector('#bv-frame-label').textContent.includes(' ET'),{timeout:30000});
    await page.waitForTimeout(1800);
    const select=()=>page.locator('select[data-map-field]');
    const pixels=()=>page.evaluate(()=>{
      const c=document.querySelector('.bv-streamlines-canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let n=0;for(let i=3;i<d.length;i+=4)if(d[i]>100)n++;return n;
    });
    await page.locator('[data-wave-motion]').uncheck();
    for(const key of ['wave_height_ft','swell_height_ft','wind_wave_height_ft']){
      await select().selectOption(key);await page.waitForTimeout(150);
      assert(await pixels()>1000, key+' must paint pixels, not merely a legend');
    }
    await select().selectOption('');await page.waitForTimeout(150);
    assert.equal(await pixels(),0,'None must clear fill');
    await page.locator('[data-preset=weather]').click();
    await page.locator('.bv-layer-details summary').click();
    await page.locator('[data-scalar=dew_point_f]').click();
    assert(await page.locator('.bv-layer-details').evaluate(e=>e.open),'Details stays open after selection');
    assert.equal(await select().inputValue(),'dew_point_f');
    await page.locator('[data-preset=fishing]').click();
    await page.locator('[data-preset=weather]').click();
    assert.equal(await select().inputValue(),'dew_point_f','view remembers field');
    await page.locator('[data-reset-view]').click();
    assert.equal(await select().inputValue(),'visibility_mi');
    await page.locator('[data-preset=sea]').click();
    await page.mouse.click(600,400);
    assert(await page.locator('#bv-wave-readout').isVisible(),'map click opens readout');
    assert(/°[WE], .*°[NS]/.test(await page.locator('#bv-wave-readout [data-readout-title]').innerText()),'readout uses signed coordinates');
    assert(/forecast/.test(await page.locator('#bv-wave-readout [data-readout-body]').innerText()),'readout shows forecast time');
    assert.equal(await page.locator('#bv-click-marker').evaluate(e=>getComputedStyle(e).display),'block','clicked location marker visible');
    await page.locator('.bv-readout-toggle').click();
    assert(await page.locator('#bv-wave-readout').evaluate(e=>e.classList.contains('is-collapsed')),'readout can collapse');
    await page.locator('[data-preset=tides]').click();
    assert.equal(await select().inputValue(),'','Tides opens station-first');
    assert(await page.locator('#bv-station-popup').isVisible());
    for(const marker of await page.locator('.bv-station-marker').all()){
      await marker.evaluate(e=>e.click());
      assert(!/unavailable|^—$/.test(await page.locator('#bv-tide-latest').innerText()));
      assert((await page.locator('#bv-tide-svg polyline').first().getAttribute('points')).length>10);
    }
    await page.setViewportSize({width:390,height:844});
    await page.locator('[data-preset=weather]').click();
    await page.locator('.bv-layer-details summary').click();
    const box=await page.locator('.bv-details-panel').boundingBox();
    assert(box.x>=0 && box.x+box.width<=390,'Details fits mobile');
    assert(await page.locator('#bv-time').isVisible(),'mobile freshness visible');
    await page.screenshot({path:'/tmp/planner-audit-mobile.png'});
    assert.deepEqual(errors,[]);
    console.log('PASS: scalar pixels, None, Details persistence, view memory/reset, 8 station charts, mobile bounds/freshness, no page errors');
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
