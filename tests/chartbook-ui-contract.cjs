const assert = require('node:assert/strict');
const fs = require('node:fs');

const dashboard = fs.readFileSync('dashboard/index.html', 'utf8');
const locate = fs.readFileSync('dashboard/locate-me.js', 'utf8');
const chartbook = fs.readFileSync('dashboard/chartbook.js', 'utf8');

assert(dashboard.includes('src="/dashboard/chartbook.js"'), 'dashboard must load shared LogBook client');
assert(dashboard.includes('id="captain-fs-btn"'), 'dashboard must expose fullscreen');
assert(dashboard.includes('id="captain-chartbook-tool"'), 'dashboard must expose LogBook');
assert(dashboard.includes('Save to LogBook'), 'dashboard waypoint save must use LogBook');
assert(!dashboard.includes('Saved on this device'), 'dashboard must not advertise browser-only saved storage');
assert(locate.includes("insertBefore(btnCombined, captainTools.querySelector('.captain-tool-btn') || null)"), 'Locate Me must be first in the shared tool row');
assert(chartbook.includes("const TABLE = 'logbook_items'"), 'LogBook client must use the shared account table');
assert(chartbook.includes('stableId'), 'LogBook records must have stable geometry-derived IDs');
console.log('PASS: dashboard and planner share LogBook tool contracts');
