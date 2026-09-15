/*!
 * Trip Planner — Adapter Skeleton (Dev MVP, branch feat/trip-planner-dev-mvp)
 *
 * Public surface (intentionally tiny). Real implementations live in:
 *   - open-meteo-marine.js   (gridded wave forecast)
 *   - open-meteo-weather.js  (gridded atmospheric forecast)
 *   - ndbc-realtime.js       (point observations)
 *   - coops-tides.js         (harmonic tide predictions + observations)
 *   - nws-alerts.js          (CAP-format marine alerts)
 *   - astronomy-local.js     (moon/twilight computation, deterministic)
 *
 * Every adapter returns a Promise<SegmentSample[]> following the
 * `captain-conditions-v1` contract documented in
 * `dashboard/trip-planner/conditions-contract.md`.
 *
 * Every returned value carries a `source` block with:
 *   provider, station_id, distance_nm, observation_time | model_run_iso,
 *   valid_time_iso, retrieved_time, age_minutes, quality_flag
 *
 * Never invent a value. Missing fields are { value: null, missing_reason: "..." }.
 *
 * NO third-party calls happen in this skeleton — it is a contract test target.
 * The real adapter calls live behind a feature flag and are wired in Phase 3.
 */

(function attachTripPlannerAdapters(global) {
  'use strict';

  const FRESHNESS = Object.freeze({
    OBSERVATION: 'OBSERVATION',
    MODEL_FORECAST: 'MODEL_FORECAST',
    DETERMINISTIC: 'DETERMINISTIC',
    COMPUTED_LOCAL: 'COMPUTED_LOCAL',
    PUSH_OBSERVATION: 'PUSH_OBSERVATION',
  });

  const MISSING_REASON = Object.freeze({
    NO_NEARBY_OBSERVATION: 'no_nearby_observation',
    OBSERVATION_STALE: 'observation_stale',
    MODEL_GRID_UNAVAILABLE: 'model_grid_unavailable',
    PROVIDER_TIMEOUT: 'provider_timeout',
    PROVIDER_ERROR_5XX: 'provider_error_5xx',
    NO_SUPPORTED_TIDE_STATION: 'no_supported_tide_station',
    NO_SUPPORTED_CURRENT_STATION: 'no_supported_current_station',
    FIELD_NOT_SUPPORTED_AT_SOURCE: 'field_not_supported_at_source',
  });

  /**
   * Build a fully-typed stub SegmentSample.
   * The skeleton deliberately returns SK nulls so the UI can prove it
   * never displays a fabricated value.
   */
  function makeStubSegment(segmentId, label, lonlat, area) {
    const nowRetrieved = '2026-08-18T20:01:00-04:00';
    return {
      id: segmentId,                 // 'inlet' | 'transit' | 'target' | 'return'
      label: label,
      ...(lonlat ? { lonlat } : {}),
      ...(area ? { area } : {}),
      now: {
        wind:    { value: null, missing_reason: MISSING_REASON.NO_NEARBY_OBSERVATION },
        wave:    { value: null, missing_reason: MISSING_REASON.NO_NEARBY_OBSERVATION },
        pressure:{ value: null, missing_reason: MISSING_REASON.NO_NEARBY_OBSERVATION },
        air_temperature:  { value: null, missing_reason: MISSING_REASON.NO_NEARBY_OBSERVATION },
        water_temperature:{ value: null, missing_reason: MISSING_REASON.NO_NEARBY_OBSERVATION },
        humidity:        { value: null, missing_reason: MISSING_REASON.FIELD_NOT_SUPPORTED_AT_SOURCE },
        visibility:      { value: null, missing_reason: MISSING_REASON.FIELD_NOT_SUPPORTED_AT_SOURCE },
        precipitation:   { value: null, missing_reason: MISSING_REASON.FIELD_NOT_SUPPORTED_AT_SOURCE },
        weather_code:    { value: null, missing_reason: MISSING_REASON.FIELD_NOT_SUPPORTED_AT_SOURCE },
        tide:    { value: null, missing_reason: MISSING_REASON.NO_SUPPORTED_TIDE_STATION },
        current: { value: null, missing_reason: MISSING_REASON.NO_SUPPORTED_CURRENT_STATION },
        moon:    { value: null, missing_reason: MISSING_REASON.FIELD_NOT_SUPPORTED_AT_SOURCE },
        alerts:  [],
      },
      trip_window: {
        departure_iso: '2026-08-19T04:00:00-04:00',
        return_iso:    '2026-08-19T14:00:00-04:00',
        hourly: [],                         // populated by model adapters
        worst_window: null,                 // populated by decision engine
        obs_vs_model_disagreement: null,    // populated by reconciler
      },
      alerts: [],
      // Adapters stamp their retrieval wall-time so the UI can show age.
      _retrieved_at: nowRetrieved,
      _schema: 'captain-conditions-v1',
    };
  }

  /**
   * Adapter factory. Returns an object keyed by segment id with the
   * stub segment skeleton. Phase 3 wires real providers behind each key.
   */
  function buildTripPlannerAdapter(opts) {
    if (!opts || !opts.home_inlet || !opts.target) {
      throw new Error('buildTripPlannerAdapter: home_inlet and target are required');
    }
    const inlet  = makeStubSegment('inlet',   opts.home_inlet.label, opts.home_inlet.lonlat);
    const targetAnchor = opts.target.anchor_lonlat || opts.target.lonlat;
    const targetArea = opts.target.geometry ? {
      id: opts.target.id,
      label: opts.target.label,
      kind: opts.target.kind,
      geometry: opts.target.geometry,
      lookup_points: opts.target.lookup_points || [],
      description: opts.target.description,
    } : null;
    const target = makeStubSegment('target', opts.target.label, targetAnchor, targetArea);
    const transit = makeStubSegment('transit', 'Transit corridor', targetAnchor, targetArea);
    const ret     = makeStubSegment('return',  'Return route',         opts.home_inlet.lonlat);

    return {
      // NOTE: outer adapter is intentionally NOT frozen — the decision engine
      // and reconciler stamp `decision` / `obs_vs_model_disagreement` on it
      // after evaluation. The segments sub-object stays frozen so segment
      // identity can't be reassigned (only its nested fields can be filled).
      schema: 'captain-conditions-v1',
      build_marker: 'FISHEDGE_TRIP_PLANNER_BUILD=dev-mvp',
      request: {
        home_inlet_id:     opts.home_inlet.id,
        home_inlet_label:  opts.home_inlet.label,
        home_inlet_lonlat: opts.home_inlet.lonlat,
        departure_iso:     opts.departure_iso,
        return_iso:        opts.return_iso,
        target_area:       targetArea,
        target_lookup_points: opts.target.lookup_points || (targetAnchor ? [targetAnchor] : []),
        tz:                opts.tz || 'America/New_York',
        units:             opts.units || { wind: 'kt', wave_height: 'ft', wave_period: 's', pressure: 'inHg', temperature: 'F' },
      },
      segments: Object.freeze({ inlet, transit, target, return: ret }),
      // Phase 3 will fill these via Promise.all; skeleton exposes them as
      // an explicit stub so tests can assert on the shape today.
      async refresh() {
        return { segments: this.segments, request: this.request };
      },
    };
  }

  const api = Object.freeze({
    buildTripPlannerAdapter,
    FRESHNESS,
    MISSING_REASON,
    SCHEMA_VERSION: 'captain-conditions-v1',
    BUILD_MARKER:   'FISHEDGE_TRIP_PLANNER_BUILD=dev-mvp',
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FishEdgeTripPlanner = api;
  if (typeof window !== 'undefined') window.FishEdgeTripPlanner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
