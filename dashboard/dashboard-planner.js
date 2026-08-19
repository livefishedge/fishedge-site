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

  function mountPlanner() {
    const Tp  = global.FishEdgeTripPlanner;
    const UI  = global.FishEdgeTripPlannerUI || {};
    const Dec = global.TripDecisionEngine;
    const Rec = global.TripReconciler;
    const Fx  = global.FishEdgeTripPlannerFixtures;
    const Sto = global.FishEdgeTripStorage;

    if (!Tp || !UI.InletPicker || !UI.FiveDayOutlook || !UI.CompactStrip || !UI.BriefingDrawer || !UI.MyTripsSidebar || !Dec || !Rec || !Fx) {
      console.warn('[dashboard-planner] backbone missing');
      return;
    }

    const canyonTargets = UI.InletPicker.CANYON_TARGETS || {};
    const defaultTarget = canyonTargets.baltimore_canyon_line;

    function buildFixturePlan(fixName, inletKey, targetId) {
      const fix = Fx.FIXTURES[fixName];
      const inletMeta = (global.CoopsTides.INLET_STATION_TABLE && global.CoopsTides.INLET_STATION_TABLE[inletKey])
        || { station_id: '8570283', label: 'Ocean City Inlet, MD', lat: 38.3286, lon: -75.0919 };
      const target = canyonTargets[targetId] || defaultTarget;
      const adapter = Tp.buildTripPlannerAdapter({
        home_inlet: { id: inletKey || 'ocean-city-md', label: inletMeta.label, lonlat: [inletMeta.lon, inletMeta.lat] },
        target:     Object.assign({}, target, { anchor_lonlat: target.lookup_points[0] }),
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
      if (fix.open_meteo_weather_first_row && global.OpenMeteoWeather) {
        const weather = global.OpenMeteoWeather.parseHourly({
          hourly: Object.fromEntries(Object.entries({
            time: [fix.open_meteo_weather_first_row.time],
            wind_speed_10m: [fix.open_meteo_weather_first_row.wind_speed_10m],
            wind_gusts_10m: [fix.open_meteo_weather_first_row.wind_gusts_10m],
            wind_direction_10m: [fix.open_meteo_weather_first_row.wind_direction_10m],
            pressure_msl: [fix.open_meteo_weather_first_row.pressure_msl],
            relative_humidity_2m: [fix.open_meteo_weather_first_row.relative_humidity_2m],
            visibility: [fix.open_meteo_weather_first_row.visibility],
            precipitation: [fix.open_meteo_weather_first_row.precipitation],
            weather_code: [fix.open_meteo_weather_first_row.weather_code],
          }).filter(([, values]) => values[0] != null)),
        });
        const row = weather[0];
        if (row) {
          const source = row.source;
          adapter.segments.target.now.visibility = { value: row.visibility_nm, source, freshness: row.freshness };
          adapter.segments.target.now.precipitation = { value: row.precipitation, source, freshness: row.freshness };
          adapter.segments.target.now.weather_code = { value: row.weather_code, source, freshness: row.freshness };
        }
      }
      const alerts = global.NwsAlerts.normalizeAlerts(fix.nws_alerts_active, target.lookup_points[0][1], target.lookup_points[0][0]);
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
    } catch (e) { console.error('[dashboard-planner] InletPicker.mount failed:', e); throw e; }

    function rebuild() {
      currentPlans = build5DayPlans('ocean_city_normal', picker.getInlet(), picker.getSnapshot().target_id);
      UI.FiveDayOutlook.mount(document.getElementById('fishedge-five-day-outlook'), currentPlans, {
        onDayClick: (idx) => openBriefing(currentPlans[idx]),
      });
      // CompactStrip API: mount(plan, { onOpen, host })
      UI.CompactStrip.mount(currentPlans[0], {
        onOpen: () => openBriefing(currentPlans[0]),
        host: document.getElementById('fishedge-compact-strip-host'),
      });
    }

    function rebuildMyTrips() {
      // MyTripsSidebar API: mount(host, opts)
      UI.MyTripsSidebar.mount(document.getElementById('fishedge-my-trips'), {
        trips: Sto.listTrips(),
        onLoad: (trip) => console.info('[planner] load trip', trip),
      });
    }

    try {
      currentPlans = build5DayPlans('ocean_city_normal', picker.getInlet(), picker.getSnapshot().target_id);
      UI.FiveDayOutlook.mount(document.getElementById('fishedge-five-day-outlook'), currentPlans, {
        onDayClick: (idx) => openBriefing(currentPlans[idx]),
      });
      UI.CompactStrip.mount(currentPlans[0], {
        onOpen: () => openBriefing(currentPlans[0]),
        host: document.getElementById('fishedge-compact-strip-host'),
      });
      rebuildMyTrips();
    } catch (e) {
      console.error('[dashboard-planner] initial-render failed:', e);
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

    // Initial view from URL param (?view=planner or ?view=map) so the
    // homepage Planner link can deep-link straight to the planner tab.
    try {
      const params = new URLSearchParams(window.location.search);
      const view = params.get('view');
      if (view === 'planner' || view === 'map') {
        setView(view);
      }
    } catch (e) {
      console.warn('[dashboard-planner] URL param parse failed:', e);
    }
  }

  // Script is in <head> — wait for the body before wiring tabs.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireTabs);
  } else {
    wireTabs();
  }

  global.__fishedgeSetView = setView;
})(typeof globalThis !== 'undefined' ? globalThis : this);
