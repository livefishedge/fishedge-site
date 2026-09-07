const assert = require('node:assert/strict');
const fs = require('node:fs');

for (const file of [
  'data/usec_md/briefing/forecast.json',
  'dashboard/trip-planner/data/usec_md/briefing/forecast.json',
]) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const source = payload.marine_source_grid;
  assert(source && source.returned_latitude && source.returned_longitude, `${file}: returned source coordinates missing`);
  assert(Number.isFinite(source.max_displacement_km), `${file}: source displacement missing`);
  assert(Array.isArray(payload.wave_open_water_cells), `${file}: open-water support grid missing`);
  assert.equal(payload.wave_open_water_cells.length, payload.lats.length - 1, `${file}: support rows mismatch`);
  assert.equal(payload.wave_open_water_cells[0].length, payload.lons.length - 1, `${file}: support columns mismatch`);
  assert.equal(payload.wave_component_contract.swell.status, 'regional_context_only_unless_open_water_supported');
  assert.equal(payload.wave_component_contract.wind_wave.status, 'regional_source_with_partial_water_anchors');
}

const html = fs.readFileSync('dashboard/trip-planner/briefing-viewer.html', 'utf8');
assert(html.includes('wave_open_water_cells'), 'renderer must consume generic open-water support');
assert(html.includes('regional context only; not locally resolved here'), 'renderer must expose unresolved swell state');
console.log('PASS: native source coordinates, generic open-water support contract, and unresolved swell state');
