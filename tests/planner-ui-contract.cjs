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
assert(html.includes('data-layer="surface_height"'), 'Currents mode must expose Sea Surface Height anomaly contours');
assert(html.includes("mapFields:[['sea_surface_temperature_f','Sea-surface temperature']]"), 'SST must remain the only Currents color-map field');
assert(html.includes('const currentParticles = []'), 'currents must have an animated particle layer');
assert(html.includes('const dt = vec.speed * 0.00035'), 'current particles must move slower than wind particles');
assert(html.includes('CURRENT_VISUAL_SPEED_MULTIPLIER = 5'), 'current particle display speed must be restored to 5x');
assert(html.includes('currentParticleColor'), 'current particles must use SST-origin tinting');
assert(html.includes('Math.max(1500, Math.min(3000'), 'current particles must be substantially denser');
assert(html.includes("fixedRange: [65, 85]"), 'SST range must be 65–85°F');
console.log('PASS: planner scale, labels, gust behavior, and progressive-detail contracts');
