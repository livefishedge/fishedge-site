const {readFileSync} = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = readFileSync(`${__dirname}/../dashboard/trip-planner/briefing-viewer.html`, 'utf8');
const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).filter(Boolean);
inline.forEach(s=>new vm.Script(s));
function extract(name) {
  const start=html.indexOf(`    function ${name}(`);
  const end=html.indexOf('\n    function ', start+10);
  return html.slice(start,end);
}
const context=vm.createContext({Math, Number});
vm.runInContext(extract('wavePhaseMetrics'),context);
const metric=t=>context.wavePhaseMetrics(t);
const a=metric(6),b=metric(12);
assert.equal(b.gapPx/a.gapPx,4);
assert.equal(b.speedPxS/a.speedPxS,2);
assert.equal(b.intervalS/a.intervalS,2);
for(const t of [2,4,6,8,12,16,24]) {
 const m=metric(t);
 assert.ok(Math.abs(m.gapPx/m.speedPxS-m.intervalS)<1e-10);
}
for(const t of [null,undefined,NaN,0,-1,Infinity]) assert.equal(metric(t),null);
context.forecastData={lons:[0,1],lats:[0,1]};
vm.runInContext(extract('bilinearPartitionVec'),context);
const grid=v=>[[v,v],[v,v]];
for (const kind of ['swell','wind_wave']) {
 const frame={ [`${kind}_height_ft`]:grid(2), [`${kind}_direction_deg`]:grid(90), [`${kind}_period_s`]:grid(12) };
 let v=context.bilinearPartitionVec(frame,kind,.5,.5);
 assert.ok(v.u<0 && Math.abs(v.v)<1e-10,'FROM east travels west');
 assert.equal(v.height,2); assert.equal(v.period,12);
 frame[`${kind}_height_ft`]=grid(0);
 v=context.bilinearPartitionVec(frame,kind,.5,.5);
 assert.equal(v.height,0); assert.equal(v.speed,0,'calm has no moving crests');
frame[`${kind}_height_ft`]=grid(2);
frame[`${kind}_period_s`][0][0]=null;
 assert.equal(context.bilinearPartitionVec(frame,kind,.5,.5).period,12,'valid period contributors remain usable');
 frame[`${kind}_period_s`]=[[null,null],[null,null]];
 assert.equal(context.bilinearPartitionVec(frame,kind,.5,.5).period,null,'all missing periods remain missing');
}
console.log('PASS: inline syntax; 6s/12s ratios; wavelength=speed×interval; invalid periods; partition direction, height, calm and missing data.');
