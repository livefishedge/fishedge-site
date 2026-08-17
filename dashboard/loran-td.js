/* dashboard/loran-td.js
 *
 * Loran-C GRI 9960 Time Difference (TD) grid layer for the FishEdge dashboard.
 *
 * Renders a pre-generated GeoJSON of hyperbolic isolines (9960-X Nantucket
 * and 9960-Y Cape Fear secondary pairs) as an OL Vector layer over the
 * combined view. Region-scoped to usec_md (the only region the upstream
 * generate_td_grid.py currently produces a grid for).
 *
 * Single global: window.LoranTdController
 *
 * API:
 *   LoranTdController.enable()       — fetch GeoJSON (if needed), add layer
 *                                       to map, set visible.
 *   LoranTdController.disable()      — remove layer from map (keeps cache).
 *   LoranTdController.toggle(visible)— show/hide without removing.
 *   LoranTdController.isEnabled()    — boolean.
 *
 * Color conventions match the standalone viewer the user started from:
 *   9960-X (Nantucket):  #d9534f  (red)
 *   9960-Y (Cape Fear):  #0275d8  (blue)
 *   Major lines:         2.0 px, opacity 0.85
 *   Minor lines:         0.8 px, opacity 0.55
 *
 * zIndex: 8 — below daily products (chl/sst at z=10), above the bathy
 *           reference layer (default 0). The TD grid is a navigation
 *           reference; captains want to see it overlayed but not block
 *           the daily chlorophyll / SST fronts they're reading for.
 *
 * Branch: feat/loran-td-grid-usec-md
 */
(function (global) {
  "use strict";

  // ── Configuration ───────────────────────────────────────────────────
  const CONFIG = {
    // Path is relative to /dashboard/ where index.html lives.
    GEOJSON_URL: "loran/td_grid_9960_usec_md.geojson",
    REGION: "usec_md",
    Z_INDEX: 8,
    STYLES: {
      "9960-X": { color: "#d9534f" },
      "9960-Y": { color: "#0275d8" },
    },
    MAJOR_WIDTH: 2.0,
    MAJOR_OPACITY: 0.85,
    MINOR_WIDTH: 0.8,
    MINOR_OPACITY: 0.55,
  };

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    enabled: false,
    loaded: false,
    loading: null,    // Promise in flight (deduplicates concurrent enables)
    layer: null,      // ol.layer.Vector
    source: null,     // ol.source.Vector
    fetchErr: null,
  };

  // ── Style factory ───────────────────────────────────────────────────
  function styleFor(feature) {
    const props = feature.getProperties();
    const pair = props.pair;
    const lineType = props.type; // "major" | "minor"
    const cfg = CONFIG.STYLES[pair] || { color: "#888" };
    const isMajor = lineType === "major";
    return new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: cfg.color,
        width: isMajor ? CONFIG.MAJOR_WIDTH : CONFIG.MINOR_WIDTH,
        opacity: isMajor ? CONFIG.MAJOR_OPACITY : CONFIG.MINOR_OPACITY,
        lineCap: "round",
        lineJoin: "round",
      }),
    });
  }

  function tdTooltip(feature) {
    const props = feature.getProperties();
    const td = Number(props.td || 0).toFixed(1);
    return `${props.pair}  ${td} µs  (${props.type})`;
  }

  // ── Region guard ────────────────────────────────────────────────────
  function regionOk() {
    const rid = (typeof REGION_ID !== "undefined") ? REGION_ID
              : (global.REGION_ID || null);
    if (!rid) return false;
    if (rid !== CONFIG.REGION) {
      console.info(
        `[loran-td] Loran-C TD grid is only generated for ${CONFIG.REGION} ` +
        `(current region: ${rid}). Layer disabled.`
      );
      return false;
    }
    return true;
  }

  function getCombinedMap() {
    return global._combinedMap || null;
  }

  // ── Load GeoJSON once and cache ─────────────────────────────────────
  function loadGeoJSON() {
    if (state.loaded) return Promise.resolve(state.source);
    if (state.loading) return state.loading;

    state.loading = fetch(CONFIG.GEOJSON_URL, { cache: "force-cache" })
      .then((res) => {
        if (!res.ok) throw new Error(
          `Failed to fetch ${CONFIG.GEOJSON_URL}: ${res.status} ${res.statusText}`
        );
        return res.json();
      })
      .then((gj) => {
        const features = new ol.format.GeoJSON().readFeatures(gj, {
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857",
        });
        const source = new ol.source.Vector({ features });
        state.source = source;
        state.loaded = true;
        state.loading = null;
        return source;
      })
      .catch((err) => {
        state.fetchErr = err;
        state.loading = null;
        console.error("[loran-td] GeoJSON load failed:", err);
        throw err;
      });

    return state.loading;
  }

  // ── Build the VectorLayer (after source loaded) ─────────────────────
  function buildLayer(source) {
    const layer = new ol.layer.Vector({
      source,
      style: styleFor,
      zIndex: CONFIG.Z_INDEX,
      updateWhileAnimating: false,
      updateWhileInteracting: false,
    });
    // Per-feature tooltip on hover (sticky follows the cursor).
    layer.on("pointermove", (evt) => {
      if (evt.dragging) return;
      const hit = layer.getFeatures(evt.pixel);
      const target = global.document.getElementById("map");
      if (target) target.style.cursor = hit ? "help" : "";
    });
    return layer;
  }

  // ── Public API ──────────────────────────────────────────────────────
  async function enable() {
    if (!regionOk()) return false;
    const map = getCombinedMap();
    if (!map) {
      console.warn("[loran-td] _combinedMap not present; deferring.");
      return false;
    }
    if (state.enabled && state.layer) {
      state.layer.setVisible(true);
      return true;
    }
    try {
      const source = await loadGeoJSON();
      if (!state.layer) {
        state.layer = buildLayer(source);
        map.addLayer(state.layer);
      }
      state.layer.setVisible(true);
      state.enabled = true;
      return true;
    } catch (err) {
      // loadGeoJSON already logged; just surface the failure to the toggle.
      return false;
    }
  }

  function disable() {
    if (state.layer) state.layer.setVisible(false);
    state.enabled = false;
  }

  function toggle(visible) {
    if (visible) {
      enable();
    } else {
      disable();
    }
  }

  function isEnabled() {
    return Boolean(state.enabled && state.layer && state.layer.getVisible());
  }

  function isRegionSupported() {
    return regionOk();
  }

  // ── Expose ──────────────────────────────────────────────────────────
  global.LoranTdController = {
    enable,
    disable,
    toggle,
    isEnabled,
    isRegionSupported,
    CONFIG,
    _state: state, // exposed for debugging only; do not depend on shape
  };
})(window);