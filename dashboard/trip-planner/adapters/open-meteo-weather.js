/*!
 * Open-Meteo Weather adapter — gridded atmospheric forecast
 * Doc: https://open-meteo.com/en/docs
 *
 * Variables: 10 m wind speed/gust/direction, MSL pressure, relative humidity,
 * visibility, precipitation, weather_code. Free, no key, ~10 ms response.
 *
 * Real-time semantics: MODEL_FORECAST. The current hour is a model field,
 * not a measurement. We stamp the model run time and the age_minutes.
 *
 * Wind units: pass `wind_speed_unit=kn` so the API returns knots.
 */
(function attachOpenMeteoWeather(global) {
  'use strict';
  const FishEdgeTripPlanner = global.FishEdgeTripPlanner || require('./index.js');

  const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast';
  const HOURLY_FIELDS = [
    'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m',
    'pressure_msl', 'relative_humidity_2m', 'visibility',
    'precipitation', 'weather_code',
  ].join(',');

  function hPaToInHg(v) { return v == null ? null : v * 0.02953; }
  function mToFt(v)     { return v == null ? null : v * 3.28084; }
  function mToNm(v)     { return v == null ? null : v / 1852; }

  function buildUrl(lat, lon, { pastHours = 6, forecastDays = 5, model = 'best_match' } = {}) {
    const u = new URL(WEATHER_URL);
    u.searchParams.set('latitude',  String(lat));
    u.searchParams.set('longitude', String(lon));
    u.searchParams.set('hourly',    HOURLY_FIELDS);
    u.searchParams.set('wind_speed_unit', 'kn');
    u.searchParams.set('past_hours', String(pastHours));
    u.searchParams.set('forecast_days', String(forecastDays));
    if (model !== 'best_match') u.searchParams.set('models', model);
    return u.toString();
  }

  function degToCardinal(deg) {
    if (deg == null) return null;
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(((deg % 360) / 22.5)) % 16];
  }

  function formatOffset(seconds) {
    const sign = seconds < 0 ? '-' : '';
    const abs = Math.abs(seconds);
    const hh = String(Math.floor(abs / 3600)).padStart(2, '0');
    const mm = String(Math.floor((abs % 3600) / 60)).padStart(2, '0');
    return `${sign}${hh}:${mm}`;
  }

  function parseHourly(payload) {
    const h = payload && payload.hourly;
    if (!h || !h.time) return [];
    const out = [];
    const retrieved = new Date().toISOString();
    const modelRunIso = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
    const offset = payload.utc_offset_seconds;
    for (let i = 0; i < h.time.length; i++) {
      const localHour = h.time[i];
      const validIso = localHour + (offset >= 0 ? `+${formatOffset(offset)}` : `-${formatOffset(-offset)}`);
      out.push({
        iso: validIso,
        wind_speed:   h.wind_speed_10m && h.wind_speed_10m[i],
        wind_gust:    h.wind_gusts_10m && h.wind_gusts_10m[i],
        wind_dir_deg: h.wind_direction_10m && h.wind_direction_10m[i],
        wind_dir_cardinal: degToCardinal(h.wind_direction_10m && h.wind_direction_10m[i]),
        wave_height:  null,
        wave_period:  null,
        wave_dir_deg: null,
        pressure:     hPaToInHg(h.pressure_msl && h.pressure_msl[i]),
        temperature:  h.relative_humidity_2m ? null : null, // weather API does not give air temp in this field set
        precipitation: h.precipitation && h.precipitation[i],
        visibility_nm: mToNm(h.visibility && h.visibility[i]),
        weather_code: h.weather_code && h.weather_code[i],
        freshness: FishEdgeTripPlanner.FRESHNESS.MODEL_FORECAST,
        source: {
          provider: 'Open-Meteo',
          model: 'weather-best-match',
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

  async function fetchWeatherForecast(lat, lon, opts = {}, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
    if (!fetchImpl) throw new Error('No fetch implementation available');
    const url = buildUrl(lat, lon, opts);
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) throw new Error(`Open-Meteo Weather HTTP ${res.status}`);
    const payload = await res.json();
    return {
      tz: payload.timezone,
      tzAbbr: payload.timezone_abbreviation,
      utcOffsetSeconds: payload.utc_offset_seconds,
      hourly: parseHourly(payload),
      raw_url: url,
    };
  }

  const api = Object.freeze({ fetchWeatherForecast, buildUrl, parseHourly, HOURLY_FIELDS });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.OpenMeteoWeather = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
