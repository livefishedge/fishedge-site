/**
 * bathy-perf-monitor.js
 * ──────────────────────
 * Passive freeze detector for bathymetry moveend → updateBathyContours.
 *
 * Always-on (no ?flag needed) — zero cost when not needed.
 * Every freeze (>500ms) fires posthog.capture('bathy_freeze').
 *
 * Dev/debug mode: add ?bathy_perf=1 to the dashboard URL to:
 *   - See [bathy-perf] console warnings per freeze
 *   - Store last 200 events in localStorage['bathy_perf']
 *   - Get a 60s SLA summary in the console
 *
 * Read the log afterward:
 *   console.table(JSON.parse(localStorage.getItem('bathy_perf')||'[]').filter(e=>e.type.includes('FREEZE')))
 */

(function () {
  "use strict";
  if (typeof window === "undefined") return;

  var THRESHOLD_MS    = 500;
  var RING_BUFFER_MAX = 200;
  var STORAGE_KEY     = "bathy_perf";
  var DEV_MODE        = new URLSearchParams(location.search).get("bathy_perf") === "1";

  // ── Utilities ──────────────────────────────────────────────────────
  function round(v) { return Math.round(v * 100) / 100; }

  function getViewportBbox(map) {
    try {
      var ext = map.getView().calculateExtent(map.getSize());
      var prj = map.getView().getProjection().getCode();
      if (prj !== "EPSG:4326") ext = ol.proj.transformExtent(ext, prj, "EPSG:4326");
      return { w: round(ext[0]), s: round(ext[1]), e: round(ext[2]), n: round(ext[3]) };
    } catch (_) { return null; }
  }

  function getZoom(map) {
    try { return round(map.getView().getZoom()); } catch (_) { return null; }
  }

  function isVisible(layer) {
    try { return !!(layer && layer.getVisible()); } catch (_) { return false; }
  }

  // ── Ring-buffer store ───────────────────────────────────────────────
  var ring = [];
  function push(entry) {
    ring.push(entry);
    if (ring.length > RING_BUFFER_MAX) ring.shift();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ring)); } catch (_) {}
  }

  function log(msg, data) {
    if (DEV_MODE) console.log("[bathy-perf]", msg, data || "");
  }

  // ── Silent PostHog capture ──────────────────────────────────────────
  function phCapture(entry) {
    try {
      if (window.posthog && window.posthog.capture) {
        window.posthog.capture("bathy_freeze", {
          duration_ms:   entry.durationMs,
          threshold_ms:  entry.thresholdMs,
          zoom:          entry.zoom,
          bbox_w:        entry.bbox ? entry.bbox.w : null,
          bbox_s:        entry.bbox ? entry.bbox.s : null,
          bbox_e:        entry.bbox ? entry.bbox.e : null,
          bbox_n:        entry.bbox ? entry.bbox.n : null,
          layer_visible: entry.layerVisible,
          map_label:     entry.mapLabel,
          type:          entry.type,
        });
      }
    } catch (_) {}
  }

  // ── Instrument updateBathyContours ─────────────────────────────────
  var originalUpdateBathyContours = typeof window.updateBathyContours === "function"
    ? window.updateBathyContours
    : null;

  function wrapUpdateBathyContours(map, bd, layer, mapLabel) {
    if (!originalUpdateBathyContours) return;

    var t0     = performance.now();
    var visible = isVisible(layer);
    var zoom   = getZoom(map);
    var bbox   = getViewportBbox(map);

    originalUpdateBathyContours.call(null, map, bd, layer);

    var dur    = performance.now() - t0;
    var frozen = dur > THRESHOLD_MS;

    var entry = {
      ts:          new Date().toISOString(),
      type:        frozen ? "FREEZE" : "ok",
      durationMs:  round(dur),
      thresholdMs: THRESHOLD_MS,
      zoom:        zoom,
      bbox:        bbox,
      layerVisible: visible,
      mapLabel:    mapLabel,
      suspected:   frozen ? "updateBathyContours sync block" : null,
    };

    push(entry);
    if (frozen) {
      phCapture(entry);
      if (DEV_MODE) {
        console.warn("[bathy-perf] FREEZE " + dur.toFixed(0) + "ms > " + THRESHOLD_MS + "ms"
          + " | " + mapLabel + " | zoom=" + zoom + " | bbox=" + JSON.stringify(bbox)
          + " | visible=" + visible);
      }
    }
  }

  if (originalUpdateBathyContours) {
    window.updateBathyContours = function (map, bd, layer) {
      wrapUpdateBathyContours(map, bd, layer, "desktop");
    };
    log("instrumented updateBathyContours (threshold=" + THRESHOLD_MS + "ms)");
  }

  // ── Debounced bathy moveend wrappers ───────────────────────────────
  // Applied to the 3 map instances that own bathy contours.
  // Debounce window: 180ms — enough to coalesce zoom-gesture bursts,
  // short enough to feel instantaneous on release.
  function makeDebouncedBathyMoveend(getMap, getLayer, label) {
    var timer = null;
    return function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var map   = getMap();
        var layer = getLayer();
        if (!map || !isVisible(layer)) return;
        // Delegate to the instrumented updateBathyContours
        if (originalUpdateBathyContours) {
          wrapUpdateBathyContours(map, null, layer, label);
        }
      }, 180);
    };
  }

  // ── Instrument map moveend handlers once map is ready ──────────────
  function instrumentMapWhenReady(getMap, getLayer, label) {
    var attempts = 0;
    var maxAttempts = 50;
    var interval = setInterval(function () {
      var map = getMap();
      attempts++;
      if (map) {
        clearInterval(interval);
        // Remove any existing bathy moveend listeners to avoid doubling up
        // when this script is hot-reloaded. The OL listener key stores the
        // handler function reference, so we track it on the map state.
        var state = label === "mobile" ? window.mobileMapState
               : label === "combined" ? null
               : window.desktopMapState;
        if (state && state.__bathyMoveendKey) {
          try { ol.Observable.unByKey(state.__bathyMoveendKey); } catch (_) {}
          state.__bathyMoveendKey = null;
        }
        var debouncedHandler = makeDebouncedBathyMoveend(getMap, getLayer, label);
        var key = map.on("moveend", debouncedHandler);
        if (state) state.__bathyMoveendKey = key;
        log("instrumented " + label + " moveend (debounced 180ms)");
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        log("could not find map for " + label + " after " + maxAttempts + " attempts");
      }
    }, 200);
  }

  instrumentMapWhenReady(
    function () { return window.desktopMapState && window.desktopMapState.map; },
    function () { return window.desktopMapState && window.desktopMapState.bathyContourLayer; },
    "desktop"
  );
  instrumentMapWhenReady(
    function () { return window.mobileMapState && window.mobileMapState.map; },
    function () { return window.mobileMapState && window.mobileMapState.bathyContourLayer; },
    "mobile"
  );
  instrumentMapWhenReady(
    function () { return window._combinedMap; },
    function () { return null; },   // combined uses updateBathyContoursForMap directly
    "combined"
  );

  // ── Dev-mode summary ────────────────────────────────────────────────
  if (DEV_MODE) {
    console.log(
      "%c[bathy-perf] Active — freeze log: localStorage['" + STORAGE_KEY + "']",
      "background:#7b2ff7;color:#fff;padding:2px 6px;border-radius:3px"
    );
    setInterval(function () {
      if (!ring.length) return;
      var freezes = ring.filter(function (e) { return e.type === "FREEZE"; });
      var sla = Math.round((1 - freezes.length / ring.length) * 100);
      log("60s SLA summary: " + ring.length + " moveends, " + freezes.length + " freezes, SLA=" + sla + "%");
      if (freezes.length) console.warn("[bathy-perf] Last freeze:", freezes[freezes.length - 1]);
    }, 60000);
  }

  log("bathy-perf monitor ready (threshold=" + THRESHOLD_MS + "ms, debounce=180ms)");
})();
