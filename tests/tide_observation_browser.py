from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 for mobile in [False,True]:
  page=b.new_page(viewport={'width':390 if mobile else 1280,'height':844 if mobile else 850},is_mobile=mobile)
  errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.route('**/planner/map?*',lambda r:r.fulfill(status=200,content_type='text/html',body=(ROOT / 'dashboard/planner/map.html').read_text()))
  page.goto('https://app.fishedge.live/dashboard/planner/map?region=usec_south&date=2026-10-07T06:00:00Z',wait_until='domcontentloaded')
  page.wait_for_function("document.querySelector('#bv-frame-label').textContent.includes('Oct')",timeout=60000)
  page.locator('#bv-hamburger-btn').click()
  page.locator('[data-preset=tides]').click()
  marker=page.locator('.bv-station-marker').filter(has_text='Beaufort').first
  print('markers',page.locator('.bv-station-marker').all_text_contents(),flush=True)
  marker.click()
  page.wait_for_function("document.querySelector('[data-tide-summary]').textContent.includes('measured') && !document.querySelector('[data-tide-summary]').textContent.includes('STALE')",timeout=20000)
  print('RESULT',mobile,page.locator('[data-tide-summary]').inner_text(),'ERRORS',errors,flush=True)
  assert not errors
  assert page.locator('#bv-tide-readout-svg circle').count()>0
  page.screenshot(path=f'/tmp/tide-observations-{mobile}.png')
  page.close()
 b.close()
