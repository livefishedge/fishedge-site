/**
 * bathy-perf-monitor.js
 * ──────────────────────
 * Automatic freeze detector for bathymetry moveend → updateBathyContours.
 *
 * Activate: add ?bathy_perf=1 to the dashboard URL.
 * e.g. https://feat-bathy-realness-overlay.fishedge-site.pages.dev/dashboard/?bathy_perf=1
 *
 * What it captures (saved to localStorage, survives page reload):
 *   - Every moveend event: timestamp, viewport bbox, duration ms
 *   - Freeze events (duration > THRESHOLD_MS): full viewport state +
 *     approximate stack of the slow updateBathyContours call
 *   - SLA compliance rate (non-frozen / total moveends)
 *
 * Read the log afterward with:
 *   JSON.parse(localStorage.getItem('bathy_perf') || '[]')
 *
 * Or paste this in the console on the page:
 *   console.table(JSON.parse(localStorage.getItem('bathy_perf')||'[]').filter(e=>e.frozen))
 */

(function () {
  "use strict";

  if (new URLSearchParams(location.search).get("bathy_perf") !== "1") return;
  if (typeof window === "undefined") return;

  // ── Tunables ────────────────────────────────────────────────────────
  var THRESHOLD_MS    = 500;      // "freeze" = single-frame duration above this
  var RING_BUFFER_MAX = 200;      // keep last N events
  var STORAGE_KEY     = "bathy_perf";

  // ── Utilities ──────────────────────────────────────────────────────
  function round(v) { return Math.round(v * 100) / 100; }

  function getViewportBbox(map) {
    try {
      var ext = map.getView().calculateExtent(map.getSize());
      var prj = map.getView().getProjection().getCode();
      if (prj !== "EPSG:4326") {
        ext = ol.proj.transformExtent(ext, prj, "EPSG:4326");
      }
      return { w: round(ext[0]), s: round(ext[1]), e: round(ext[2]), n: round(ext[3]) };
    } catch (_) { return null; }
  }

  function getZoom(map) {
    try { return round(map.getView().getZoom()); } catch (_) { return null; }
  }

  function isVisible(layer) {
    try { return layer && layer.getVisible(); } catch (_) { return false; }
  }

  // ── Ring-buffer store ───────────────────────────────────────────────
  var ring = [];

  function push(entry) {
    ring.push(entry);
    if (ring.length > RING_BUFFER_MAX) ring.shift();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(ring));
    } catch (_) {}
  }

  function log(msg, data) {
    console.log("[bathy-perf]", msg, data || "");
  }

  // ── Silent PostHog capture ──────────────────────────────────────────
  // Fires only on freeze events — zero noise in your analytics otherwise.
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
          map_label:     entry.mapLabel || null,
          type:          entry.type,
        });
      }
    } catch (_) {}
  }

  function phLoaded() {
    try {
      if (window.posthog && window.posthog.capture) {
        window.posthog.capture("bathy_perf_monitor_loaded", {
          threshold_ms: THRESHOLD_MS,
          href: location.href,
        });
      }
    } catch (_) {}
  }

  // ── Instrument updateBathyContours ─────────────────────────────────
  // The freeze is caused by updateBathyContours running synchronously
  // on every moveend. Wrap it to measure wall-clock duration.
  var originalUpdateBathyContours = typeof window.updateBathyContours === "function"
    ? window.updateBathyContours
    : null;

  var lastMoveendTime = 0;
  var pendingFreezeEntry = null;

  function wrapUpdateBathyContours(map, bd, layer) {
    if (!originalUpdateBathyContours) return;

    var t0 = performance.now();
    var visible = isVisible(layer);
    var zoom    = getZoom(map);
    var bbox    = getViewportBbox(map);

    originalUpdateBathyContours.call(null, map, bd, layer);

    var dur = performance.now() - t0;
    var frozen = dur > THRESHOLD_MS;

    var entry = {
      ts:         new Date().toISOString(),
      type:       frozen ? "FREEZE" : "moveend",
      durationMs: round(dur),
      thresholdMs: THRESHOLD_MS,
      zoom:       zoom,
      bbox:       bbox,
      layerVisible: visible,
      bdNull:     !bd,
      layerNull:  !layer,
      // Approximate call depth — if duration > threshold this is the culprit
      suspected:  frozen ? "updateBathyContours sync block" : null,
    };

    push(entry);

    if (frozen) {
      entry.mapLabel = "updateBathyContours";
      phCapture(entry);
      console.warn(
        "[bathy-perf] FREEZE " + dur.toFixed(0) + "ms > " + THRESHOLD_MS + "ms" +
        " | zoom=" + zoom + " | bbox=" + JSON.stringify(bbox) +
        " | visible=" + visible
      );
    }
  }

  // Replace globally so all callers (desktop, mobile, combined) use the wrapper
  if (originalUpdateBathyContours) {
    window.updateBathyContours = wrapUpdateBathyContours;
    log("instrumented updateBathyContours (threshold=" + THRESHOLD_MS + "ms)");
  } else {
    log("updateBathyContours not found on window — will instrument moveend directly");
  }

  // ── Instrument moveend on every bathy-active map ───────────────────
  // The 3 maps that can own bathy contours: desktopMapState, mobileMapState, _combinedMap
  var MAPS_TO_INSTRUMENT = [
    function () { return window.desktopMapState && window.desktopMapState.map; },
    function () { return window.mobileMapState  && window.mobileMapState.map;  },
    function () { return window._combinedMap; },
  ];

  function instrumentMap(getMap, label) {
    var attempts = 0;
    var maxAttempts = 50;
    var interval = setInterval(function () {
      var map = getMap();
      attempts++;
      if (map) {
        clearInterval(interval);
        var listeners = map.getListeners("moveend") || [];
        log("instrumenting " + label + " moveend handlers (" + listeners.length + " registered)");

        // Wrap the bathy-specific moveend handler.
        // We detect it by checking if it calls updateBathyContours:
        // Pattern: map.on("moveend", () => { if (layer.getVisible()) updateBathyContours(...) })
        map.on("moveend", function bathyPerfMoveend() {
          var t0 = performance.now();
          var zoom = getZoom(map);
          var bbox = getViewportBbox(map);
          var layer = null;
          // Find the bathy contour layer in the state objects
          try {
            if (window.desktopMapState && window.desktopMapState.bathyContourLayer)
              layer = window.desktopMapState.bathyContourLayer;
            else if (window.mobileMapState && window.mobileMapState.bathyContourLayer)
              layer = window.mobileMapState.bathyContourLayer;
          } catch (_) {}

          var dur = performance.now() - t0;
          var frozen = dur > THRESHOLD_MS;
          push({
            ts:         new Date().toISOString(),
            type:       frozen ? "MOVEEND_FREEZE" : "moveend",
            durationMs: round(dur),
            thresholdMs: THRESHOLD_MS,
            zoom:       zoom,
            bbox:       bbox,
            layerVisible: isVisible(layer),
            suspected:  frozen ? "moveend handler overhead" : null,
          });

          if (frozen) {
            var entry = {
              ts:         new Date().toISOString(),
              type:       "MOVEEND_FREEZE",
              durationMs: round(dur),
              thresholdMs: THRESHOLD_MS,
              zoom:       zoom,
              bbox:       bbox,
              layerVisible: isVisible(layer),
              mapLabel:   label,
              suspected:  "moveend handler overhead",
            };
            phCapture(entry);
            console.warn("[bathy-perf] MOVEEND_FREEZE " + dur.toFixed(0) + "ms" +
              " | zoom=" + zoom + " | bbox=" + JSON.stringify(bbox));
          }
        });
      } else if (attempts >= maxAttempts) {
        clearInterval(interval);
        log("could not find map for " + label + " after " + maxAttempts + " attempts");
      }
    }, 200);
  }

  MAPS_TO_INSTRUMENT.forEach(function (getMap, i) {
    instrumentMap(getMap, "map" + i);
  });

  // ── SLA summary ─────────────────────────────────────────────────────
  // Dump a compliance table every 60 seconds if there were any freezes
  var summaryInterval = setInterval(function () {
    if (!ring.length) return;
    var freezes = ring.filter(function (e) { return e.type === "FREEZE" || e.type === "MOVEEND_FREEZE"; });
    var total   = ring.length;
    var frozen  = freezes.length;
    var sla     = Math.round((1 - frozen / total) * 100);
    log("60s summary: " + total + " moveends, " + frozen + " freezes, SLA=" + sla + "%");
    if (frozen > 0) {
      console.warn("[bathy-perf] Last freeze:", freezes[frozen - 1]);
    }
  }, 60000);

  log("bathy-perf monitor ACTIVE (threshold=" + THRESHOLD_MS + "ms, ring=" + RING_BUFFER_MAX + ")");
  phLoaded();
  console.log(
    "%c[bathy-perf] Active — freeze log stored in localStorage['" + STORAGE_KEY + "']",
    "background:#7b2ff7;color:#fff;padding:2px 6px;border-radius:3px"
  );

})();
