const assert = require('node:assert/strict');
const fs = require('node:fs');

const dashboard = fs.readFileSync('dashboard/index.html', 'utf8');
const locate = fs.readFileSync('dashboard/locate-me.js', 'utf8');
const chartbook = fs.readFileSync('dashboard/chartbook.js', 'utf8');

assert(/src="\/dashboard\/chartbook\.js(?:\?[^" ]+)?"/.test(dashboard), 'dashboard must load shared LogBook client');
assert(dashboard.includes('id="captain-fs-btn"'), 'dashboard must expose fullscreen');
assert(dashboard.includes('id="captain-chartbook-tool"'), 'dashboard must expose LogBook');
assert(dashboard.includes('Save to LogBook'), 'dashboard waypoint save must use LogBook');
assert(!dashboard.includes('Saved on this device'), 'dashboard must not advertise browser-only saved storage');
assert(locate.includes("captainTools.querySelector('#captain-fs-btn')"), 'Locate Me must mount relative to fullscreen');
assert(dashboard.includes('href="/planner/">PLANNER</a>'), 'dashboard menu must link to Planner');
assert(dashboard.includes("loadDashboardLogBookItem(item)"), 'dashboard LogBook rows must load records onto the map');
assert(dashboard.includes('Number.isFinite(p.chl)'), 'loaded waypoints must tolerate missing sampled values');
assert(dashboard.includes('id="home-link-wrap"><a href="/planner/">PLANNER</a>'), 'dashboard footer must expose Planner and Home buttons');
assert(dashboard.includes('id="combined-page-links"'), 'combined dashboard footer must expose the correct navigation buttons');
assert(!dashboard.includes('id="combined-account-link"'), 'combined dashboard footer must not show the old Account button');
assert(dashboard.includes('gridCache.__bathy_json_url === url'), 'bathymetry cache must be keyed by source URL');
assert(dashboard.includes('Stale bathymetry response ignored'), 'stale region bathymetry responses must be rejected');
assert(chartbook.includes("const TABLE = 'logbook_items'"), 'LogBook client must use the shared account table');
assert(chartbook.includes('stableId'), 'LogBook records must have stable geometry-derived IDs');
console.log('PASS: dashboard and planner share LogBook tool contracts');
