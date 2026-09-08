const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('dashboard/trip-planner/briefing-viewer.html', 'utf8');
assert(!html.includes('new ol.control.ScaleLine()'), 'planner must not show the generic distance scale bar');
for (const label of ['Swell Height', 'Wave Height', 'Surface Steepness', 'Visibility', 'Feels Like', 'Humidity']) {
  assert(html.includes(label), `canonical label missing: ${label}`);
}
assert(html.includes("scale: 'ALERT'"), 'surface steepness must use the alert palette');
assert(html.includes("scale: 'RIDE'"), 'ride harshness must use the ride-comfort palette');
assert(html.includes('const target = Math.max(60, Math.min(360, Math.round(area / 3200)))'), 'gust particles must be sparse');
assert(html.includes('vec.speed / sustained.speed'), 'gust speed must scale with gust:wind ratio');
const weatherDetail = html.slice(html.indexOf("weather: {"), html.indexOf("fishing: {"));
assert(weatherDetail.includes("'cloud_low'") && weatherDetail.includes("'cloud_mid'"), 'low/mid cloud must remain in Weather Details');
const seaDetail = html.slice(html.indexOf("sea: {"), html.indexOf("weather: {"));
assert(seaDetail.includes("'surface_texture'"), 'surface texture must remain in Sea Details');
console.log('PASS: planner scale, labels, gust behavior, and progressive-detail contracts');
