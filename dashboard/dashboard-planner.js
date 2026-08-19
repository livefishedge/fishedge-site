/*!
 * Dashboard planner overlay — runs on the dashboard page only.
 * Wires the Map | Planner tab bar (in #toolbar) to a full-screen planner
 * overlay. Backbone + UI scripts are preloaded in <head>; this file just
 * toggles the view and mounts the planner on first Planner-tab activation.
 *
 * Loaded by dashboard/index.html with cache-bust v=20260819-1.
 */
(function attachDashboardPlanner(global) {
  'use strict';

  function setView(view) {
    if (view !== 'map' && view !== 'planner') return;
    document.body.classList.toggle('fishedge-view-planner', view === 'planner');
    document.querySelectorAll('.vt-tab').forEach((t) => {
      const active = t.dataset.view === view;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const overlay = document.getElementById('fishedge-planner-overlay');
    if (overlay) overlay.setAttribute('aria-hidden', view === 'planner' ? 'false' : 'true');
    if (view === 'planner' && !global.__FISHEDGE_PLANNER_MOUNTED__) {
      mountPlanner();
    }
  }

  function failVisible(host, where, err) {
    if (!host) return;
    host.innerHTML = '<div style="padding:16px;color:#ff6b6b;font:14px-system-ui;background:#1a0808;border:1px solid #ff6b6b;border-radius:6px;">'
      + '<strong>Trip Planner failed at ' + where + ':</strong> ' + (err && err.message ? err.message : String(err))
      + '</div>';
  }

  function mountPlanner() {
    const Tp  = global.FishEdgeTripPlanner;
    const UI  = global.FishEdgeTripPlannerUI || {};
    const Dec = global.TripDecisionEngine;
    const Rec = global.TripReconciler;
    const Fx  = global.FishEdgeTripPlannerFixtures;
    const Sto = global.FishEdgeTripStorage;

    const failAt = (where, err) => failVisible(document.getElementById('fishedge-five-day-outlook'), where, err);

    if (!Tp || !UI.InletPicker || !UI.FiveDayOutlook || !UI.CompactStrip || !UI.BriefingDrawer || !UI.MyTripsSidebar || !Dec || !Rec || !Fx) {
      console.warn('[dashboard-planner] backbone missing');
      failAt('backbone-check', new Error('Tp/UI/Dec/Rec/Fx not all loaded'));
      return;
    }

    function buildFixturePlan(fixName, inletKey) {
      const fix = Fx.FIXTURES[fixName];
      const inletMeta = (global.CoopsTides.INLET_STATION_TABLE && global.CoopsTides.INLET_STATION_TABLE[inletKey])
        || { station_id: '8570283', label: 'Ocean City Inlet, MD', lat: 38.3286, lon: -75.0919 };
      const adapter = Tp.buildTripPlannerAdapter({
        home_inlet: { id: inletKey || 'ocean-city-md', label: inletMeta.label, lonlat: [inletMeta.lon, inletMeta.lat] },
        target:     { id: 'cigar-minus-15',         label: 'Cigar — 15 nm SE', lonlat: [inletMeta.lon + 0.30, inletMeta.lat - 0.20] },
        departure_iso: '2026-08-19T04:00:00-04:00',
        return_iso:    '2026-08-19T14:00:00-04:00',
        tz: 'America/New_York',
      });
      const obs44009 = global.NdbcRealtime.parseRow(fix.ndbc_44009_recent[0], '44009');
      const obs44084 = global.NdbcRealtime.parseRow(fix.ndbc_44084_recent[0], '44084');
      const seg44009 = global.NdbcRealtime.obsToNowSegment(obs44009, global.NdbcRealtime.STATION_TABLE['44009'], [fix.lon, fix.lat]);
      const seg44084 = global.NdbcRealtime.obsToNowSegment(obs44084, global.NdbcRealtime.STATION_TABLE['44084'], [fix.lon, fix.lat]);
      if (seg44009 && seg44009.wind)    adapter.segments.target.now.wind    = seg44009.wind;
      if (seg44009 && seg44009.pressure) adapter.segments.target.now.pressure = seg44009.pressure;
      if (seg44084 && seg44084.wave)    adapter.segments.target.now.wave    = seg44084.wave;
      if (seg44084 && seg44084.water_temperature) adapter.segments.target.now.water_temperature = seg44084.water_temperature;
      if (fix.open_meteo_marine_first_row) {
        const row = global.OpenMeteoMarine.parseHourly({
          hourly: {
            time: [fix.open_meteo_marine_first_row.time],
            wave_height:      [fix.open_meteo_marine_first_row.wave_height],
            wave_direction:   [fix.open_meteo_marine_first_row.wave_direction],
            wave_period:      [fix.open_meteo_marine_first_row.wave_period],
            wind_wave_height: [fix.open_meteo_marine_first_row.wind_wave_height],
            swell_wave_height:  [fix.open_meteo_marine_first_row.swell_wave_height],
            swell_wave_period:  [fix.open_meteo_marine_first_row.swell_wave_period],
            swell_wave_direction:[fix.open_meteo_marine_first_row.swell_wave_direction],
          },
          timezone: 'America/New_York',
          timezone_abbreviation: 'EDT',
          utc_offset_seconds: -14400,
        }, 'EDT', -14400);
        adapter.segments.target.trip_window.hourly = row.map(r => Object.assign({ iso: r.iso.replace(/-\d{2}:\d{2}$/, '-04:00') }, r));
        adapter.segments.target.trip_window.worst_window = Rec.worstWindow(adapter.segments.target.trip_window.hourly);
        adapter.segments.target.trip_window.obs_vs_model_disagreement = Rec.reconcile(
          { wind: adapter.segments.target.now.wind && adapter.segments.target.now.wind.value,
            wave: adapter.segments.target.now.wave && adapter.segments.target.now.wave.value },
          adapter.segments.target.trip_window.hourly[0],
        );
      }
      const alerts = global.NwsAlerts.normalizeAlerts(fix.nws_alerts_active, fix.lat, fix.lon);
      for (const k of Object.keys(adapter.segments)) adapter.segments[k].alerts = alerts;
      Dec.evaluateTripPlan(adapter);
      return adapter;
    }

    function build5DayPlans(fixName, inletKey) {
      const today = buildFixturePlan(fixName, inletKey);
      const plans = [today];
      for (let i = 1; i < 5; i++) {
        const clone = JSON.parse(JSON.stringify(today));
        const hourly = clone.segments.target.trip_window.hourly;
        if (hourly && hourly.length) {
          const factor = 1.0 + (i * 0.25);
          for (const r of hourly) {
            if (r.wave_height != null) r.wave_height = +(r.wave_height * factor).toFixed(1);
            if (r.wind_gust    != null) r.wind_gust    = +(r.wind_gust * factor).toFixed(1);
          }
          clone.segments.target.trip_window.worst_window = Rec.worstWindow(hourly);
        }
        Dec.evaluateTripPlan(clone);
        plans.push(clone);
      }
      return plans;
    }

    function openBriefing(plan) {
      UI.BriefingDrawer.open(plan, { host: document.getElementById('fishedge-briefing-host'), onClose: () => {} });
    }

    let currentPlans;
    let picker;

    try {
      picker = UI.InletPicker.mount(document.getElementById('fishedge-inlet-picker'), {
        initialInlet: Sto.getSavedInlet() || 'ocean-city-md',
        onChange: (inletKey) => { Sto.setSavedInlet(inletKey); rebuild(); },
        onSave:   (tripPlan) => { Sto.saveTrip(tripPlan); rebuildMyTrips(); },
      });
    } catch (e) { failAt('InletPicker.mount', e); throw e; }

    function rebuild() {
      currentPlans = build5DayPlans('ocean_city_normal', picker.getInlet());
      UI.FiveDayOutlook.render(document.getElementById('fishedge-five-day-outlook'), currentPlans, {
        onDayClick: (idx) => openBriefing(currentPlans[idx]),
      });
      UI.CompactStrip.mount(document.getElementById('fishedge-compact-strip-host'), {
        plan: currentPlans[0],
        onOpen: () => openBriefing(currentPlans[0]),
      });
    }

    function rebuildMyTrips() {
      UI.MyTripsSidebar.render(document.getElementById('fishedge-my-trips'), {
        trips: Sto.listTrips(),
        onLoad: (trip) => console.info('[planner] load trip', trip),
      });
    }

    try {
      currentPlans = build5DayPlans('ocean_city_normal', picker.getInlet());
      UI.FiveDayOutlook.render(document.getElementById('fishedge-five-day-outlook'), currentPlans, {
        onDayClick: (idx) => openBriefing(currentPlans[idx]),
      });
      UI.CompactStrip.mount(document.getElementById('fishedge-compact-strip-host'), {
        plan: currentPlans[0],
        onOpen: () => openBriefing(currentPlans[0]),
      });
      rebuildMyTrips();
    } catch (e) {
      failAt('initial-render', e);
      throw e;
    }

    global.__FISHEDGE_PLANNER_DEV__ = { plans: currentPlans, picker, Sto, rebuild };
    global.__FISHEDGE_PLANNER_MOUNTED__ = true;
    console.info('[dashboard-planner] mounted', { plans: currentPlans.length });
  }

  function wireTabs() {
    document.querySelectorAll('.vt-tab').forEach((tab) => {
      tab.addEventListener('click', (e) => {
        e.preventDefault();
        setView(tab.dataset.view);
      });
    });
  }

  // Script is in <head> — wait for the body before wiring tabs.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireTabs);
  } else {
    wireTabs();
  }

  global.__fishedgeSetView = setView;
})(typeof globalThis !== 'undefined' ? globalThis : this);
