/* dashboard/loran-td.js
 *
 * Loran-C GRI 9960 Time Difference (TD) grid layer for the FishEdge dashboard.
 *
 * Renders a pre-generated GeoJSON of hyperbolic isolines (9960-X Nantucket
 * and 9960-Y Cape Fear secondary pairs) as an OL Vector layer over the
 * combined view. Region-scoped to usec_md (the only region the upstream
 * generate_td_grid.py currently produces a grid for).
 *
 * Two stacked layers:
 *   1. Line layer (zIndex 8): all isolines, single 10 µs step, thin stroke.
 *   2. Label layer (zIndex 9): one Point per line at the line's centroid,
 *      showing the TD value in µs. Hidden until map zoom exceeds LABEL_MIN_ZOOM.
 *
 * Single global: window.LoranTdController
 *
 * API:
 *   LoranTdController.enable()       — fetch GeoJSON (if needed), add both
 *                                       layers to map, set visible.
 *   LoranTdController.disable()      — hide both layers (keeps cache).
 *   LoranTdController.toggle(visible)— show/hide without removing.
 *   LoranTdController.isEnabled()    — boolean.
 *   LoranTdController.isRegionSupported() — true if REGION_ID === "usec_md".
 *
 * Color conventions:
 *   9960-X (Nantucket):  #d9534f  (red)
 *   9960-Y (Cape Fear):  #0275d8  (blue)
 *   All lines:           0.8 px, opacity 0.65 (single weight per Mike spec)
 *   Labels:              bold 11px monospace, line-color fill, dark halo.
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
    LABEL_Z_INDEX: 9,
    LABEL_MIN_ZOOM: 5,           // hide labels at zoom <= this
    STYLES: {
      "9960-X": { color: "#d9534f" },
      "9960-Y": { color: "#0275d8" },
    },
    LINE_WIDTH: 0.8,             // single uniform weight (Mike: "all thin")
    LINE_OPACITY: 0.65,
  };

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    enabled: false,
    loaded: false,
    loading: null,
    lineLayer: null,
    lineSource: null,
    labelLayer: null,
    labelSource: null,
    fetchErr: null,
  };

  // ── Helpers ─────────────────────────────────────────────────────────
  // Web Mercator: resolution = 156543.03390625 / 2^zoom
  function resolutionToZoom(resolution) {
    if (!resolution || resolution <= 0) return 0;
    return Math.log2(156543.03390625 / resolution);
  }

  function centroidOf(coords) {
    let sx = 0, sy = 0, n = 0;
    for (const c of coords) { sx += c[0]; sy += c[1]; n++; }
    if (n === 0) return null;
    return [sx / n, sy / n];
  }

  function buildLabelFeatures(lineFeatures) {
    const labels = [];
    for (const f of lineFeatures) {
      const coords = f.getGeometry().getCoordinates();
      if (!coords || coords.length < 2) continue;
      const pt = centroidOf(coords);
      if (!pt) continue;
      labels.push(new ol.Feature({
        geometry: new ol.geom.Point(pt),
        pair: f.get("pair"),
        td: f.get("td"),
        kind: "td-label",
      }));
    }
    return labels;
  }

  // ── Style factories ─────────────────────────────────────────────────
  function lineStyleFor(feature) {
    const props = feature.getProperties();
    const cfg = CONFIG.STYLES[props.pair] || { color: "#888" };
    return new ol.style.Style({
      stroke: new ol.style.Stroke({
        color: cfg.color,
        width: CONFIG.LINE_WIDTH,
        opacity: CONFIG.LINE_OPACITY,
        lineCap: "round",
        lineJoin: "round",
      }),
    });
  }

  function labelStyleFor(feature, resolution) {
    const zoom = resolutionToZoom(resolution);
    if (zoom <= CONFIG.LABEL_MIN_ZOOM) return null;
    const props = feature.getProperties();
    const cfg = CONFIG.STYLES[props.pair] || { color: "#888" };
    const td = Number(props.td || 0);
    return new ol.style.Style({
      text: new ol.style.Text({
        text: String(Math.round(td)),
        font: '600 11px ui-monospace, "SF Mono", "Menlo", "Consolas", monospace',
        fill: new ol.style.Fill({ color: cfg.color }),
        stroke: new ol.style.Stroke({
          color: "rgba(0, 0, 0, 0.85)",
          width: 2.5,
          lineCap: "round",
          lineJoin: "round",
        }),
        overflow: false,
        textAlign: "center",
        textBaseline: "middle",
        padding: [1, 2, 1, 2],
        offsetY: 0,
      }),
    });
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
    if (state.loaded) return Promise.resolve(state.lineSource);
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
        state.lineSource = source;
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

  // ── Build the LineString layer ──────────────────────────────────────
  function buildLineLayer(source) {
    const layer = new ol.layer.Vector({
      source,
      style: lineStyleFor,
      zIndex: CONFIG.Z_INDEX,
      updateWhileAnimating: false,
      updateWhileInteracting: false,
    });
    layer.on("pointermove", (evt) => {
      if (evt.dragging) return;
      const hit = layer.getFeatures(evt.pixel);
      const target = global.document.getElementById("map");
      if (target) target.style.cursor = hit ? "help" : "";
    });
    return layer;
  }

  // ── Build the label layer ───────────────────────────────────────────
  function buildLabelLayer(lineSource) {
    const labels = buildLabelFeatures(lineSource.getFeatures());
    const source = new ol.source.Vector({ features: labels });
    state.labelSource = source;
    return new ol.layer.Vector({
      source,
      style: labelStyleFor,
      zIndex: CONFIG.LABEL_Z_INDEX,
      declutter: true,
      updateWhileAnimating: false,
      updateWhileInteracting: false,
    });
  }

  // ── Public API ──────────────────────────────────────────────────────
  async function enable() {
    if (!regionOk()) return false;
    const map = getCombinedMap();
    if (!map) {
      console.warn("[loran-td] _combinedMap not present; deferring.");
      return false;
    }
    if (state.enabled && state.lineLayer) {
      state.lineLayer.setVisible(true);
      if (state.labelLayer) state.labelLayer.setVisible(true);
      return true;
    }
    try {
      const source = await loadGeoJSON();
      if (!state.lineLayer) {
        state.lineLayer = buildLineLayer(source);
        map.addLayer(state.lineLayer);
      }
      if (!state.labelLayer) {
        state.labelLayer = buildLabelLayer(source);
        map.addLayer(state.labelLayer);
      }
      state.lineLayer.setVisible(true);
      state.labelLayer.setVisible(true);
      state.enabled = true;
      return true;
    } catch (err) {
      return false;
    }
  }

  function disable() {
    if (state.lineLayer) state.lineLayer.setVisible(false);
    if (state.labelLayer) state.labelLayer.setVisible(false);
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
    return Boolean(
      state.enabled && state.lineLayer && state.lineLayer.getVisible()
    );
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