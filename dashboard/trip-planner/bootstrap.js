/*!
 * Trip Planner bootstrap — wires the adapter skeleton, fixtures, and UI
 * together for the dev preview. Mounts the compact strip and briefing
 * drawer against a captured fixture so the captain-facing surface can
 * be evaluated without live network calls.
 *
 * For the live build (Phase 4+), replace the fixture loader with real
 * Promise.all() calls into the Open-Meteo / NDBC / CO-OPS / NWS adapters.
 * That swap is a single function change — the contract is stable.
 */
(function attachBootstrap(global) {
  'use strict';
  const Tp  = global.FishEdgeTripPlanner;
  const UI  = global.FishEdgeTripPlannerUI || {};
  const Dec = global.TripDecisionEngine;
  const Rec = global.TripReconciler;
  const Fx  = global.FishEdgeTripPlannerFixtures;

  if (!Tp || !UI.CompactStrip || !UI.BriefingDrawer || !Dec || !Rec || !Fx) {
    // Adapters not all loaded yet — defer.
    return;
  }

  const OCEAN_CITY = {
    home_inlet: {
      id: 'ocean-city-md',
      label: 'Ocean City Inlet, MD',
      lonlat: [-75.0919, 38.3302],
    },
    target: {
      id: 'cigar-minus-15',
      label: 'Cigar — 15 nm SE',
      lonlat: [-74.8, 38.1],
    },
    departure_iso: '2026-08-19T04:00:00-04:00',
    return_iso:    '2026-08-19T14:00:00-04:00',
    tz: 'America/New_York',
  };

  function buildFixturePlan(fixName) {
    const fix = Fx.FIXTURES[fixName];
    const adapter = Tp.buildTripPlannerAdapter(OCEAN_CITY);
    // Wire NDBC observed-wave from fixture into target segment.
    const obs44009 = global.NdbcRealtime.parseRow(fix.ndbc_44009_recent[0], '44009');
    const obs44084 = global.NdbcRealtime.parseRow(fix.ndbc_44084_recent[0], '44084');
    const seg44009 = global.NdbcRealtime.obsToNowSegment(obs44009, global.NdbcRealtime.STATION_TABLE['44009'], [fix.lon, fix.lat]);
    const seg44084 = global.NdbcRealtime.obsToNowSegment(obs44084, global.NdbcRealtime.STATION_TABLE['44084'], [fix.lon, fix.lat]);
    if (seg44009 && seg44009.wind)    adapter.segments.target.now.wind    = seg44009.wind;
    if (seg44009 && seg44009.pressure) adapter.segments.target.now.pressure = seg44009.pressure;
    if (seg44084 && seg44084.wave)    adapter.segments.target.now.wave    = seg44084.wave;
    if (seg44084 && seg44084.water_temperature) adapter.segments.target.now.water_temperature = seg44084.water_temperature;
    // Wire the model hourly for target (one row) + reconcile against obs.
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
    // Alerts (same across segments in MVP).
    const alerts = global.NwsAlerts.normalizeAlerts(fix.nws_alerts_active, fix.lat, fix.lon);
    for (const k of Object.keys(adapter.segments)) adapter.segments[k].alerts = alerts;
    Dec.evaluateTripPlan(adapter);
    return adapter;
  }

  const plan = buildFixturePlan('ocean_city_normal');

  function mount() {
    UI.CompactStrip.mount(plan, { onOpen: () => UI.BriefingDrawer.open(plan, { onClose: () => {} }) });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  // Expose for ad-hoc inspection.
  global.__FISHEDGE_TRIP_PLANNER_DEV__ = { plan, buildFixturePlan, OCEAN_CITY };
})(typeof globalThis !== 'undefined' ? globalThis : this);
