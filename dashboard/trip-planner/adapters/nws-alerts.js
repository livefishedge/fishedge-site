/*!
 * NWS Active Alerts adapter — CAP-format marine alerts by lat/lon
 * Doc: https://www.weather.gov/documentation/services-web-api
 *
 * Endpoints:
 *   /points/{lat},{lon}      → grid metadata + forecast zone
 *   /alerts/active?point=…  → active alerts touching that point
 *
 * Real-time semantics: PUSH_OBSERVATION. NWS pushes alerts within seconds
 * of issuance. The freshness badge says "Active now" + the alert's
 * `effective` timestamp.
 *
 * IMPORTANT: a `User-Agent` header is required by api.weather.gov.
 * The dashboard cannot supply one via `fetch()` in a browser without
 * CORS, so the production deployment routes this through a Cloudflare
 * Worker proxy. Dev MVP calls directly from the server-side test harness.
 */
(function attachNwsAlerts(global) {
  'use strict';
  const FishEdgeTripPlanner = global.FishEdgeTripPlanner || require('./index.js');

  const NWS_BASE = 'https://api.weather.gov';
  const UA = 'FishEdge-dev (ops@fishedge.live)';

  function buildPointsUrl(lat, lon) {
    return `${NWS_BASE}/points/${lat},${lon}`;
  }
  function buildAlertsUrl(lat, lon) {
    return `${NWS_BASE}/alerts/active?point=${lat},${lon}`;
  }

  /**
   * Fetch the active alerts touching a lat/lon.
   * Returns [] when there are no active alerts.
   */
  async function fetchActiveAlerts(lat, lon, opts = {}, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
    if (!fetchImpl) throw new Error('No fetch implementation available');
    const url = buildAlertsUrl(lat, lon);
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'application/geo+json' },
    });
    if (res.status === 500) return []; // NWS returns 500 for "no alerts" in some edge cases
    if (!res.ok) throw new Error(`NWS alerts HTTP ${res.status}`);
    const json = await res.json();
    return normalizeAlerts(json, lat, lon);
  }

  /**
   * Convert NWS CAP alerts to captain-conditions-v1 alert rows.
   */
  function normalizeAlerts(json, lat, lon) {
    const feats = (json && json.features) || [];
    const out = [];
    for (const f of feats) {
      const p = f.properties || {};
      out.push({
        id: p['@id'] || (f.id),
        event: p.event,
        headline: p.headline,
        area: p.areaDesc,
        severity: p.severity,           // 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown'
        certainty: p.certainty,         // 'Observed' | 'Likely' | 'Possible' | 'Unlikely' | 'Unknown'
        urgency: p.urgency,
        effective: p.effective,
        expires: p.expires,
        sender: p.senderName,
        zone: (p.geocode && p.geocode.SAME) || null,
        lat, lon,
        freshness: FishEdgeTripPlanner.FRESHNESS.PUSH_OBSERVATION,
        source: {
          provider: 'NWS',
          station_id: null,
          observation_time: p.effective,
          retrieved_time: new Date().toISOString(),
          age_minutes: p.effective ? Math.round((Date.now() - Date.parse(p.effective)) / 60000) : 0,
          quality_flag: 'cap_alert',
        },
      });
    }
    return out;
  }

  /**
   * Fetch the points metadata so we can also surface the marine zone id
   * (e.g. ANZ455) for the captain.
   */
  async function fetchPointsMetadata(lat, lon, fetchImpl = (typeof fetch !== 'undefined' ? fetch : null)) {
    if (!fetchImpl) throw new Error('No fetch implementation available');
    const url = buildPointsUrl(lat, lon);
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { 'User-Agent': UA, 'Accept': 'application/geo+json' },
    });
    if (!res.ok) throw new Error(`NWS points HTTP ${res.status}`);
    const json = await res.json();
    const p = (json && json.properties) || {};
    return {
      forecast_office: p.forecastOffice,
      grid_id: p.gridId,
      grid_x: p.gridX,
      grid_y: p.gridY,
      forecast_zone: p.forecastZone,
      time_zone: p.timeZone,
      radar_station: p.radarStation,
    };
  }

  /**
   * Returns true if any alert has severity in {Extreme, Severe} or event
   * mentions "Hurricane", "Storm Warning", "Gale Warning", or "Special Marine Warning".
   * Used by the decision engine to force NO_GO.
   */
  function isHardStop(alerts) {
    if (!alerts || !alerts.length) return false;
    const HARD = /Hurricane Force|Hurricane|Storm Warning|Gale Warning|Special Marine Warning/i;
    return alerts.some(a => HARD.test(a.event) || ['Extreme', 'Severe'].includes(a.severity));
  }

  const api = Object.freeze({
    fetchActiveAlerts,
    fetchPointsMetadata,
    normalizeAlerts,
    isHardStop,
    buildAlertsUrl,
    buildPointsUrl,
    NWS_BASE,
    UA,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.NwsAlerts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
