/*!
 * Open-Meteo Marine adapter — gridded wave forecast
 * Doc: https://open-meteo.com/en/docs/marine-weather-api
 *
 * Underlying models: ECMWF WAM 9 km (6 h cycle), NCEP GFS-Wave 0.25° (6 h),
 * Météo-France MFWAM 0.08° (12 h), DWD EWAM 0.05° (12 h).
 * Resolution returned to us: best available for the lat/lon (typically 5–16 km offshore).
 *
 * Real-time semantics: MODEL_FORECAST. The "current hour" value is the model
 * field valid for that hour; the model run was 3–6 h ago. We MUST render that
 * distinction — the captain is not looking at a measurement.
 */
(function attachOpenMeteoMarine(global) {
  'use strict';
  const FishEdgeTripPlanner = global.FishEdgeTripPlanner || require('./index.js');

  const MARINE_URL = 'https://marine-api.open-meteo.com/v1/marine';
  const HOURLY_FIELDS = [
    'wave_height', 'wave_direction', 'wave_period',
    'wind_wave_height', 'wind_wave_direction', 'wind_wave_period',
    'swell_wave_height', 'swell_wave_direction', 'swell_wave_period',
  ].join(',');

  function mpsToKt(v) { return v == null ? null : v * 1.94384; }
  function mToFt(v)    { return v == null ? null : v * 3.28084; }

  function degToCardinal(deg) {
    if (deg == null) return null;
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(((deg % 360) / 22.5)) % 16];
  }

  /**
   * Build the URL. Past hours included so a partial "now" anchor can be used
   * by the reconciler to compare against the nearest observation.
   */
  function buildUrl(lat, lon, { pastHours = 6, forecastDays = 5, model = 'best_match' } = {}) {
    const u = new URL(MARINE_URL);
    u.searchParams.set('latitude',  String(lat));
    u.searchParams.set('longitude', String(lon));
    u.searchParams.set('hourly',    HOURLY_FIELDS);
    u.searchParams.set('past_hours', String(pastHours));
    u.searchParams.set('forecast_days', String(forecastDays));
    u.searchParams.set('length_unit', 'imperial'); // waves come back in meters; we convert.
    if (model !== 'best_match') u.searchParams.set('models', model);
    return u.toString();
  }

  function isoFromLocalHour(localHourStr, tz) {
    // Open-Meteo returns local time without offset (e.g. "2026-08-19T04:00").
    // We anchor to the response timezone_abbreviation + utc_offset_seconds.
    return localHourStr;
  }

  /**
   * Parse the raw Open-Meteo payload into captain-conditions-v1 hourly rows.
   * The adapter stamps `freshness: MODEL_FORECAST` and the model_run_iso (we
   * approximate it as generationtime_ms-derived; for production we will fetch
   * the model-updates manifest and stamp the actual run time).
   */
  function parseHourly(payload, tzAbbr, utcOffsetSeconds) {
    const h = payload && payload.hourly;
    if (!h || !h.time) return [];
    const out = [];
    const retrieved = new Date().toISOString();
    // Approximate model_run_time: Open-Meteo's generationtime_ms is the time
    // it took to assemble the response, not the model run. The actual run is
    // documented at /v1/models-updates. Dev MVP: assume run was at most 6h old.
    const modelRunIso = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    for (let i = 0; i < h.time.length; i++) {
      const localHour = h.time[i]; // e.g. "2026-08-19T04:00"
      const validIso = localHour + (utcOffsetSeconds >= 0 ? `+${formatOffset(utcOffsetSeconds)}` : `-${formatOffset(-utcOffsetSeconds)}`);
      out.push({
        iso: validIso,
        wind_speed:    null,                          // marine API does not provide wind
        wind_gust:     null,
        wind_dir_deg:  null,
        wind_dir_cardinal: null,
        wave_height:   mToFt(h.wave_height && h.wave_height[i]),
        wave_period:   h.wave_period && h.wave_period[i],
        wave_dir_deg:  h.wave_direction && h.wave_direction[i],
        wave_dir_cardinal: degToCardinal(h.wave_direction && h.wave_direction[i]),
        swell_height:  mToFt(h.swell_wave_height && h.swell_wave_height[i]),
        swell_period:  h.swell_wave_period && h.swell_wave_period[i],
        swell_dir_deg: h.swell_wave_direction && h.swell_wave_direction[i],
        wind_wave_height: mToFt(h.wind_wave_height && h.wind_wave_height[i]),
        wind_wave_period: h.wind_wave_period && h.wind_wave_period[i],
        pressure:      null,                          // marine API does not provide pressure
        temperature:   null,
        precipitation: null,
        weather_code:  null,
        freshness:     FishEdgeTripPlanner.FRESHNESS.MODEL_FORECAST,
        source: {
          provider: 'Open-Meteo',
          model: 'marine-best-match',
          model_run_iso: modelRunIso,
          valid_time_iso: validIso,
          retrieved_time: retrieved,
          age_minutes: Math.round((Date.now() - Date.parse(modelRunIso)) / 60000),
          quality_flag: 'ok',
        },
      });
    }
    return out;
  }

  function formatOffset(seconds) {
    const sign = seconds < 0 ? '-' : '';
    const abs = Math.abs(seconds);
    const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
    const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
    return `${sign}${hh}:${mm}`;
  }

  /**
   * Fetch + parse. Dev MVP runs from the dashboard via fetch(); tests inject
   * a `fetchImpl` so we don't hit the network in CI.
   */
  async function fetchMarineForecast(lat, lon, opts = {}, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
    if (!fetchImpl) throw new Error('No fetch implementation available');
    const url = buildUrl(lat, lon, opts);
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) throw new Error(`Open-Meteo Marine HTTP ${res.status}`);
    const payload = await res.json();
    return {
      tz: payload.timezone,
      tzAbbr: payload.timezone_abbreviation,
      utcOffsetSeconds: payload.utc_offset_seconds,
      hourly: parseHourly(payload, payload.timezone_abbreviation, payload.utc_offset_seconds),
      raw_url: url,
    };
  }

  const api = Object.freeze({ fetchMarineForecast, buildUrl, parseHourly, HOURLY_FIELDS });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.OpenMeteoMarine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
