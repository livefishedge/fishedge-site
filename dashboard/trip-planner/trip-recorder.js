/* Foreground Trip Companion recorder. Stores only a simplified text route. */
(function (global) {
  'use strict';
  const KEY = 'fishedge:trip-recorder:pending';
  const state = { active:false, paused:false, started:null, points:[], watch:null, lastFix:null };
  const el = id => document.getElementById(id);
  const status = text => { const node = el('bv-trip-recording-status'); if (node) node.textContent = text; };
  const distance = (a,b) => { const r=Math.PI/180, p1=a[1]*r,p2=b[1]*r,dp=(b[1]-a[1])*r,dl=(b[0]-a[0])*r,h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2; return 3440.065*2*Math.atan2(Math.sqrt(h),Math.sqrt(1-h)); };
  function compact(points) { if (points.length <= 200) return points; const step=(points.length-1)/199, out=[]; for(let i=0;i<200;i++) out.push(points[Math.round(i*step)]); return out; }
  function persistPending() { try { localStorage.setItem(KEY, JSON.stringify({started_iso:state.started, points:compact(state.points), last_fix:state.lastFix})); } catch (_) {} }
  function start() {
    if (!navigator.geolocation) { status('Location is unavailable on this device'); return; }
    state.active=true; state.paused=false; state.started=new Date().toISOString(); state.points=[]; status('Requesting GPS…');
    state.watch=navigator.geolocation.watchPosition(pos => { if (state.paused) return; const point=[pos.coords.longitude,pos.coords.latitude]; state.lastFix={at:new Date(pos.timestamp||Date.now()).toISOString(),accuracy_m:Number(pos.coords.accuracy)||null}; const prev=state.points[state.points.length-1]; if (!prev || distance(prev,point) >= .02) state.points.push(point); persistPending(); status(`Recording · ${state.points.length} fixes · GPS ±${Math.round(pos.coords.accuracy||0)} m`); }, () => status('Recording · GPS unavailable (gap recorded)'), {enableHighAccuracy:true, maximumAge:30000, timeout:20000});
    el('bv-trip-start').textContent='Pause recording';
  }
  function pause() { state.paused=!state.paused; el('bv-trip-start').textContent=state.paused?'Resume recording':'Pause recording'; status(state.paused?'Paused · location is not being recorded':'Recording resumed'); }
  function end() {
    if (!state.active) return;
    if (state.watch != null) navigator.geolocation.clearWatch(state.watch);
    const points=compact(state.points), store=global.FishEdgeTripStorage;
    const trip={name:`Recorded trip · ${new Date(state.started).toLocaleDateString('en-US',{month:'short',day:'numeric'})}`, status:'completed', departure_iso:state.started, return_iso:new Date().toISOString(), route_polyline:store?.encodePolyline(points)||null, route_distance_nm:store?.routeDistanceNm(points)||0, route_approximate:true, notes:'Foreground GPS recording; route simplified for storage.', recorded_fix_count:state.points.length, gps_quality:state.lastFix};
    try { store?.saveTrip(trip); localStorage.removeItem(KEY); } catch (_) {}
    state.active=false; state.paused=false; state.points=[]; status('Trip saved to My Trips'); el('bv-trip-start').textContent='Start trip recording';
  }
  function wire() { const button=el('bv-trip-start'); if (!button) return; button.addEventListener('click', () => !state.active ? start() : pause()); const endButton=document.createElement('button'); endButton.type='button'; endButton.textContent='End and save trip'; endButton.addEventListener('click', end); button.parentNode.insertBefore(endButton, button.nextSibling); }
  function autoStart() { if (localStorage.getItem('fishedge:trip-recording-default') === 'false') return; start(); }
  function boot() { wire(); autoStart(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  global.FishEdgeTripRecorder={start,pause,end,state};
})(typeof globalThis !== 'undefined' ? globalThis : this);
