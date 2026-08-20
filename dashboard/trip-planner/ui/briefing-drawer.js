/*!
 * Briefing drawer — expandable panel attached to the existing dashboard.
 *
 * Sections (in order, top → bottom):
 *   1. Decision header: status + reasons + confidence + missing-inputs
 *   2. Per-segment tabs: Inlet | Transit | Target | Return
 *   3. Trip timeline: hourly forecast rows with worst-window highlighted
 *   4. Obs vs Forecast comparison: nearest NDBC vs Open-Meteo for that point
 *   5. Fishing context chips: SST / CHL / moon (future)
 *
 * Renders into an existing host element (e.g. #briefing-panel) without
 * rewriting the rest of the dashboard.
 */
(function attachBriefingDrawer(global) {
  'use strict';
  const Tp = global.FishEdgeTripPlanner || global.require && global.require('./adapters/index.js');

  const DRAWER_CSS = `
    /* captain-briefing-drawer v1 — branch feat/trip-planner-dev-mvp */
    #fishedge-briefing-drawer {
      display: none; position: fixed; top: 64px; right: 8px;
      width: min(520px, calc(100vw - 16px));
      max-height: calc(100vh - 80px);
      overflow-y: auto; z-index: 9500;
      background: rgba(5,11,16,0.96); color: #e0e6ee;
      border: 1px solid #1b2836; border-radius: 8px;
      font: 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    #fishedge-briefing-drawer.open { display: block; }
    #fishedge-briefing-drawer .bd-header { padding: 12px 14px; border-bottom: 1px solid #1b2836; }
    #fishedge-briefing-drawer .bd-header h2 { margin: 0 0 6px; font-size: 16px; }
    #fishedge-briefing-drawer .bd-tabs { display: flex; gap: 6px; padding: 8px 14px; border-bottom: 1px solid #1b2836; }
    #fishedge-briefing-drawer .bd-tab {
      padding: 4px 10px; border: 1px solid #2a3a4d; border-radius: 4px;
      background: transparent; color: #9fb0c3; cursor: pointer; font-size: 12px;
    }
    #fishedge-briefing-drawer .bd-tab.active { background: #1d4f91; color: #fff; border-color: #4d7dff; }
    #fishedge-briefing-drawer .bd-section { padding: 10px 14px; border-bottom: 1px solid #1b2836; }
    #fishedge-briefing-drawer .bd-section h3 { margin: 0 0 6px; font-size: 13px; color: #9fb0c3; text-transform: uppercase; letter-spacing: 0.4px; }
    #fishedge-briefing-drawer .bd-row { display: flex; gap: 12px; flex-wrap: wrap; }
    #fishedge-briefing-drawer .bd-cell {
      flex: 1 1 110px; padding: 6px 8px; background: rgba(255,255,255,0.04);
      border-radius: 4px; font-size: 12px;
    }
    #fishedge-briefing-drawer .bd-cell b { display: block; font-size: 13px; }
    #fishedge-briefing-drawer .bd-reasons li { margin: 4px 0; font-size: 12px; }
    #fishedge-briefing-drawer .bd-alert {
      padding: 8px 10px; margin-bottom: 6px;
      background: rgba(155,28,28,0.4); border-left: 3px solid #ff5e5e;
      border-radius: 4px; font-size: 12px;
    }
    #fishedge-briefing-drawer .bd-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    #fishedge-briefing-drawer .bd-table th, #fishedge-briefing-drawer .bd-table td {
      padding: 4px 6px; border-bottom: 1px solid #1b2836; text-align: left;
    }
    #fishedge-briefing-drawer .bd-table tr.worst { background: rgba(155,28,28,0.18); }
    #fishedge-briefing-drawer .bd-freshness { font-size: 11px; color: #6b7d92; }
    #fishedge-briefing-drawer .bd-disclaimer {
      padding: 10px 14px; font-size: 11px; color: #6b7d92; background: rgba(0,0,0,0.4);
    }
    #fishedge-briefing-drawer .bd-close {
      position: absolute; top: 8px; right: 8px;
      background: transparent; border: 1px solid #2a3a4d; color: #9fb0c3;
      border-radius: 4px; cursor: pointer; padding: 2px 8px; font-size: 12px;
    }
  `;

  function fmtVal(v, digits) {
    if (v == null) return '—';
    if (typeof v === 'number') return digits != null ? v.toFixed(digits) : String(Math.round(v));
    return String(v);
  }

  function renderHeader(plan) {
    const d = plan.decision || { decision: 'UNKNOWN', reasons: [], confidence: 'low' };
    const reasons = (d.reasons || []).filter((r) => r && r.code).map(r =>
      `<li><code>${r.code}</code> — ${r.field || '?'}${r.value != null ? ` = ${fmtVal(r.value)}` : ''}${r.threshold != null ? ` (threshold ${fmtVal(r.threshold)})` : ''}</li>`
    ).join('') || '<li>No rule triggers.</li>';
    const conf = d.confidence || 'low';
    const missing = (d.missing_required_inputs || []).map(m => `${m.field} (${m.reason})`).join(', ') || '—';
    const target = plan.request && plan.request.target_area;
    const targetLine = target
      ? `<div class="bd-area"><b>Operating area:</b> ${target.label} · ${target.description || 'corridor target'}<br/><span class="bd-freshness">${target.geometry && target.geometry.type === 'LineString' ? 'Line corridor — conditions are sampled across the area, not a single point.' : 'Area target'}</span></div>`
      : '';
    return `
      <div class="bd-header">
        <button class="bd-close" aria-label="Close briefing">×</button>
        <h2>Captain Briefing — ${plan.request && plan.request.home_inlet_label || 'Trip'}</h2>
        <div class="bd-freshness-badge ${plan.data_freshness || 'forecast'}">${(plan.data_freshness || 'forecast') === 'live' ? '🔴 REALTIME — at-dock verification' : '📊 FORECAST — model output'}</div>
        <div class="bd-now-strip">
          <div class="bd-now-cell"><span class="bd-now-label">Wind</span><span class="bd-now-value">${fmtWindBrief(plan)}</span></div>
          <div class="bd-now-cell"><span class="bd-now-label">Wave</span><span class="bd-now-value">${fmtWaveBrief(plan)}</span></div>
          <div class="bd-now-cell"><span class="bd-now-label">Pressure</span><span class="bd-now-value">${fmtPressBrief(plan)}</span></div>
          <div class="bd-now-cell"><span class="bd-now-label">Water</span><span class="bd-now-value">${fmtWaterBrief(plan)}</span></div>
          <div class="bd-now-cell"><span class="bd-now-label">Tide</span><span class="bd-now-value">${fmtTideBrief(plan)}</span></div>
        </div>
        ${targetLine}
        <div>Decision: <b>${d.decision}</b> · Confidence: <b>${conf}</b></div>
        <div>Missing required inputs: ${missing}</div>
        <ul class="bd-reasons">${reasons}</ul>
      </div>
    `;
  }

  function renderAlerts(plan) {
    const alerts = [];
    for (const key of Object.keys(plan.segments || {})) {
      const seg = plan.segments[key];
      if (seg && Array.isArray(seg.alerts)) alerts.push(...seg.alerts);
    }
    if (!alerts.length) return '';
    // Filter out malformed entries so we don't render 'undefined' strings.
    const items = alerts
      .filter((a) => a && a.event && a.severity)
      .map((a) => `<div class="bd-alert"><b>${a.event}</b> (${a.severity}) — ${a.headline || ''}</div>`)
      .join('');
    if (!items) return '';
    return `<div class="bd-section"><h3>Active Marine Alerts</h3>${items}</div>`;
  }

  function renderTabs(plan) {
    const segs = Object.keys(plan.segments || {});
    return segs.map((k, i) =>
      `<button class="bd-tab${i === 0 ? ' active' : ''}" data-segment="${k}">${plan.segments[k].label}</button>`
    ).join('');
  }

  function renderSegmentSection(seg) {
    try {
    const now = seg.now || {};
    const cells = [
      { label: 'Wind (now)', v: now.wind && now.wind.value ? `${Math.round(now.wind.value.speed)}kt ${now.wind.value.dir_cardinal || ''} G${now.wind.value.gust ? Math.round(now.wind.value.gust) : '?'}` : '—',
        src: now.wind && now.wind.source ? `${now.wind.source.provider} ${now.wind.source.station_id || ''} ${now.wind.source.age_minutes != null ? `(${now.wind.source.age_minutes}m old)` : ''}` : '—',
        freshness: now.wind && now.wind.freshness },
      { label: 'Wave (now)', v: now.wave && now.wave.value ? `${now.wave.value.height.toFixed(1)}ft @ ${now.wave.value.dominant_period ? Math.round(now.wave.value.dominant_period) : '?'}s ${now.wave.value.dir_cardinal || ''}` : '—',
        src: now.wave && now.wave.source ? `${now.wave.source.provider} ${now.wave.source.station_id || ''} ${now.wave.source.age_minutes != null ? `(${now.wave.source.age_minutes}m old)` : ''}` : '—',
        freshness: now.wave && now.wave.freshness },
      { label: 'Pressure', v: now.pressure && now.pressure.value ? `${now.pressure.value.pressure.toFixed(2)} inHg${now.pressure.value.tendency_3h != null ? ` (3h ${now.pressure.value.tendency_3h >= 0 ? '+' : ''}${now.pressure.value.tendency_3h.toFixed(2)})` : ''}` : '—',
        src: now.pressure && now.pressure.source ? `${now.pressure.source.provider} ${now.pressure.source.station_id || ''}` : '—',
        freshness: now.pressure && now.pressure.freshness },
      { label: 'Water temp', v: now.water_temperature && now.water_temperature.value ? `${now.water_temperature.value.toFixed(1)}°F` : '—',
        src: now.water_temperature && now.water_temperature.source ? `${now.water_temperature.source.provider}` : '—',
        freshness: now.water_temperature && now.water_temperature.freshness },
      { label: 'Visibility', v: now.visibility && now.visibility.value != null ? `${fmtVal(now.visibility.value, 1)}nm` : '—',
        src: now.visibility && now.visibility.source ? `${now.visibility.source.provider || ''}` : '—',
        freshness: now.visibility && now.visibility.freshness },
      { label: 'Precipitation', v: now.precipitation && now.precipitation.value != null ? `${fmtVal(now.precipitation.value, 1)}mm` : '—',
        src: now.precipitation && now.precipitation.source ? `${now.precipitation.source.provider || ''}` : '—',
        freshness: now.precipitation && now.precipitation.freshness },
      { label: 'Weather code', v: now.weather_code && now.weather_code.value != null ? String(now.weather_code.value) : '—',
        src: now.weather_code && now.weather_code.source ? `${now.weather_code.source.provider || ''}` : '—',
        freshness: now.weather_code && now.weather_code.freshness },
      { label: 'Next tide', v: now.tide && now.tide.value ? `${now.tide.value.next_high ? 'H' : ''} ${now.tide.value.next_high ? new Date(now.tide.value.next_high.iso).toLocaleTimeString('en-US',{hour:'numeric',hour12:true}) : ''} ${now.tide.value.next_high ? now.tide.value.next_high.value.toFixed(1) + 'ft' : ''} · ${now.tide.value.next_low ? 'L' : ''} ${now.tide.value.next_low ? new Date(now.tide.value.next_low.iso).toLocaleTimeString('en-US',{hour:'numeric',hour12:true}) : ''}` : '—',
        src: now.tide && now.tide.source ? `${now.tide.source.provider} ${now.tide.source.station_id || ''}` : '—',
        freshness: now.tide && now.tide.freshness },
    ];
    const html = cells.map(c =>
      `<div class="bd-cell"><b>${c.label}</b>${c.v}<div class="bd-freshness">${c.freshness || ''} · ${c.src || ''}</div></div>`
    ).join('');
    return `<div class="bd-section"><h3>Data layers — observed + forecast blend</h3><div class="bd-row">${html}</div></div>`;
    } catch (e) {
      console.warn('[briefing-drawer] renderSegmentSection failed:', e && e.message);
      return `<div class="bd-section"><h3>Data layers</h3><div class="bd-freshness">Segment render skipped — partial fixture data.</div></div>`;
    }
  }

  function renderTimeline(seg) {
    try {
    const tw = seg.trip_window || {};
    const hourly = Array.isArray(tw.hourly) ? tw.hourly : [];
    if (!hourly.length) return `<div class="bd-section"><h3>Trip timeline</h3><div class="bd-freshness">No model hourly available.</div></div>`;
    const ww = tw.worst_window || {};
    const isWorst = (row) => row.iso >= ww.start_iso && row.iso <= ww.end_iso;
    const rows = hourly.map(r =>
      `<tr class="${isWorst(r) ? 'worst' : ''}">
        <td>${new Date(r.iso).toLocaleString('en-US',{month:'numeric',day:'numeric',hour:'numeric',hour12:true})}</td>
        <td>${fmtVal(r.wind_speed, 0)}kt ${r.wind_dir_cardinal || ''}</td>
        <td>${fmtVal(r.wind_gust, 0)}kt</td>
        <td>${fmtVal(r.wave_height, 1)}ft</td>
        <td>${fmtVal(r.wave_period, 0)}s</td>
        <td>${fmtVal(r.pressure, 2)}</td>
      </tr>`
    ).join('');
    return `
      <div class="bd-section">
        <h3>Trip timeline (hourly forecast) ${ww.start_iso ? `· worst ${new Date(ww.start_iso).toLocaleString('en-US',{hour:'numeric',hour12:true})}–${new Date(ww.end_iso).toLocaleString('en-US',{hour:'numeric',hour12:true})}` : ''}</h3>
        <table class="bd-table">
          <thead><tr><th>When</th><th>Wind</th><th>Gust</th><th>Wave</th><th>Period</th><th>Pressure</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
    } catch (e) {
      console.warn('[briefing-drawer] renderTimeline failed:', e && e.message);
      return `<div class="bd-section"><h3>Trip timeline</h3><div class="bd-freshness">Timeline render skipped.</div></div>`;
    }
  }

  function renderObsVsModel(seg) {
    try {
    const now = seg.now || {};
    const ob = now.wave && now.wave.value;
    const modelRow = (seg.trip_window && Array.isArray(seg.trip_window.hourly) && seg.trip_window.hourly.length) ? seg.trip_window.hourly[0] : null;
    const mb = modelRow && (modelRow.wave_height != null || modelRow.wave_period != null);
    if (!ob && !mb) return '';
    const o = ob ? `${ob.height.toFixed(1)}ft @ ${ob.dominant_period ? Math.round(ob.dominant_period) : '?'}s ${ob.dir_cardinal || ''}` : '—';
    const m = modelRow ? `${fmtVal(modelRow.wave_height, 1)}ft @ ${fmtVal(modelRow.wave_period, 0)}s ${modelRow.wave_dir_cardinal || ''}` : '—';
    const d = seg.trip_window && seg.trip_window.obs_vs_model_disagreement;
    const verdict = d ? d.verdict : 'agree';
    return `
      <div class="bd-section">
        <h3>Now: observation vs model</h3>
        <div class="bd-row">
          <div class="bd-cell"><b>Observation</b>${o}<div class="bd-freshness">${now.wave && now.wave.source ? `${now.wave.source.provider} ${now.wave.source.station_id || ''} · ${now.wave.source.distance_nm ? now.wave.source.distance_nm+'nm' : ''}` : ''}</div></div>
          <div class="bd-cell"><b>Model (current hour)</b>${m}<div class="bd-freshness">model forecast · run ~6h ago</div></div>
          <div class="bd-cell"><b>Verdict</b>${verdict.toUpperCase()}${d && d.reasons ? '<div class="bd-freshness">'+d.reasons.join('; ')+'</div>' : ''}</div>
        </div>
      </div>
    `;
    } catch (e) {
      console.warn('[briefing-drawer] renderObsVsModel failed:', e && e.message);
      return `<div class="bd-section"><h3>Now: observation vs model</h3><div class="bd-freshness">Obs-vs-model render skipped.</div></div>`;
    }
  }

  function fmtWindBrief(plan) {
    const seg = plan && plan.segments && plan.segments.target;
    const w = seg && seg.now && seg.now.wind && seg.now.wind.value;
    if (!w || w.speed == null) return '—';
    return `${Math.round(w.speed)}kt ${w.dir_cardinal || ''} G${w.gust != null ? Math.round(w.gust) : '?'}`;
  }
  function fmtWaveBrief(plan) {
    const seg = plan && plan.segments && plan.segments.target;
    const wa = seg && seg.now && seg.now.wave && seg.now.wave.value;
    if (!wa || wa.height == null) return '—';
    return `${wa.height.toFixed(1)}ft @ ${wa.dominant_period ? Math.round(wa.dominant_period) : '?'}s`;
  }
  function fmtPressBrief(plan) {
    const seg = plan && plan.segments && plan.segments.target;
    const p = seg && seg.now && seg.now.pressure && seg.now.pressure.value;
    if (!p || p.pressure == null) return '—';
    return `${p.pressure.toFixed(2)} inHg`;
  }
  function fmtWaterBrief(plan) {
    const seg = plan && plan.segments && plan.segments.target;
    const w = seg && seg.now && seg.now.water_temperature && seg.now.water_temperature.value;
    if (!w) return '—';
    return `${(+w).toFixed(1)}°F`;
  }
  function fmtTideBrief(plan) {
    const seg = plan && plan.segments && plan.segments.target;
    const t = seg && seg.now && seg.now.tide && seg.now.tide.value;
    if (!t) return '—';
    const parts = [];
    if (t.next_high) parts.push(`H ${t.next_high.value != null ? t.next_high.value.toFixed(1) + 'ft' : ''}`);
    if (t.next_low)  parts.push(`L ${t.next_low.value  != null ? t.next_low.value.toFixed(1)  + 'ft' : ''}`);
    return parts.join(' / ') || '—';
  }

  function render(plan) {
    const segs = Object.keys(plan.segments || {});
    if (!segs.length) return '<div id="fishedge-briefing-drawer" class="open"><div class="bd-section">No segments.</div></div>';
    const first = segs[0];
    const segmentPanels = segs.map(k =>
      `<div class="bd-segment-panel" data-segment="${k}" style="display:${k === first ? 'block' : 'none'}">
        ${renderSegmentSection(plan.segments[k])}
        ${renderTimeline(plan.segments[k])}
        ${renderObsVsModel(plan.segments[k])}
      </div>`
    ).join('');
    return `
      <div id="fishedge-briefing-drawer">
        ${renderHeader(plan)}
        ${renderAlerts(plan)}
        <div class="bd-tabs">${renderTabs(plan)}</div>
        ${segmentPanels}
        <div class="bd-disclaimer">Decision support only. Not a substitute for official marine forecasts, notices, seamanship, or Coast Guard guidance.</div>
      </div>
    `;
  }

  function mount(plan, { host, onClose } = {}) {
    if (typeof document === 'undefined') return;
    if (!document.getElementById('__fishedge_briefing_drawer_style__')) {
      const s = document.createElement('style');
      s.id = '__fishedge_briefing_drawer_style__';
      s.textContent = DRAWER_CSS;
      document.head.appendChild(s);
    }
    const root = host || document.body;
    const old = document.getElementById('fishedge-briefing-drawer');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.innerHTML = render(plan);
    root.appendChild(wrap.firstElementChild);

    const el = document.getElementById('fishedge-briefing-drawer');
    el.classList.add('open');

    el.querySelectorAll('.bd-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        el.querySelectorAll('.bd-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const key = btn.getAttribute('data-segment');
        el.querySelectorAll('.bd-segment-panel').forEach(p => {
          p.style.display = p.getAttribute('data-segment') === key ? 'block' : 'none';
        });
      });
    });
    el.querySelector('.bd-close').addEventListener('click', () => {
      el.classList.remove('open');
      if (typeof onClose === 'function') onClose();
    });
    return el;
  }

  function open(plan, opts) {
    const el = mount(plan, opts);
    if (el) el.classList.add('open');
    return el;
  }
  function close() {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('fishedge-briefing-drawer');
    if (el) el.classList.remove('open');
  }

  const api = Object.freeze({ render, mount, open, close, DRAWER_CSS });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FishEdgeTripPlannerUI = Object.assign(global.FishEdgeTripPlannerUI || {}, { BriefingDrawer: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
