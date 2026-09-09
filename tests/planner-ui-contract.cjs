const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('dashboard/trip-planner/briefing-viewer.html', 'utf8');
assert(!html.includes('new ol.control.ScaleLine()'), 'planner must not show the generic distance scale bar');
assert(!html.includes('>View Mode:</span>'), 'planner must not show the redundant View Mode label');
for (const mode of ['Sea State', 'Weather', 'Currents', 'Tides']) assert(html.includes(`>${mode}</button>`), `mode missing: ${mode}`);
for (const label of ['Swell Height', 'Wave Height', 'Surface Steepness', 'Visibility', 'Feels Like', 'Humidity']) {
  assert(html.includes(label), `canonical label missing: ${label}`);
}
assert(html.includes("scale: 'ALERT'"), 'surface steepness must use the alert palette');
assert(html.includes("scale: 'RIDE'"), 'ride harshness must use the ride-comfort palette');
assert(html.includes('const target = Math.max(70, Math.min(500, Math.round(area / 2200)))'), 'gust particles must be less frequent than wind particles');
assert(html.includes('vec.speed / sustained.speed'), 'gust speed must scale with gust:wind ratio');
assert(html.includes('randomValidGustParticle'), 'gusts must seed on valid gust data');
assert(html.includes('waveReadout?.addEventListener'), 'collapsed readout must expand from any click');
assert(html.includes('#bv-wave-readout.is-collapsed .bv-readout-toggle{display:none}'), 'collapsed readout must hide the plus control');
const weatherDetail = html.slice(html.indexOf("weather: {"), html.indexOf("fishing: {"));
assert(weatherDetail.includes("'cloud_low'") && weatherDetail.includes("'cloud_mid'"), 'low/mid cloud must remain in Weather Details');
const seaDetail = html.slice(html.indexOf("sea: {"), html.indexOf("weather: {"));
assert(!seaDetail.includes("'surface_texture'"), 'surface texture must be removed from Sea Details');
assert(html.includes("surface_height:'surface_height_m'"), 'Currents mode must expose optional Surface Height data');
assert(html.includes('const currentParticles = []'), 'currents must have an animated particle layer');
assert(html.includes('const dt = vec.speed * 0.00035'), 'current particles must move slower than wind particles');
assert(html.includes('currentParticleColor'), 'current particles must use SST-origin tinting');
console.log('PASS: planner scale, labels, gust behavior, and progressive-detail contracts');
