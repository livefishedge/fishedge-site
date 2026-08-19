/*!
 * NOAA CO-OPS Tides adapter — harmonic tide predictions + 6-min water levels
 * Doc: https://api.tidesandcurrents.noaa.gov/api/prod/
 *
 * Endpoints used:
 *   predictions    : harmonic tide predictions (high/low + 6-min) for a station
 *   water_level    : observed 6-min water level (preliminary/verified)
 *   mdapi stations : metadata (lat/lon, datum, timezone)
 *
 * Real-time semantics: PREDICTIONS are DETERMINISTIC (valid forever, computed
 * once per tidal epoch). OBSERVED water levels are OBSERVATION (6 min cadence,
 * GOES-transmitted).
 *
 * IMPORTANT: datums are station-specific. MLLW is the standard nautical
 * chart datum but not all stations support MLLW. The adapter must surface
 * `datum` in every returned value.
 */
(function attachCoopsTides(global) {
  'use strict';
  const FishEdgeTripPlanner = global.FishEdgeTripPlanner || require('./index.js');

  const COOPS_BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
  const COOPS_MDAPI = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi';

  /**
   * Curated USEC-MD inlet station table. Phase 2 will fetch this from
   * /mdapi/prod/webapi/stations.json and rank by proximity. Dev MVP keeps
   * the table small and obvious so the captain can see the choice.
   */
  const INLET_STATION_TABLE = {
    'ocean-city-md':           { station_id: '8570283', label: 'Ocean City Inlet, MD',   lat: 38.3286, lon: -75.0919 },
    'indian-river-inlet-de':   { station_id: '8557863', label: 'Rehoboth Beach, DE (proxy)', lat: 38.7200, lon: -75.0833 },
    'cape-may-nj':             { station_id: '8536110', label: 'Cape May, NJ',           lat: 38.9686, lon: -74.9594 },
    'chesapeake-bay-bt':       { station_id: '8573364', label: 'Chesapeake Bay Bridge Tunnel, VA', lat: 36.9667, lon: -76.1133 },
    'lewes-de':                { station_id: '8557689', label: 'Lewes, DE (Breakwater Harbor)', lat: 38.7817, lon: -75.1197 },
    'solomons-island-md':      { station_id: '8577330', label: 'Solomons Island, MD',    lat: 38.3172, lon: -76.4511 },
  };

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtLocalDate(d) {
    return `${d.getFullYear()}${pad2(d.getMonth()+1)}${pad2(d.getDate())}`;
  }

  function buildPredictionsUrl(stationId, { begin, end, datum = 'MLLW', interval = 'hilo', units = 'english', tz = 'lst_ldt' } = {}) {
    const u = new URL(`${COOPS_BASE}`);
    u.searchParams.set('product', 'predictions');
    u.searchParams.set('application', 'FishEdge-dev');
    u.searchParams.set('begin_date', begin);
    u.searchParams.set('end_date', end);
    u.searchParams.set('datum', datum);
    u.searchParams.set('station', stationId);
    u.searchParams.set('time_zone', tz);
    u.searchParams.set('units', units);
    u.searchParams.set('interval', interval);
    u.searchParams.set('format', 'json');
    return u.toString();
  }

  function buildWaterLevelUrl(stationId, { begin, end, datum = 'MLLW', units = 'english', tz = 'gmt' } = {}) {
    const u = new URL(`${COOPS_BASE}`);
    u.searchParams.set('product', 'water_level');
    u.searchParams.set('application', 'FishEdge-dev');
    u.searchParams.set('begin_date', begin);
    u.searchParams.set('end_date', end);
    u.searchParams.set('datum', datum);
    u.searchParams.set('station', stationId);
    u.searchParams.set('time_zone', tz);
    u.searchParams.set('units', units);
    u.searchParams.set('format', 'json');
    u.searchParams.set('interval', '6');
    return u.toString();
  }

  /**
   * Parse tide predictions into captain-conditions-v1 freshness-stamped block.
   * Returns { value: { next_high, next_low, datum, station_meta }, ... }.
   */
  function parsePredictions(json, stationMeta, nowIso) {
    if (!json || !json.predictions || !Array.isArray(json.predictions)) {
      return {
        value: null,
        missing_reason: FishEdgeTripPlanner.MISSING_REASON.NO_SUPPORTED_TIDE_STATION,
        freshness: FishEdgeTripPlanner.FRESHNESS.DETERMINISTIC,
        source: {
          provider: 'NOAA_CO-OPS',
          station_id: stationMeta && stationMeta.station_id,
          station_name: stationMeta && stationMeta.label,
          observation_time: null,
          valid_window_start: null,
          valid_window_end: null,
          retrieved_time: new Date().toISOString(),
          age_minutes: null,
          quality_flag: 'no_data',
        },
      };
    }
    // Predictions come in as local time without TZ. The CO-OPS `time_zone=lst_ldt`
    // returns local clock time; we treat it as already-local for display and
    // anchor the freshness window to the request span.
    const now = Date.parse(nowIso || new Date().toISOString());
    let nextHigh = null, nextLow = null;
    for (const p of json.predictions) {
      const t = Date.parse(`${p.t.replace(' ', 'T')}-04:00`); // best-effort local; CO-OPS does not return offset
      if (Number.isNaN(t)) continue;
      if (t < now) continue;
      if (p.type === 'H' && !nextHigh) nextHigh = { iso: new Date(t).toISOString(), value: Number(p.v), unit: 'ft', type: 'H' };
      if (p.type === 'L' && !nextLow)  nextLow  = { iso: new Date(t).toISOString(), value: Number(p.v), unit: 'ft', type: 'L' };
      if (nextHigh && nextLow) break;
    }
    const begin = json.predictions[0] && json.predictions[0].t;
    const end   = json.predictions[json.predictions.length-1] && json.predictions[json.predictions.length-1].t;
    return {
      value: {
        next_high: nextHigh,
        next_low:  nextLow,
        datum: 'MLLW',
        station_id: stationMeta && stationMeta.station_id,
      },
      freshness: FishEdgeTripPlanner.FRESHNESS.DETERMINISTIC,
      source: {
        provider: 'NOAA_CO-OPS',
        station_id: stationMeta && stationMeta.station_id,
        station_name: stationMeta && stationMeta.label,
        observation_time: null,
        valid_window_start: begin ? `${begin}-04:00` : null,
        valid_window_end:   end   ? `${end}-04:00`   : null,
        retrieved_time: new Date().toISOString(),
        age_minutes: null,
        quality_flag: 'harmonic_prediction',
      },
    };
  }

  /**
   * Fetch tide predictions (harmonic). Returns the parsed `now` block.
   */
  async function fetchTidePredictions(inletKey, opts = {}, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
    if (!fetchImpl) throw new Error('No fetch implementation available');
    const meta = INLET_STATION_TABLE[inletKey];
    if (!meta) throw new Error(`Unknown inlet key: ${inletKey}`);
    const now = new Date();
    const begin = fmtLocalDate(now);
    const end   = fmtLocalDate(new Date(now.getTime() + 2 * 86400 * 1000));
    const url = buildPredictionsUrl(meta.station_id, {
      begin, end, datum: 'MLLW', interval: 'hilo', units: 'english', tz: 'lst_ldt',
    });
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) {
      // Some stations do not support MLLW or have no predictions yet. Surface
      // this as missing_reason rather than crashing.
      return parsePredictions(null, meta);
    }
    const json = await res.json();
    return parsePredictions(json, meta);
  }

  /**
   * Fetch observed 6-min water level. Used to detect surge/set-down against
   * the harmonic prediction. Optional; not on the MVP path.
   */
  async function fetchWaterLevelObs(inletKey, opts = {}, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
    if (!fetchImpl) throw new Error('No fetch implementation available');
    const meta = INLET_STATION_TABLE[inletKey];
    if (!meta) throw new Error(`Unknown inlet key: ${inletKey}`);
    const now = new Date();
    const begin = fmtLocalDate(now);
    const end   = fmtLocalDate(now);
    const url = buildWaterLevelUrl(meta.station_id, {
      begin, end, datum: 'MLLW', units: 'english', tz: 'gmt',
    });
    const res = await fetchImpl(url, { method: 'GET' });
    if (!res.ok) return null;
    return await res.json();
  }

  const api = Object.freeze({
    INLET_STATION_TABLE,
    fetchTidePredictions,
    fetchWaterLevelObs,
    parsePredictions,
    buildPredictionsUrl,
    buildWaterLevelUrl,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.CoopsTides = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
