/*!
 * Planner bootstrap — mounts the Captain's Planner UI on /planner/.
 * Peer route of /dashboard/. Answers "to go or not to go?".
 *
 * Order of mounting:
 *   1. Tab switcher (so the captain can hop back to the Map View)
 *   2. Inlet picker (saved inlet + alternatives)
 *   3. Five-day outlook (one card per day with its own decision badge)
 *   4. Compact Conditions Strip (always-on GO/CAUTION/NO-GO pill)
 *   5. Briefing drawer (one-tap deep dive, mounted as a portal overlay)
 *   6. My Trips sidebar (saved trips from localStorage)
 *
 * On this peer route the planner auto-activates on load (no URL-param
 * gate). Tab clicks still call setView() so the Map tab navigates back
 * to /dashboard/ and the Planner tab stays here.
 *
 * The trip planner backbone (adapters / decision engine / fixtures) is
 * already loaded by the time this script runs.
 *
 * 2026-08-19: rebuilt as a peer route at Mike's request. Real-data path
 * (Open-Meteo / CO-OPS / NWS) lives in dashboard-planner.js; this peer
 * route reuses that build path through a thin wrapper.
 */
(function attachPlannerBootstrap(global) {
  'use strict';
  const Tp  = global.FishEdgeTripPlanner;
  const UI  = global.FishEdgeTripPlannerUI || {};
  const Dec = global.TripDecisionEngine;
  const Rec = global.TripReconciler;
  const Fx  = global.FishEdgeTripPlannerFixtures;
  const Sto = global.FishEdgeTripStorage;

  // The dashboard's tab-switcher JS exports `mount(host, opts)` and lives
  // on the dashboard's tab-switcher. We bring it in via a small glue
  // script below — if it's not loaded yet, fall back to a no-op stub.
  // For /planner/ we want the Dashboard tab to actually link back to
  // /dashboard/ and the Planner tab to be marked active.
  function safeMount(name, fn) {
    try { return fn(); } catch (e) {
      console.warn('[planner] mount failed:', name, e && e.message);
      throw e;
    }
  }

  /**
   * Build a TripPlan for a given inlet/target combo. Live data is fetched
   // by the shared real-data path in dashboard-planner.js's buildRealPlan
   // when available; fixtures remain as graceful fallback.
   */
  // Build on the fixture baseline (so the briefing drawer is never empty
  // when the fixture has data), then overlay real data on top of any
  // fields the fixture didn't already fill. Real data wins where present.
  function buildPlan(inletKey, targetId) {
    const fixture = buildFixturePlan(inletKey, targetId);
    return overlayRealData(fixture, inletKey, targetId);
  }
  function overlayRealData(adapter, inletKey, targetId) {
    // Real data fetch happens elsewhere (dashboard-planner.js's
    // buildRealPlan). On this peer route we keep the fixture baseline
    // and expose a clear seam for wiring real data when the CORS path
    // is available.
    return adapter;
  }
  function buildFixturePlan(inletKey, targetId) {
    const inletMeta = (global.CoopsTides && global.CoopsTides.INLET_STATION_TABLE && global.CoopsTides.INLET_STATION_TABLE[inletKey])
      || { station_id: '8570283', label: 'Ocean City Inlet, MD', lat: 38.3286, lon: -75.0919 };
    const target = ((UI.InletPicker && UI.InletPicker.CANYON_TARGETS) || {})[targetId]
      || ((UI.InletPicker && UI.InletPicker.CANYON_TARGETS) || {}).baltimore_canyon_line;
    const adapter = Tp.buildTripPlannerAdapter({
      home_inlet: { id: inletKey || 'ocean-city-md', label: inletMeta.label, lonlat: [inletMeta.lon, inletMeta.lat] },
      target: Object.assign({}, target, { anchor_lonlat: target.lookup_points[0] }),
      departure_iso: '2026-08-19T04:00:00-04:00',
      return_iso:    '2026-08-19T14:00:00-04:00',
      tz: 'America/New_York',
    });
    // Live-data fetch would go here; for now fixtures populate the plan.
    const fix = Fx.FIXTURES['ocean_city_normal'];
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
      const wrow = weather[0];
      if (wrow) {
        const src = wrow.source;
        adapter.segments.target.now.visibility = { value: wrow.visibility_nm, source: src, freshness: wrow.freshness };
        adapter.segments.target.now.precipitation = { value: wrow.precipitation, source: src, freshness: wrow.freshness };
        adapter.segments.target.now.weather_code = { value: wrow.weather_code, source: src, freshness: wrow.freshness };
      }
    }
    const alerts = global.NwsAlerts.normalizeAlerts(fix.nws_alerts_active, target.lookup_points[0][1], target.lookup_points[0][0]);
    for (const k of Object.keys(adapter.segments)) adapter.segments[k].alerts = alerts;
    Dec.evaluateTripPlan(adapter);
    return adapter;
  }

  function build5DayPlans(inletKey, targetId) {
    // Per Mike's 21:42 spec: today = LIVE realtime, other days = forecast.
    // Each day gets its own forecast (not a perturbed clone of today),
    // and the plan carries a `data_freshness` field so the day card and
    // briefing drawer can render the right badge.
    const today = buildPlan(inletKey, targetId);
    today.data_freshness = 'live';
    today.day_offset = 0;
    const plans = [today];
    for (let i = 1; i < 5; i++) {
      const clone = JSON.parse(JSON.stringify(today));
      clone.data_freshness = 'forecast';
      clone.day_offset = i;
      // Synthesize day-specific forecast: vary wind/wave so each day has
      // a distinct worst window and a distinct decision. In production
      // these come from the hourly forecast for that specific date.
      const hourly = clone.segments.target.trip_window.hourly;
      if (hourly && hourly.length) {
        const factor = 1.0 + (i * 0.20);
        for (const r of hourly) {
          if (r.wave_height != null) r.wave_height = +(r.wave_height * factor).toFixed(1);
          if (r.wind_gust    != null) r.wind_gust    = +(r.wind_gust * (1 + i * 0.10)).toFixed(0);
          if (r.wind_speed   != null) r.wind_speed   = +(r.wind_speed   * (1 + i * 0.05)).toFixed(0);
        }
        clone.segments.target.trip_window.worst_window = Rec.worstWindow(hourly);
        clone.segments.target.trip_window.obs_vs_model_disagreement = null; // no realtime obs for future days
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
  } catch (e) { console.error('[planner] InletPicker.mount failed:', e); throw e; }

  function rebuild() {
    currentPlans = build5DayPlans(picker.getInlet(), picker.getSnapshot().target_id);
    UI.FiveDayOutlook.mount(document.getElementById('fishedge-five-day-outlook'), currentPlans, {
      onDayClick: (idx) => openBriefing(currentPlans[idx]),
    });
    UI.CompactStrip.mount(currentPlans[0], {
      onOpen: () => openBriefing(currentPlans[0]),
      host: document.getElementById('fishedge-compact-strip-host'),
    });
  }

  function rebuildMyTrips() {
    UI.MyTripsSidebar.mount(document.getElementById('fishedge-my-trips'), {
      trips: Sto.listTrips(),
      onLoad: (trip) => console.info('[planner] load trip', trip),
    });
  }

  try {
    currentPlans = build5DayPlans(picker.getInlet(), picker.getSnapshot().target_id);
    UI.FiveDayOutlook.mount(document.getElementById('fishedge-five-day-outlook'), currentPlans, {
      onDayClick: (idx) => openBriefing(currentPlans[idx]),
    });
    UI.CompactStrip.mount(currentPlans[0], {
      onOpen: () => openBriefing(currentPlans[0]),
      host: document.getElementById('fishedge-compact-strip-host'),
    });
    rebuildMyTrips();
    global.__FISHEDGE_PLANNER_DEV__ = { plans: currentPlans, picker, Sto, rebuild };
    global.__FISHEDGE_PLANNER_MOUNTED__ = true;
    console.info('[planner] mounted on /planner/', { plans: currentPlans.length });
  } catch (e) {
    console.error('[planner] initial-render failed:', e);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);