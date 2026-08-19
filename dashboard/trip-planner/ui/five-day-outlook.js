/*!
 * Five-day outlook — one card per day, each with its own decision badge.
 * Drives the Planner tab's main body. Tapping a day opens the
 * segment-level briefing for that day.
 */
(function attachFiveDayOutlook(global) {
  'use strict';
  const Dec = global.TripDecisionEngine;

  function fmtWindHour(plan) {
    const seg = plan && plan.segments && plan.segments.target;
    const w = seg && seg.now && seg.now.wind && seg.now.wind.value;
    if (!w || w.speed == null) return '—';
    return `${Math.round(w.speed)}kt G${w.gust != null ? Math.round(w.gust) : '?'}`;
  }
  function fmtWaveHour(plan) {
    const seg = plan && plan.segments && plan.segments.target;
    const wa = seg && seg.now && seg.now.wave && seg.now.wave.value;
    if (!wa || wa.height == null) return '—';
    return `${wa.height.toFixed(1)}ft @ ${wa.dominant_period ? Math.round(wa.dominant_period) : '?'}s`;
  }
  function decisionFor(plan) {
    const d = plan && plan.decision;
    return (d && d.decision) || 'UNKNOWN';
  }
  function dayLabel(plan, idx) {
    const seg = plan && plan.segments && plan.segments.target;
    const dep = seg && seg.trip_window && seg.trip_window.departure_iso;
    const base = dep ? new Date(dep) : new Date(Date.now() + idx * 86400 * 1000);
    base.setDate(base.getDate() + idx);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((base - today) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return base.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function render(plans, opts = {}) {
    const cards = plans.map((plan, i) => {
      const decision = decisionFor(plan);
      const reasonCount = (plan.decision && plan.decision.reasons && plan.decision.reasons.length) || 0;
      const ww = plan && plan.segments && plan.segments.target && plan.segments.target.trip_window && plan.segments.target.trip_window.worst_window;
      const worstTxt = ww
        ? `Worst ${new Date(ww.start_iso).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })}: ${ww.max_wave_height}ft / G${ww.max_wind_gust}kt`
        : '—';
      return `
        <button class="fdo-day" data-day="${i}" aria-label="Open ${dayLabel(plan, i)} ${decision} details">
          <div class="fdo-when">${dayLabel(plan, i)}</div>
          <span class="fdo-decision ${decision}">${decision.replace('_', '-')}</span>
          <div class="fdo-summary">${fmtWindHour(plan)} · ${fmtWaveHour(plan)}</div>
          <div class="fdo-meta">${worstTxt}${reasonCount ? ` · ${reasonCount} flag${reasonCount === 1 ? '' : 's'}` : ''}</div>
          <div class="fdo-open">Open layers and decision details ›</div>
        </button>`;
    }).join('');
    return `<div id="fishedge-five-day-grid">${cards}</div>`;
  }

  function mount(host, plans, opts = {}) {
    if (!host) throw new Error('five-day-outlook mount: host is required');
    host.innerHTML = render(plans, opts);
    host.querySelectorAll('.fdo-day').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-day'));
        opts.onDayClick && opts.onDayClick(idx, plans[idx]);
      });
    });
    return host;
  }

  const api = Object.freeze({ render, mount });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FishEdgeTripPlannerUI = Object.assign(global.FishEdgeTripPlannerUI || {}, { FiveDayOutlook: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
