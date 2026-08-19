/*!
 * Planner bootstrap — mounts the Captain's Planner UI on /planner/.
 * Peer of /dashboard/. Answers "to go or not to go?".
 *
 * Order of mounting:
 *   1. Tab switcher (so the captain can hop back to the Map View)
 *   2. Inlet picker (saved inlet + alternatives)
 *   3. Five-day outlook (one card per day with its own decision badge)
 *   4. Compact Conditions Strip (always-on GO/CAUTION/NO-GO pill)
 *   5. Briefing drawer (one-tap deep dive, mounted as a portal overlay)
 *   6. My Trips sidebar (saved trips from localStorage)
 *
 * The trip planner backbone (adapters / decision engine / fixtures) is
 * already loaded by the time this script runs.
 */
(function attachPlannerBootstrap(global) {
  'use strict';
  const Tp  = global.FishEdgeTripPlanner;
  const UI  = global.FishEdgeTripPlannerUI || {};
  const Dec = global.TripDecisionEngine;
  const Rec = global.TripReconciler;
  const Fx  = global.FishEdgeTripPlannerFixtures;
  const Sto = global.FishEdgeTripStorage;

  if (!Tp || !UI.TabSwitcher || !UI.InletPicker || !UI.FiveDayOutlook || !UI.CompactStrip || !UI.BriefingDrawer || !UI.MyTripsSidebar || !Dec || !Rec || !Fx) {
    // Backbone not loaded yet — defer.
    console.warn('[planner] backbone missing — deferring');
    return;
  }

  /**
   * Build a TripPlan for a given inlet/target combo. Currently fixture-driven;
   * Phase 4 will swap this for live Promise.all() into the adapters.
   */
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

  /**
   * For the 5-day outlook, we reuse the same fixture as a "now" anchor and
   * synthesize the next 4 days by repeating it with a slight perturbation
   * to demonstrate the timeline component. Phase 4 will replace this with
   * a real 5-day Open-Meteo forecast.
   */
  function build5DayPlans(fixName, inletKey) {
    const today = buildFixturePlan(fixName, inletKey);
    const plans = [today];
    for (let i = 1; i < 5; i++) {
      // Clone and perturb so each day renders a different verdict band.
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
      // Re-evaluate decision engine after perturbation.
      Dec.evaluateTripPlan(clone);
      plans.push(clone);
    }
    return plans;
  }

  // ----- Mount order -----

  // 1. Tab switcher
  UI.TabSwitcher.mount(document.getElementById('fishedge-tab-switcher'), {
    active: 'planner',
    meta:   { departure: 'Tue 4 AM', inlet: 'Ocean City, MD' },
  });

  // 2. Inlet picker
  const picker = UI.InletPicker.mount(document.getElementById('fishedge-inlet-picker'), {
    initialInlet: Sto.getSavedInlet() || 'ocean-city-md',
    onChange: (inletKey) => {
      Sto.setSavedInlet(inletKey);
      rebuild();
    },
    onSave: (tripPlan) => {
      Sto.saveTrip(tripPlan);
      rebuildMyTrips();
    },
  });

  let currentPlans = build5DayPlans('ocean_city_normal', picker.getInlet());

  function rebuild() {
    currentPlans = build5DayPlans('ocean_city_normal', picker.getInlet());
    UI.FiveDayOutlook.render(document.getElementById('fishedge-five-day-outlook'), currentPlans, {
      onDayClick: (idx) => UI.BriefingDrawer.open(currentPlans[idx], { host: document.getElementById('fishedge-briefing-host'), onClose: () => {} }),
    });
    UI.CompactStrip.mount(document.getElementById('fishedge-compact-strip-host'), {
      plan: currentPlans[0],
      onOpen: () => UI.BriefingDrawer.open(currentPlans[0], { host: document.getElementById('fishedge-briefing-host'), onClose: () => {} }),
    });
  }

  function rebuildMyTrips() {
    UI.MyTripsSidebar.render(document.getElementById('fishedge-my-trips'), {
      trips: Sto.listTrips(),
      onLoad: (trip) => {
        // Phase 4: hydrate from saved trip; for now, just show a console marker.
        console.info('[planner] load trip', trip);
      },
    });
  }

  // 3. Five-day outlook (initial)
  UI.FiveDayOutlook.render(document.getElementById('fishedge-five-day-outlook'), currentPlans, {
    onDayClick: (idx) => UI.BriefingDrawer.open(currentPlans[idx], { host: document.getElementById('fishedge-briefing-host'), onClose: () => {} }),
  });

  // 4. Compact Conditions Strip
  UI.CompactStrip.mount(document.getElementById('fishedge-compact-strip-host'), {
    plan: currentPlans[0],
    onOpen: () => UI.BriefingDrawer.open(currentPlans[0], { host: document.getElementById('fishedge-briefing-host'), onClose: () => {} }),
  });

  // 6. My Trips sidebar
  rebuildMyTrips();

  // Expose for ad-hoc inspection.
  global.__FISHEDGE_PLANNER_DEV__ = { plans: currentPlans, picker, Sto, rebuild };
})(typeof globalThis !== 'undefined' ? globalThis : this);