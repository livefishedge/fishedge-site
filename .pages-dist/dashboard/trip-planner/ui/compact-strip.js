/*!
 * Compact conditions strip — persistent status pill on the existing dashboard.
 *
 * Renders ONE line above the map: decision badge + now + worst-in-trip + age.
 * Tapping/clicking opens the full briefing drawer.
 *
 * This module is loaded as a regular <script> in dashboard/index.html and
 * exposes FishEdgeTripPlannerUI.CompactStrip.
 */
(function attachCompactStrip(global) {
  'use strict';
  const Tp = global.FishEdgeTripPlanner || global.require && global.require('./adapters/index.js');

  const STRIP_CSS = `
    /* captain-trip-strip v1 — branch feat/trip-planner-dev-mvp */
    #fishedge-trip-strip {
      position: fixed; top: 8px; right: 8px; z-index: 9000;
      display: flex; flex-direction: column; gap: 4px;
      padding: 8px 10px; min-width: 240px; max-width: 320px;
      background: rgba(5,11,16,0.92); color: #e0e6ee;
      border: 1px solid #1b2836; border-radius: 8px;
      font: 13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;
      cursor: pointer; user-select: none;
      box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    }
    #fishedge-trip-strip .ts-row1 { display: flex; align-items: center; gap: 8px; }
    #fishedge-trip-strip .ts-badge {
      font-weight: 700; padding: 2px 8px; border-radius: 4px;
      letter-spacing: 0.5px; font-size: 11px;
    }
    #fishedge-trip-strip .ts-badge.GO      { background:#1e6e3a; color:#fff; }
    #fishedge-trip-strip .ts-badge.CAUTION { background:#a36d10; color:#fff; }
    #fishedge-trip-strip .ts-badge.NO_GO   { background:#9b1c1c; color:#fff; }
    #fishedge-trip-strip .ts-badge.UNKNOWN { background:#404a55; color:#fff; }
    #fishedge-trip-strip .ts-row2 { font-size: 12px; color: #9fb0c3; }
    #fishedge-trip-strip .ts-row3 { font-size: 11px; color: #6b7d92; }
    #fishedge-trip-strip:hover { border-color: #4d7dff; }
  `;

  function decisionBadge(decision) {
    const cls = decision || 'UNKNOWN';
    const label = ({ GO: 'GO', CAUTION: 'CAUTION', NO_GO: 'NO-GO', UNKNOWN: 'UNKNOWN' })[cls] || 'UNKNOWN';
    return `<span class="ts-badge ${cls}">${label}</span>`;
  }

  function fmtWind(seg) {
    const w = seg && seg.now && seg.now.wind && seg.now.wind.value;
    if (!w || w.speed == null) return '—';
    return `${Math.round(w.speed)}kt${w.gust ? ` G${Math.round(w.gust)}` : ''}`;
  }
  function fmtWave(seg) {
    const wa = seg && seg.now && seg.now.wave && seg.now.wave.value;
    if (!wa || wa.height == null) return '—';
    return `${wa.height.toFixed(1)}ft @ ${wa.dominant_period ? Math.round(wa.dominant_period) : '?'}s`;
  }
  function fmtWorst(plan) {
    const ww = plan && plan.segments && plan.target && plan.segments.target
      && plan.segments.target.trip_window && plan.segments.target.trip_window.worst_window;
    if (!ww) return '';
    const when = new Date(ww.start_iso).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true });
    return `Worst ${when}: ${ww.max_wave_height}ft / G${ww.max_wind_gust}kt`;
  }
  function fmtAge(plan) {
    const segs = plan && plan.segments && Object.values(plan.segments);
    if (!segs || !segs.length) return '';
    const ages = [];
    for (const s of segs) {
      for (const f of ['wind','wave','pressure']) {
        const a = s.now && s.now[f] && s.now[f].source && s.now[f].source.age_minutes;
        if (a != null && Number.isFinite(a)) ages.push(a);
      }
    }
    if (!ages.length) return '';
    const min = Math.min(...ages);
    if (min > 90) return `Stale — ${min} min old`;
    return `Updated ${min} min ago`;
  }

  function render(plan) {
    const d = plan.decision || { decision: 'UNKNOWN', reasons: [] };
    const seg = plan.segments && plan.segments.target;
    return `
      <div id="fishedge-trip-strip" role="button" tabindex="0" aria-label="Open captain briefing drawer">
        <div class="ts-row1">
          ${decisionBadge(d.decision)}
          <span><strong>${fmtWind(seg)}</strong> &nbsp; ${fmtWave(seg)}</span>
        </div>
        <div class="ts-row2">${fmtWorst(plan)}</div>
        <div class="ts-row3">${fmtAge(plan)} · tap to open briefing</div>
      </div>`;
  }

  function mount(plan, { onOpen, host } = {}) {
    if (typeof document === 'undefined') return; // SSR safety
    if (!document.getElementById('__fishedge_trip_strip_style__')) {
      const s = document.createElement('style');
      s.id = '__fishedge_trip_strip_style__';
      s.textContent = STRIP_CSS;
      document.head.appendChild(s);
    }
    const root = host || document.body;
    const old = document.getElementById('fishedge-trip-strip');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.innerHTML = render(plan);
    root.appendChild(wrap.firstElementChild);
    const el = document.getElementById('fishedge-trip-strip');
    if (el && typeof onOpen === 'function') {
      el.addEventListener('click', onOpen);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); }
      });
    }
    return el;
  }

  const api = Object.freeze({ render, mount, STRIP_CSS });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FishEdgeTripPlannerUI = Object.assign(global.FishEdgeTripPlannerUI || {}, { CompactStrip: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
