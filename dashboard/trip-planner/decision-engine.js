/*!
 * Decision engine — captain-conditions-v1 → GO | CAUTION | NO_GO | UNKNOWN
 *
 * Inputs (per segment):
 *   now:          { wind:{value:{speed,gust,dir_deg}, freshness, source},
 *                    wave:{value:{height,period,dir_deg}, freshness, source},
 *                    pressure:{value:{pressure,tendency_3h}, freshness, source}, ... }
 *   trip_window:  { hourly:[{wave_height,wave_period,wind_gust,wind_speed,pressure}], worst_window, obs_vs_model_disagreement }
 *   alerts:       [{event, severity, ...}]
 *
 * Output (per segment + roll-up):
 *   { decision, reasons:[{code,field,value,threshold,severity}], confidence,
 *     thresholds, missing_required_inputs, data_freshness_summary }
 *
 * Hard rules:
 *   1. Any required safety field null with missing_reason in {no_nearby_observation,
 *      observation_stale, model_grid_unavailable} → decision = UNKNOWN (never GO).
 *   2. Active hard-stop alert (Hurricane, Storm Warning, Gale Warning, Special
 *      Marine Warning, or severity in {Extreme,Severe}) → decision = NO_GO.
 *   3. Worst-window trip scan: any sustained threshold breach → NO_GO;
 *      any marginal threshold breach → CAUTION.
 *   4. obs_vs_model_disagreement.verdict == "mismatch" on waves → CAUTION minimum.
 *   5. Confidence starts at "high", downgraded by observation age and disagreement.
 */
