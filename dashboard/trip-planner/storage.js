/*!
 * FishEdge Planner Storage — localStorage helpers.
 *
 * Keys:
 *   fishedge:planner:savedInlet   → string (inlet key, e.g. "ocean-city-md")
 *   fishedge:planner:trips        → JSON array of saved TripPlan shapes
 *
 * Trip shape:
 *   { id, name, inlet_key, target_id, target_area, departure_iso, return_iso,
 *     created_iso, last_opened_iso }
 *
 * Phase 4+ will add server-side persistence via Supabase (per-user).
 * Until then, localStorage is the canonical store. Same code shape —
 * swap the read/write functions when server-side lands.
 */
(function attachStorage(global) {
  'use strict';
  const NS = 'fishedge:planner:';
  const KEY_INLET = NS + 'savedInlet';
  const KEY_TRIPS = NS + 'trips';

  function safeGet(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function safeSet(key, val) {
    try { localStorage.setItem(key, val); return true; } catch (_) { return false; }
  }
  function safeRemove(key) {
    try { localStorage.removeItem(key); return true; } catch (_) { return false; }
  }

  function getSavedInlet() {
    const v = safeGet(KEY_INLET);
    return v && v.length ? v : null;
  }
  function setSavedInlet(inletKey) {
    if (inletKey == null) { safeRemove(KEY_INLET); return false; }
    return safeSet(KEY_INLET, String(inletKey));
  }

  function _readTrips() {
    const raw = safeGet(KEY_TRIPS);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) { return []; }
  }
  function _writeTrips(arr) {
    return safeSet(KEY_TRIPS, JSON.stringify(arr));
  }
  function genId() {
    return 't_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  function listTrips() {
    return _readTrips().sort((a, b) => (b.last_opened_iso || b.created_iso).localeCompare(a.last_opened_iso || a.created_iso));
  }
  function saveTrip(partial) {
    if (!partial) return null;
    const now = new Date().toISOString();
    const trip = Object.assign({
      id: genId(),
      name: 'Untitled trip',
      inlet_key: null,
      target_id: 'baltimore_canyon_line',
      target_area: null,
      departure_iso: null,
      return_iso: null,
      created_iso: now,
      last_opened_iso: now,
    }, partial, { id: partial.id || genId(), created_iso: partial.created_iso || now, last_opened_iso: now });
    const trips = _readTrips();
    const existingIdx = trips.findIndex(t => t.id === trip.id);
    if (existingIdx >= 0) trips[existingIdx] = trip; else trips.push(trip);
    _writeTrips(trips);
    return trip;
  }
  function deleteTrip(id) {
    const trips = _readTrips().filter(t => t.id !== id);
    _writeTrips(trips);
    return true;
  }
  function loadTrip(id) {
    const trip = _readTrips().find(t => t.id === id);
    if (!trip) return null;
    trip.last_opened_iso = new Date().toISOString();
    _writeTrips(_readTrips().map(t => t.id === id ? trip : t));
    return trip;
  }

  const api = Object.freeze({
    getSavedInlet, setSavedInlet,
    listTrips, saveTrip, loadTrip, deleteTrip,
    NS, KEY_INLET, KEY_TRIPS,
  });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FishEdgeTripStorage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
