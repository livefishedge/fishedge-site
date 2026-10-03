/*!
 * Dashboard planner overlay — runs on the dashboard page only.
 * Wires the Map | Planner tab bar (in #toolbar) to a full-screen planner
 * overlay. Backbone + UI scripts are preloaded in <head>; this file just
 * toggles the view and mounts the planner on first Planner-tab activation.
 *
 * Loaded by dashboard/index.html with cache-bust v=20260819-1.
 *
 * Real-data build (2026-08-19): planner now calls live public APIs
 * (Open-Meteo Marine, Open-Meteo Weather, CO-OPS Tides, NWS Alerts) via
 * the existing adapters. Fixtures remain as a graceful fallback when
 * a network fetch fails.
 */
(function attachDashboardPlanner(global) {
  'use strict';

  function setView(view) {
    if (view !== 'map' && view !== 'planner') return;
    // Region selection is resolved by dashboard/index.html. Publish a small
    // shared adapter value so the lazily mounted Planner never guesses MD.
    global.__FISHEDGE_ACTIVE_REGION = global.REGION_ID === 'usec_south' ? 'usec_south' : 'usec_md';
    document.body.classList.toggle('fishedge-view-planner', view === 'planner');
    document.querySelectorAll('.vt-tab').forEach((t) => {
      const active = t.dataset.view === view;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    const overlay = document.getElementById('fishedge-planner-overlay');
    if (overlay) overlay.setAttribute('aria-hidden', view === 'planner' ? 'false' : 'true');
    // The dashboard has its own dashboardChrome.hamburger.style.display = 'block'
    // path (lines ~3241 in dashboard.html) that runs AFTER setView and re-shows
    // the hamburger regardless of CSS or inline-style !important. The only thing
    // that beats that is removing the element from the DOM entirely. Pair with
    // a MutationObserver below to catch any re-add by the dashboard's chrome JS.
    //
    // IMPORTANT: there are TWO hamburger-style buttons — #hamburger-btn (the
    // product-menu one, target of the dashboardChrome code) AND
    // #combined-menu-btn (the sidebar toggle Mike actually sees). Hide both.
    function hideDashboardHamburger(btn) {
      if (btn && !btn.dataset.removedByPlanner) {
        btn.dataset.removedByPlanner = '1';
        btn.parentNode.removeChild(btn);
      }
    }
    function restoreDashboardHamburger(btn) {
      if (btn && btn.dataset.removedByPlanner) {
        delete btn.dataset.removedByPlanner;
        document.body.appendChild(btn);
      }
    }
    const hamburgerIds = ['hamburger-btn', 'combined-menu-btn'];
    hamburgerIds.forEach((id) => {
      const btn = document.getElementById(id);
      if (view === 'planner') hideDashboardHamburger(btn);
      else restoreDashboardHamburger(btn);
    });
    // Set up the observer once. It only acts when the planner is active.
    if (!global.__fishedgeHamburgerObserver) {
      global.__fishedgeHamburgerObserver = new MutationObserver(() => {
        if (!document.body.classList.contains('fishedge-view-planner')) return;
        hamburgerIds.forEach((id) => hideDashboardHamburger(document.getElementById(id)));
      });
      global.__fishedgeHamburgerObserver.observe(document.body, { childList: true, subtree: true });
    }
    if (view === 'planner' && !global.__FISHEDGE_PLANNER_MOUNTED__) {
      mountPlanner();
    }
  }

  // ===========================================================================
  // Real-data fetchers — CORS-friendly public APIs. Each returns null on
  // any failure (network, CORS, parse) so the caller can fall back gracefully.
  // ===========================================================================

  // CORS proxy: dev branch preview is on *.pages.dev which Open-Meteo /
  // CO-OPS / NWS CORS configs don't accept. Route through corsproxy.io
  // (free public CORS proxy) so the browser preflight succeeds.
  const CORS_PROXY = 'https://corsproxy.io/?';

  async function fetchJson(url) {
    try {
      const r = await fetch(CORS_PROXY + encodeURIComponent(url), { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      console.warn('[planner] fetch failed:', url, e && e.message);
      return null;
    }
  }

  async function fetchOpenMeteoMarine(lat, lon) {
    return fetchJson(
      'https://marine-api.open-meteo.com/v1/marine'
      + '?latitude=' + lat + '&longitude=' + lon
      + '&hourly=wave_height,wave_direction,wave_period,wind_wave_height,wind_wave_direction,wind_wave_period,swell_wave_height,swell_wave_direction,swell_wave_period'
      + '&timezone=America%2FNew_York&forecast_days=5'
    );
  }

  async function fetchOpenMeteoWeather(lat, lon) {
    return fetchJson(
      'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + lat + '&longitude=' + lon
      + '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,temperature_2m,visibility,precipitation,weather_code'
      + '&timezone=America%2FNew_York&forecast_days=5'
    );
  }

  async function fetchCoopsTides(stationId) {
    const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
    const begin = fmt(new Date());
    const end   = fmt(new Date(Date.now() + 5 * 86400 * 1000));
    return fetchJson(
      'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
      + '?station=' + stationId
      + '&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json'
      + '&begin_date=' + begin + '&end_date=' + end + '&interval=hilo'
    );
  }

  async function fetchNwsAlerts(lat, lon) {
    return fetchJson('https://api.weather.gov/alerts/active?point=' + lat + ',' + lon);
  }

  function dirDegToCardinal(deg) {
    if (deg == null) return null;
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  }

  async function buildRealPlan(inletKey, targetId) {
    const UI = global.FishEdgeTripPlannerUI || {};
    const activeRegion = global.__FISHEDGE_ACTIVE_REGION || 'usec_md';
    const canyonTargets = UI.InletPicker && (UI.InletPicker.getTargets ? UI.InletPicker.getTargets(activeRegion) : UI.InletPicker.CANYON_TARGETS) || {};
    const inletMeta = global.CoopsTides && global.CoopsTides.INLET_STATION_TABLE && global.CoopsTides.INLET_STATION_TABLE[inletKey];
    const target = canyonTargets[targetId];
    if (activeRegion === 'usec_south' && (!inletMeta || !target)) {
      console.warn('[planner] South selection has no regional station/target mapping', { inletKey, targetId });
      return null;
    }
    // A missing regional mapping is unavailable data, not permission to use
    // an Ocean City fixture or another region's station.
    const safeInletMeta = inletMeta;
    const safeTarget = target;
    if (!safeInletMeta || !safeTarget || !safeTarget.lookup_points || !safeTarget.lookup_points.length) return null;

    // Show "fetching live conditions" message in the 5-day slot while we wait.
    const outlookHost = document.getElementById('fishedge-five-day-outlook');
    if (outlookHost) outlookHost.innerHTML = '<div class="fdo-loading">Fetching live conditions from Open-Meteo, CO-OPS, NWS…</div>';

    const [marine, weather, tides, alertsRaw] = await Promise.all([
      fetchOpenMeteoMarine(safeInletMeta.lat, safeInletMeta.lon),
      fetchOpenMeteoWeather(safeInletMeta.lat, safeInletMeta.lon),
      fetchCoopsTides(safeInletMeta.station_id),
      fetchNwsAlerts(safeInletMeta.lat, safeInletMeta.lon),
    ]);
    console.info('[planner] real-data fetch results:', {
      inlet: inletKey,
      marine: marine ? 'OK (' + (marine.hourly && marine.hourly.time && marine.hourly.time.length) + ' hours)' : 'FAILED',
      weather: weather ? 'OK (' + (weather.hourly && weather.hourly.time && weather.hourly.time.length) + ' hours)' : 'FAILED',
      tides: tides && tides.predictions ? 'OK (' + tides.predictions.length + ' rows)' : 'FAILED',
      alerts: alertsRaw && alertsRaw.features ? 'OK (' + alertsRaw.features.length + ')' : 'FAILED',
    });

    // Need at least one source; callers fail closed when live data is absent.
    if (!marine && !weather && !tides && !alertsRaw) return null;

    const adapter = Tp_buildTripPlannerAdapter({
      home_inlet: { id: inletKey || 'ocean-city-md', label: safeInletMeta.label, lonlat: [safeInletMeta.lon, safeInletMeta.lat] },
      target: Object.assign({}, safeTarget, { anchor_lonlat: safeTarget.lookup_points[0] }),
      departure_iso: '2026-08-19T04:00:00-04:00',
      return_iso:    '2026-08-19T14:00:00-04:00',
      tz: 'America/New_York',
    });

    // Open-Meteo Marine → trip_window.hourly + now.wave
    if (marine && global.OpenMeteoMarine) {
      try {
        const rows = global.OpenMeteoMarine.parseHourly(marine, 'EDT', -14400) || [];
        if (rows.length) {
          adapter.segments.target.trip_window.hourly = rows.map((r) => {
            const c = Object.assign({}, r);
            if (r.iso) c.iso = r.iso.replace(/-\d{2}:\d{2}$/, '-04:00');
            return c;
          });
          const first = rows[0];
          if (first && first.wave_height != null) {
            adapter.segments.target.now.wave = {
              value: {
                height: first.wave_height,
                dominant_period: first.wave_period,
                dir_cardinal: dirDegToCardinal(first.wave_direction),
              },
              source: { provider: 'Open-Meteo Marine', station_id: safeInletMeta.lat.toFixed(2) + ',' + safeInletMeta.lon.toFixed(2), age_minutes: 0 },
              freshness: 'MODEL_FORECAST',
            };
          }
        }
      } catch (e) { console.warn('[planner] OpenMeteoMarine parse failed:', e && e.message); }
    }

    // Open-Meteo Weather → now.wind / now.pressure / now.visibility / now.precipitation / now.weather_code
    if (weather && global.OpenMeteoWeather) {
      try {
        const wrows = global.OpenMeteoWeather.parseHourly(weather) || [];
        if (wrows[0]) {
          const w = wrows[0];
          const src = w.source || { provider: 'Open-Meteo', station_id: safeInletMeta.lat.toFixed(2) + ',' + safeInletMeta.lon.toFixed(2), age_minutes: 0 };
          const fresh = w.freshness || 'MODEL_FORECAST';
          if (w.wind_speed_kt != null) {
            adapter.segments.target.now.wind = {
              value: {
                speed: w.wind_speed_kt,
                gust:  w.wind_gust_kt,
                dir_cardinal: dirDegToCardinal(w.wind_dir_deg),
              },
              source: src, freshness: fresh,
            };
          }
          if (w.pressure_inHg != null) {
            adapter.segments.target.now.pressure = {
              value: { pressure: w.pressure_inHg },
              source: src, freshness: fresh,
            };
          }
          if (w.visibility_nm != null) {
            adapter.segments.target.now.visibility = { value: w.visibility_nm, source: src, freshness: fresh };
          }
          if (w.precipitation_mm != null) {
            adapter.segments.target.now.precipitation = { value: w.precipitation_mm, source: src, freshness: fresh };
          }
          if (w.weather_code != null) {
            adapter.segments.target.now.weather_code = { value: w.weather_code, source: src, freshness: fresh };
          }
        }
      } catch (e) { console.warn('[planner] OpenMeteoWeather parse failed:', e && e.message); }
    }

    // CO-OPS Tides → now.tide (next high / next low)
    if (tides && tides.predictions && tides.predictions.length && global.CoopsTides) {
      try {
        const trows = global.CoopsTides.parseHourly(tides, 'EDT', -14400) || [];
        if (trows.length) {
          const now = Date.now();
          let nextHigh = null, nextLow = null;
          for (let i = 0; i < trows.length; i++) {
            const t = trows[i];
            if (new Date(t.iso).getTime() < now) continue;
            if (t.type === 'H' && !nextHigh) nextHigh = t;
            else if (t.type === 'L' && !nextLow) nextLow = t;
            if (nextHigh && nextLow) break;
          }
          if (nextHigh || nextLow) {
            adapter.segments.target.now.tide = {
              value: {
                next_high: nextHigh ? { iso: nextHigh.iso, value: nextHigh.height_ft } : null,
                next_low:  nextLow  ? { iso: nextLow.iso,  value: nextLow.height_ft  } : null,
              },
              source: { provider: 'CO-OPS Tides', station_id: safeInletMeta.station_id, age_minutes: 0 },
              freshness: 'DETERMINISTIC',
            };
          }
        }
      } catch (e) { console.warn('[planner] CoopsTides parse failed:', e && e.message); }
    }

    // NWS Alerts → segment.alerts
    if (alertsRaw && global.NwsAlerts) {
      try {
        const alerts = global.NwsAlerts.normalizeAlerts(alertsRaw, safeInletMeta.lat, safeInletMeta.lon) || [];
        for (const k of Object.keys(adapter.segments)) adapter.segments[k].alerts = alerts;
      } catch (e) { console.warn('[planner] NwsAlerts parse failed:', e && e.message); }
    }

    global.TripDecisionEngine.evaluateTripPlan(adapter);
    return adapter;

    // Local alias to keep call sites readable.
    function Tp_buildTripPlannerAdapter(opts) {
      return global.FishEdgeTripPlanner.buildTripPlannerAdapter(opts);
    }
  }

  function mountPlanner() {
    const UI  = global.FishEdgeTripPlannerUI || {};
    const Dec = global.TripDecisionEngine;
    const Rec = global.TripReconciler;
    const Fx  = global.FishEdgeTripPlannerFixtures;
    const Sto = global.FishEdgeTripStorage;

    if (!global.FishEdgeTripPlanner || !UI.InletPicker || !UI.FiveDayOutlook || !UI.CompactStrip || !UI.BriefingDrawer || !UI.MyTripsSidebar || !Dec || !Rec || !Fx) {
      console.warn('[dashboard-planner] backbone missing');
      return;
    }

    const activeRegion = global.__FISHEDGE_ACTIVE_REGION || 'usec_md';
    const canyonTargets = (UI.InletPicker.getTargets ? UI.InletPicker.getTargets(activeRegion) : UI.InletPicker.CANYON_TARGETS) || {};
    const defaultTarget = canyonTargets.baltimore_canyon_line;

    // Fixture-only fallback path (real-data path is async and tried first).
    function buildFixturePlan(fixName, inletKey, targetId) {
      const fix = Fx.FIXTURES[fixName];
      const inletMeta = (global.CoopsTides.INLET_STATION_TABLE && global.CoopsTides.INLET_STATION_TABLE[inletKey])
        || { station_id: '8570283', label: 'Ocean City Inlet, MD', lat: 38.3286, lon: -75.0919 };
      const target = canyonTargets[targetId] || defaultTarget;
      const adapter = global.FishEdgeTripPlanner.buildTripPlannerAdapter({
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

    // Production path is live-data only. Fixtures remain available to the
    // isolated fixture test harness, but never become geographically false
    // operational advice when a regional request fails.
    async function buildPlan(fixName, inletKey, targetId) {
      try {
        return await buildRealPlan(inletKey, targetId);
      } catch (e) {
        console.warn('[planner] live regional data unavailable; refusing fixture fallback:', e && e.message);
        return null;
      }
    }
    function mergeRealIntoPlan(plan, real) {
      // Overlay real data onto fixture for any now.* field the real path
      // populated and the fixture left null. Real wins.
      const target = real.segments && real.segments.target;
      const planTarget = plan.segments && plan.segments.target;
      if (!target || !planTarget) return;
      const realNow = target.now || {};
      const planNow = planTarget.now || {};
      for (const k of Object.keys(realNow)) {
        if (realNow[k] != null) planNow[k] = realNow[k];
      }
      // Overlay trip_window.hourly if real has it and fixture doesn't.
      if (target.trip_window && target.trip_window.hourly && target.trip_window.hourly.length
          && (!planTarget.trip_window.hourly || !planTarget.trip_window.hourly.length)) {
        planTarget.trip_window.hourly = target.trip_window.hourly;
        planTarget.trip_window.worst_window = target.trip_window.worst_window;
      }
      // Overlay alerts if real has any.
      if (target.alerts && target.alerts.length) planTarget.alerts = target.alerts;
    }

    async function build5DayPlans(fixName, inletKey, targetId) {
      // Per Mike's 21:42 spec: today = LIVE realtime, other days = forecast.
      // Each day gets its own forecast (not a perturbed clone of today),
      // and the plan carries a `data_freshness` field so the day card and
      // briefing drawer can render the right badge.
      const today = await buildPlan(fixName, inletKey, targetId);
      if (!today) return [];
      today.data_freshness = 'live';
      today.day_offset = 0;
      const allHourly = (today.segments.target.trip_window && today.segments.target.trip_window.hourly) || [];
      const byDate = new Map();
      for (const row of allHourly) {
        const iso = row && (row.iso || row.time);
        const date = typeof iso === 'string' ? iso.slice(0, 10) : '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        if (!byDate.has(date)) byDate.set(date, []);
        byDate.get(date).push(row);
      }
      const dates = Array.from(byDate.keys()).sort().slice(0, 5);
      const plans = [];
      for (let i = 0; i < dates.length; i++) {
        const rows = byDate.get(dates[i]);
        const plan = i === 0 ? today : JSON.parse(JSON.stringify(today));
        plan.data_freshness = i === 0 ? 'live' : 'forecast';
        plan.day_offset = i;
        plan.segments.target.trip_window.hourly = rows;
        plan.segments.target.trip_window.worst_window = Rec.worstWindow(rows);
        plan.segments.target.trip_window.obs_vs_model_disagreement = i === 0
          ? plan.segments.target.trip_window.obs_vs_model_disagreement
          : null;
        Dec.evaluateTripPlan(plan);
        plans.push(plan);
      }
      return plans;
    }

    function openBriefing(plan) {
      UI.BriefingDrawer.open(plan, { host: document.getElementById('fishedge-briefing-host'), onClose: () => {} });
    }

    let currentPlans;
    let picker;

    function mountPlans(plans) {
      if (!plans || !plans.length) {
        const outlook = document.getElementById('fishedge-five-day-outlook');
        const compact = document.getElementById('fishedge-compact-strip-host');
        if (outlook) outlook.innerHTML = '<div class="fdo-loading">Regional live conditions unavailable. No cross-region fallback data was used.</div>';
        if (compact) compact.innerHTML = '';
        return;
      }
      UI.FiveDayOutlook.mount(document.getElementById('fishedge-five-day-outlook'), plans, {
        onDayClick: (idx) => openBriefing(plans[idx]),
      });
      UI.CompactStrip.mount(plans[0], {
        onOpen: () => openBriefing(plans[0]),
        host: document.getElementById('fishedge-compact-strip-host'),
      });
    }

    try {
      const targetCatalog = UI.InletPicker.getTargets ? UI.InletPicker.getTargets(activeRegion) : UI.InletPicker.CANYON_TARGETS;
      const allowedInlets = UI.InletPicker.getInlets ? UI.InletPicker.getInlets(activeRegion) : UI.InletPicker.INLETS;
      const savedInlet = Sto.getSavedInlet();
      picker = UI.InletPicker.mount(document.getElementById('fishedge-inlet-picker'), {
        region: activeRegion,
        initialInlet: allowedInlets[savedInlet] ? savedInlet : Object.keys(allowedInlets)[0],
        initialTargetId: Object.keys(targetCatalog)[0],
        onChange: (inletKey) => { Sto.setSavedInlet(inletKey); rebuild(); },
        onSave:   (tripPlan) => { Sto.saveTrip(Object.assign({}, tripPlan, { region: activeRegion })); rebuildMyTrips(); },
      });
    } catch (e) { console.error('[dashboard-planner] InletPicker.mount failed:', e); throw e; }

    async function rebuild() {
      currentPlans = await build5DayPlans('ocean_city_normal', picker.getInlet(), picker.getSnapshot().target_id);
      mountPlans(currentPlans);
    }

    function rebuildMyTrips() {
      // MyTripsSidebar API: mount(host, opts)
      UI.MyTripsSidebar.mount(document.getElementById('fishedge-my-trips'), {
        trips: Sto.listTrips().filter((trip) => trip && trip.region === activeRegion),
        onLoad: (trip) => {
          const date = trip?.departure_iso ? new Date(trip.departure_iso).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
          const region = trip?.region === 'usec_south' ? 'usec_south' : activeRegion;
          const params = new URLSearchParams({ date, region, from: 'saved-trip' });
          window.location.href = `/planner/map.html?${params}`;
        },
      });
    }

    // Initial mount — fire and forget; build5DayPlans is async.
    (async () => {
      try {
        currentPlans = await build5DayPlans('ocean_city_normal', picker.getInlet(), picker.getSnapshot().target_id);
        mountPlans(currentPlans);
        rebuildMyTrips();
        global.__FISHEDGE_PLANNER_DEV__ = { plans: currentPlans, picker, Sto, rebuild };
        global.__FISHEDGE_PLANNER_MOUNTED__ = true;
        console.info('[dashboard-planner] mounted', { plans: currentPlans.length });
      } catch (e) {
        console.error('[dashboard-planner] initial-render failed:', e);
      }
    })();
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
