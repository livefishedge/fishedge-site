/*!
 * Reconciler — compare the nearest observation against the model forecast
 * for the same point and hour, and emit a disagreement verdict.
 *
 * Inputs:
 *   nowObservation: { wind: {speed, gust, dir_deg}, wave: {height, period, dir_deg}, pressure: {pressure} }
 *   modelNowRow:    { wind_speed, wind_gust, wave_height, wave_period, wave_dir_deg, pressure }
 *
 * Output:
 *   { wind_speed_delta_kt, wave_height_delta_ft, wave_dir_delta_deg,
 *     verdict: 'agree' | 'marginal' | 'mismatch' }
 *
 * Thresholds (defaults, all overridable via opts):
 *   wind_speed: agree < 3 kt, marginal < 6 kt, else mismatch
 *   wave_height (multiplicative): agree < 1.3x, marginal < 1.7x, else mismatch
 *   wave_dir:    agree < 30°, marginal < 60°, else mismatch
 */
(function attachReconciler(global) {
  'use strict';

  const DEFAULTS = Object.freeze({
    wind_speed_delta_kt_agree:    3.0,
    wind_speed_delta_kt_marginal: 6.0,
    wave_height_ratio_agree:      1.3,
    wave_height_ratio_marginal:   1.7,
    wave_dir_delta_deg_agree:     30,
    wave_dir_delta_deg_marginal:  60,
  });

  function delta(a, b) {
    if (a == null || b == null) return null;
    return Math.abs(a - b);
  }
  function ratio(a, b) {
    if (a == null || b == null || a === 0 || b === 0) return null;
    return Math.max(a, b) / Math.min(a, b);
  }
  function circDeltaDeg(a, b) {
    if (a == null || b == null) return null;
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  }

  function reconcile(nowObs, modelNowRow, opts = {}) {
    const t = Object.assign({}, DEFAULTS, opts);

    const windSpeedDelta = delta(nowObs && nowObs.wind && nowObs.wind.speed, modelNowRow && modelNowRow.wind_speed);
    const waveHeightDelta = delta(nowObs && nowObs.wave && nowObs.wave.height, modelNowRow && modelNowRow.wave_height);
    const waveHeightRatio = ratio(nowObs && nowObs.wave && nowObs.wave.height, modelNowRow && modelNowRow.wave_height);
    const waveDirDelta    = circDeltaDeg(nowObs && nowObs.wave && nowObs.wave.dir_deg, modelNowRow && modelNowRow.wave_dir_deg);

    let verdict = 'agree';
    const reasons = [];

    if (windSpeedDelta != null) {
      if (windSpeedDelta > t.wind_speed_delta_kt_marginal) { verdict = 'mismatch'; reasons.push(`wind_speed |Δ|=${windSpeedDelta.toFixed(1)}kt > ${t.wind_speed_delta_kt_marginal}kt`); }
      else if (windSpeedDelta > t.wind_speed_delta_kt_agree && verdict === 'agree') { verdict = 'marginal'; reasons.push(`wind_speed |Δ|=${windSpeedDelta.toFixed(1)}kt > ${t.wind_speed_delta_kt_agree}kt`); }
    }
    if (waveHeightRatio != null) {
      if (waveHeightRatio > t.wave_height_ratio_marginal) { verdict = 'mismatch'; reasons.push(`wave_height ratio=${waveHeightRatio.toFixed(2)} > ${t.wave_height_ratio_marginal}`); }
      else if (waveHeightRatio > t.wave_height_ratio_agree && verdict !== 'mismatch') { verdict = 'marginal'; reasons.push(`wave_height ratio=${waveHeightRatio.toFixed(2)} > ${t.wave_height_ratio_agree}`); }
    }
    if (waveDirDelta != null) {
      if (waveDirDelta > t.wave_dir_delta_deg_marginal) { verdict = 'mismatch'; reasons.push(`wave_dir |Δ|=${waveDirDelta.toFixed(0)}° > ${t.wave_dir_delta_deg_marginal}°`); }
      else if (waveDirDelta > t.wave_dir_delta_deg_agree && verdict !== 'mismatch') { verdict = 'marginal'; reasons.push(`wave_dir |Δ|=${waveDirDelta.toFixed(0)}° > ${t.wave_dir_delta_deg_agree}°`); }
    }

    return {
      wind_speed_delta_kt: windSpeedDelta != null ? Math.round(windSpeedDelta * 10) / 10 : null,
      wave_height_delta_ft: waveHeightDelta != null ? Math.round(waveHeightDelta * 10) / 10 : null,
      wave_height_ratio: waveHeightRatio != null ? Math.round(waveHeightRatio * 100) / 100 : null,
      wave_dir_delta_deg: waveDirDelta != null ? Math.round(waveDirDelta) : null,
      verdict,
      reasons,
    };
  }

  /**
   * Walk the trip window hourly rows and find the worst consecutive interval
   * on wind_gust + wave_height + min wave_period.
   * Returns { start_iso, end_iso, max_wind_gust, max_wave_height, min_wave_period, dominant_dir_deg }.
   */
  function worstWindow(hourly, { minPeriodSeconds = 5, lookAheadHours = 3 } = {}) {
    if (!Array.isArray(hourly) || !hourly.length) return null;
    let worst = null;
    let i = 0;
    while (i < hourly.length) {
      const slice = hourly.slice(i, i + lookAheadHours).filter(r => r.wave_height != null);
      if (!slice.length) { i++; continue; }
      const maxGust  = Math.max(...slice.map(r => r.wind_gust || 0));
      const maxWave  = Math.max(...slice.map(r => r.wave_height || 0));
      const minPer   = Math.min(...slice.map(r => r.wave_period != null ? r.wave_period : Infinity));
      const dirs = slice.map(r => r.wave_dir_deg).filter(d => d != null);
      const dominantDir = dirs.length ? Math.round(dirs.reduce((a, b) => a + b, 0) / dirs.length) : null;
      const score = maxGust + 4 * maxWave + (minPer < minPeriodSeconds ? 5 : 0);
      if (!worst || score > worst.score) {
        worst = {
          score,
          start_iso: slice[0].iso,
          end_iso:   slice[slice.length - 1].iso,
          max_wind_gust: Math.round(maxGust * 10) / 10,
          max_wave_height: Math.round(maxWave * 10) / 10,
          min_wave_period: minPer === Infinity ? null : Math.round(minPer * 10) / 10,
          dominant_dir_deg: dominantDir,
        };
      }
      i++;
    }
    if (!worst) return null;
    delete worst.score; // don't leak the scoring heuristic to UI
    return worst;
  }

  const api = Object.freeze({ reconcile, worstWindow, DEFAULTS });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.TripReconciler = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