(function attachDecisionEngine(global) {
  'use strict';
  const FishEdgeTripPlanner = global.FishEdgeTripPlanner || require('./adapters/index.js');

  const DEFAULT_THRESHOLDS = Object.freeze({
    wind_sustained_kt: 20.0,
    wind_gust_kt:      25.0,
    wave_height_ft:     3.0,
    wave_period_min_s:  5.0,
    visibility_nm:      1.0,
    pressure_tendency_3h_inHg: -0.10,
    obs_vs_model_wave_ratio: 1.7,
    observation_age_min_warn: 60,
    observation_age_min_fail: 90,
  });

  const REQUIRED_SAFETY_FIELDS = ['wind', 'wave', 'pressure'];
  const HARD_ALERT_REGEX = /Hurricane Force|Hurricane Warning|Storm Warning|Gale Warning|Special Marine Warning/i;

  function classifyAlert(alert) {
    if (!alert) return null;
    if (['Extreme', 'Severe'].includes(alert.severity)) return 'HARD';
    if (HARD_ALERT_REGEX.test(alert.event || '')) return 'HARD';
    return null;
  }

  function isFieldMissing(field) {
    return field == null || (field.value === null && field.missing_reason);
  }

  /**
   * Decide on a single segment.
   */
  function decideSegment(segment, opts = {}) {
    const t = Object.assign({}, DEFAULT_THRESHOLDS, opts);
    const reasons = [];
    const missingRequired = [];

    // (1) hard-stop alerts → NO_GO
    const hardAlert = (segment.alerts || []).map(classifyAlert).filter(Boolean);
    if (hardAlert.length) {
      reasons.push({ code: 'HARD_ALERT_ACTIVE', field: 'alerts', value: hardAlert, severity: 'high' });
      return finalize('NO_GO', reasons, t, missingRequired, 'high', segment);
    }

    // (2) missing required safety fields → UNKNOWN
    for (const f of REQUIRED_SAFETY_FIELDS) {
      const field = segment.now && segment.now[f];
      if (isFieldMissing(field)) {
        const reason = (field && field.missing_reason) || 'no_nearby_observation';
        if (['no_nearby_observation', 'observation_stale', 'model_grid_unavailable'].includes(reason)) {
          missingRequired.push({ field: f, reason });
        }
      }
    }
    if (missingRequired.length) {
      reasons.push({ code: 'REQUIRED_SAFETY_DATA_MISSING', field: 'now', value: missingRequired.map(m => m.field), severity: 'high' });
      return finalize('UNKNOWN', reasons, t, missingRequired, 'low', segment);
    }

    // (3) worst-window trip scan
    const ww = segment.trip_window && segment.trip_window.worst_window;
    if (ww) {
      if (ww.max_wave_height != null && ww.max_wave_height > t.wave_height_ft) {
        reasons.push({ code: 'WAVE_HEIGHT_OVER_TRIP_WINDOW_EXCEEDS_THRESHOLD', field: 'wave_height',
          value: ww.max_wave_height, threshold: t.wave_height_ft, severity: 'high' });
      }
      if (ww.max_wind_gust != null && ww.max_wind_gust > t.wind_gust_kt) {
        reasons.push({ code: 'WIND_GUST_OVER_TRIP_WINDOW_EXCEEDS_THRESHOLD', field: 'wind_gust',
          value: ww.max_wind_gust, threshold: t.wind_gust_kt, severity: 'high' });
      }
      if (ww.min_wave_period != null && ww.min_wave_period < t.wave_period_min_s) {
        reasons.push({ code: 'WAVE_PERIOD_BELOW_FLOOR_OVER_TRIP_WINDOW', field: 'wave_period',
          value: ww.min_wave_period, threshold: t.wave_period_min_s, severity: 'medium' });
      }
    }

    // (4) now observation breaches
    const w = segment.now.wind.value;
    if (w) {
      if (w.speed > t.wind_sustained_kt) {
        reasons.push({ code: 'WIND_SUSTAINED_EXCEEDS_THRESHOLD', field: 'wind_speed',
          value: w.speed, threshold: t.wind_sustained_kt, severity: 'high' });
      } else if (w.speed > t.wind_sustained_kt * 0.75) {
        reasons.push({ code: 'WIND_SUSTAINED_NEAR_THRESHOLD', field: 'wind_speed',
          value: w.speed, threshold: t.wind_sustained_kt, severity: 'low' });
      }
      if (w.gust != null && w.gust > t.wind_gust_kt) {
        reasons.push({ code: 'WIND_GUST_EXCEEDS_THRESHOLD', field: 'wind_gust',
          value: w.gust, threshold: t.wind_gust_kt, severity: 'high' });
      }
    }
    const wa = segment.now.wave.value;
    if (wa) {
      if (wa.height > t.wave_height_ft) {
        reasons.push({ code: 'WAVE_HEIGHT_EXCEEDS_THRESHOLD', field: 'wave_height',
          value: wa.height, threshold: t.wave_height_ft, severity: 'high' });
      } else if (wa.height > t.wave_height_ft * 0.75) {
        reasons.push({ code: 'WAVE_HEIGHT_NEAR_THRESHOLD', field: 'wave_height',
          value: wa.height, threshold: t.wave_height_ft, severity: 'low' });
      }
      if (wa.dominant_period != null && wa.dominant_period < t.wave_period_min_s) {
        reasons.push({ code: 'WAVE_PERIOD_BELOW_FLOOR', field: 'wave_period',
          value: wa.dominant_period, threshold: t.wave_period_min_s, severity: 'medium' });
      }
    }

    // (5) obs vs model disagreement
    const d = segment.trip_window.obs_vs_model_disagreement;
    if (d && d.verdict === 'mismatch') {
      reasons.push({ code: 'OBS_VS_MODEL_DISAGREEMENT', field: 'wave', value: d, severity: 'medium' });
    }

    // confidence downgrade based on observation age
    let confidence = 'high';
    for (const f of REQUIRED_SAFETY_FIELDS) {
      const field = segment.now[f];
      const age = field && field.source && field.source.age_minutes;
      if (age == null) continue;
      if (age > t.observation_age_min_fail) {
        confidence = 'low';
      } else if (age > t.observation_age_min_warn && confidence === 'high') {
        confidence = 'medium';
      }
    }

    // decide
    let decision = 'GO';
    if (reasons.some(r => r.severity === 'high')) decision = 'NO_GO';
    else if (reasons.length) decision = 'CAUTION';

    return finalize(decision, reasons, t, missingRequired, confidence, segment);
  }

  function finalize(decision, reasons, thresholds, missingRequired, confidence, segment) {
    const stale = [];
    for (const f of REQUIRED_SAFETY_FIELDS) {
      const age = segment.now[f] && segment.now[f].source && segment.now[f].source.age_minutes;
      if (age != null && age > thresholds.observation_age_min_warn) stale.push(f);
    }
    return {
      decision,
      reasons,
      thresholds,
      confidence,
      missing_required_inputs: missingRequired,
      data_freshness_summary: { stale_segments: stale, no_nearby_observation_segments: [] },
    };
  }

  /**
   * Roll up decisions across segments. The roll-up uses the worst segment
   * decision; if any segment is NO_GO, the trip is NO_GO; if any is UNKNOWN
   * and none are NO_GO, the trip is UNKNOWN; if all are GO, the trip is GO.
   */
  function rollUp(segmentDecisions) {
    if (!segmentDecisions || !segmentDecisions.length) return { decision: 'UNKNOWN', reasons: [] };
    const order = ['NO_GO', 'UNKNOWN', 'CAUTION', 'GO'];
    let worst = 'GO';
    for (const sd of segmentDecisions) {
      const i = order.indexOf(sd.decision);
      const wi = order.indexOf(worst);
      if (i < wi) worst = sd.decision;
    }
    const reasons = [];
    for (const sd of segmentDecisions) {
      if (sd.decision !== 'GO') reasons.push({ segment: sd.segment_id || sd.id, decision: sd.decision, reasons: sd.reasons });
    }
    return { decision: worst, reasons, segment_decisions: segmentDecisions };
  }

  /**
   * Run the engine over the full TripPlan shape. Each segment carries its
   * own pre-computed `decision` field afterwards.
   */
  function evaluateTripPlan(plan, opts = {}) {
    if (!plan || !plan.segments) return plan;
    for (const key of Object.keys(plan.segments)) {
      const seg = plan.segments[key];
      seg.decision = decideSegment(seg, opts);
    }
    plan.decision = rollUp(Object.values(plan.segments).map(s => Object.assign({ segment_id: s.segment && s.segment.id }, s.decision)));
    return plan;
  }

  const api = Object.freeze({
    decideSegment,
    evaluateTripPlan,
    rollUp,
    classifyAlert,
    DEFAULT_THRESHOLDS,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.TripDecisionEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
