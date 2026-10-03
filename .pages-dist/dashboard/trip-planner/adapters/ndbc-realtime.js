/*!
 * NDBC Realtime adapter — point observations for wind, gust, pressure,
 * air/water temperature, and (sparse) wave fields.
 *
 * Source: https://www.ndbc.noaa.gov/data/realtime2/<station>.txt
 * Update interval: continuous-wind stations ~10 min, standard met ~1 h,
 * wave spectral ~1 h. NDBC uses `MM` as the missing-value sentinel.
 *
 * Real-time semantics: OBSERVATION. The freshness badge must show
 * "Observed N min ago at <station>".
 *
 * IMPORTANT: NDBC waves are sparse — WVHT/DPD/MWD appear in only ~half
 * of the 10-min slots for directional buoys. The adapter MUST treat `MM`
 * as `null` with missing_reason, never as 0.
 */
(function attachNdbcRealtime(global) {
  'use strict';
  const FishEdgeTripPlanner = global.FishEdgeTripPlanner || require('./index.js');

  // Columns per https://www.ndbc.noaa.gov/meas_des.shtml (standard met + wave).
  // Index: 0 YY, 1 MM, 2 DD, 3 hh, 4 mm, 5 WDIR, 6 WSPD, 7 GST, 8 WVHT,
  //        9 DPD, 10 APD, 11 MWD, 12 PRES, 13 ATMP, 14 WTMP, 15 DEWP,
  //        16 VIS, 17 PTDY, 18 TIDE
  const COL = {
    YY:0, MM:1, DD:2, hh:3, mm:4,
    WDIR:5, WSPD:6, GST:7, WVHT:8, DPD:9, APD:10, MWD:11,
    PRES:12, ATMP:13, WTMP:14, DEWP:15, VIS:16, PTDY:17, TIDE:18,
  };

  const NDBC_REALTIME = 'https://www.ndbc.noaa.gov/data/realtime2';
  const STATION_LIST   = 'https://www.ndbc.noaa.gov/station_text.txt'; // not used in dev MVP

  // Approximate lat/lon for the stations we care about; for production we
  // will fetch the active station list. Dev MVP ships a curated table.
  const STATION_TABLE = {
    '44009': { name: 'Delaware Bay 26 NM SE of Cape May, NJ',     lat: 38.46, lon: -74.70 },
    '44084': { name: 'Bethany Beach, DE',                          lat: 38.54, lon: -75.04 },
    '44089': { name: 'Wallops Island, VA',                         lat: 37.63, lon: -75.33 },
    '41002': { name: 'South Hatteras, NC',                         lat: 31.74, lon: -74.96 },
    '44014': { name: 'Virginia Beach, VA',                         lat: 36.61, lon: -74.84 },
    '44066': { name: 'Texas Tower, NJ',                            lat: 39.55, lon: -72.62 },
  };

  function mpsToKt(v)    { return v == null ? null : v * 1.94384; }
  function mToFt(v)      { return v == null ? null : v * 3.28084; }
  function hPaToInHg(v)  { return v == null ? null : v * 0.02953; }
  function cToF(v)       { return v == null ? null : v * 9/5 + 32; }
  function nmiFromM(v)   { return v == null ? null : v / 1852; }

  /**
   * Parse one row of NDBC text. Returns either a fully-populated obs
   * object or null if the row's sentinel values leave no useful fields.
   */
  function parseRow(line, stationId) {
    if (!line || line.startsWith('#')) return null;
    const f = line.trim().split(/\s+/);
    if (f.length < 18) return null;
    const get = (col) => {
      const v = f[col];
      if (v == null || v === 'MM' || v === '99.0' || v === '99.00') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const hh = String(get(COL.hh)).padStart(2, '0');
    const mm = String(get(COL.mm)).padStart(2, '0');
    const dd = String(get(COL.DD)).padStart(2, '0');
    const mon = String(get(COL.MM)).padStart(2, '0');
    const yy = String(get(COL.YY)).padStart(2, '0');
    const yearFull = (Number(yy) >= 70 ? 1900 : 2000) + Number(yy);
    // NDBC reports UTC. Convert to ISO with Z.
    const obsIsoUtc = `${yearFull}-${mon}-${dd}T${hh}:${mm}:00Z`;

    const has = (x) => x != null;
    const obs = {
      station_id: stationId,
      observation_time_iso: obsIsoUtc,
      retrieved_time_iso: new Date().toISOString(),
      wind_dir_deg: get(COL.WDIR),
      wind_speed_kt: mpsToKt(get(COL.WSPD)),
      wind_gust_kt:  mpsToKt(get(COL.GST)),
      wave_height_ft: mToFt(get(COL.WVHT)),
      wave_dominant_period_s: get(COL.DPD),
      wave_average_period_s: get(COL.APD),
      wave_dir_deg: get(COL.MWD),
      pressure_inHg: hPaToInHg(get(COL.PRES)),
      pressure_tendency_3h_inHg: hPaToInHg(get(COL.PTDY)),
      air_temp_f: cToF(get(COL.ATMP)),
      water_temp_f: cToF(get(COL.WTMP)),
      dewpoint_f: cToF(get(COL.DEWP)),
      visibility_nm: nmiFromM(Number(get(COL.VIS)) * 1000),
    };

    // Drop fully-empty rows.
    const anyField = [
      obs.wind_dir_deg, obs.wind_speed_kt, obs.wave_height_ft,
      obs.pressure_inHg, obs.air_temp_f, obs.water_temp_f,
    ].some(has);
    if (!anyField) return null;
    return obs;
  }

  /**
   * Fetch + parse NDBC realtime text. Returns { station, latest, history }.
   */
  async function fetchNdbcRealtime(stationId, opts = {}, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
    if (!fetchImpl) throw new Error('No fetch implementation available');
    const url = `${NDBC_REALTIME}/${stationId}.txt`;
    const res = await fetchImpl(url, { method: 'GET' });
    if (res.status === 404) {
      const err = new Error(`NDBC station ${stationId} returned 404 — likely decommissioned or no recent reports`);
      err.code = 'no_recent_reports';
      throw err;
    }
    if (!res.ok) throw new Error(`NDBC HTTP ${res.status} for station ${stationId}`);
    const text = await res.text();
    const lines = text.split(/\r?\n/);
    const history = [];
    let latest = null;
    for (const line of lines) {
      const o = parseRow(line, stationId);
      if (!o) continue;
      history.push(o);
      if (!latest || o.observation_time_iso > latest.observation_time_iso) {
        latest = o;
      }
    }
    const station = STATION_TABLE[stationId] || null;
    return { station_id: stationId, station, latest, history, raw_url: url };
  }

  /**
   * Distance between two lonlat points in nautical miles (haversine).
   */
  function distanceNm(a, b) {
    if (!a || !b) return null;
    const R = 3440.065; // nm
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const h = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon/2)**2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /**
   * Convert NDBC obs row into a captain-conditions-v1 freshness-stamped
   * `now` block, with missing_reason fields populated where NDBC has `MM`.
   */
  function obsToNowSegment(latest, stationMeta, pointLonlat) {
    const ageMin = latest ? Math.round((Date.now() - Date.parse(latest.observation_time_iso)) / 60000) : null;
    const stale = ageMin != null && ageMin > 90;
    const dist = stationMeta && pointLonlat ? distanceNm([stationMeta.lon, stationMeta.lat], pointLonlat) : null;

    const baseSrc = {
      provider: 'NDBC',
      station_id: latest && latest.station_id,
      station_name: stationMeta && stationMeta.name,
      distance_nm: dist != null ? Math.round(dist * 10) / 10 : null,
      observation_time: latest && latest.observation_time_iso,
      retrieved_time: new Date().toISOString(),
      age_minutes: ageMin,
      quality_flag: stale ? 'stale' : 'ok',
    };

    return {
      wind: latest && latest.wind_speed_kt != null ? {
        value: {
          speed: latest.wind_speed_kt,
          gust: latest.wind_gust_kt,
          dir_deg: latest.wind_dir_deg,
          dir_cardinal: degToCardinal(latest.wind_dir_deg),
        },
        freshness: FishEdgeTripPlanner.FRESHNESS.OBSERVATION,
        source: baseSrc,
      } : null,
      wave: latest && latest.wave_height_ft != null ? {
        value: {
          height: latest.wave_height_ft,
          dominant_period: latest.wave_dominant_period_s,
          average_period: latest.wave_average_period_s,
          dir_deg: latest.wave_dir_deg,
          dir_cardinal: degToCardinal(latest.wave_dir_deg),
        },
        freshness: FishEdgeTripPlanner.FRESHNESS.OBSERVATION,
        source: baseSrc,
      } : (latest ? {
        value: null,
        missing_reason: FishEdgeTripPlanner.MISSING_REASON.FIELD_NOT_SUPPORTED_AT_SOURCE,
        freshness: FishEdgeTripPlanner.FRESHNESS.OBSERVATION,
        source: baseSrc,
      } : null),
      pressure: latest && latest.pressure_inHg != null ? {
        value: {
          pressure: latest.pressure_inHg,
          tendency_3h: latest.pressure_tendency_3h_inHg,
        },
        freshness: FishEdgeTripPlanner.FRESHNESS.OBSERVATION,
        source: baseSrc,
      } : null,
      air_temperature: latest && latest.air_temp_f != null ? {
        value: latest.air_temp_f,
        freshness: FishEdgeTripPlanner.FRESHNESS.OBSERVATION,
        source: baseSrc,
      } : null,
      water_temperature: latest && latest.water_temp_f != null ? {
        value: latest.water_temp_f,
        freshness: FishEdgeTripPlanner.FRESHNESS.OBSERVATION,
        source: baseSrc,
      } : null,
      visibility: latest && latest.visibility_nm != null ? {
        value: latest.visibility_nm,
        freshness: FishEdgeTripPlanner.FRESHNESS.OBSERVATION,
        source: baseSrc,
      } : null,
    };
  }

  function degToCardinal(deg) {
    if (deg == null) return null;
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(((deg % 360) / 22.5)) % 16];
  }

  const api = Object.freeze({
    fetchNdbcRealtime,
    parseRow,
    obsToNowSegment,
    distanceNm,
    STATION_TABLE,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.NdbcRealtime = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
