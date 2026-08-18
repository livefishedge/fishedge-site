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
 *   2. Label layer (zIndex 9): TD value labels at every 50 µs step,
 *      positioned where each line crosses the current viewport edges
 *      (top / bottom / left / right). Labels rotate to match their line's
 *      tangent angle so they read parallel to the line. Recomputed on every
 *      map moveend so they follow as the captain pans / zooms.
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
 *   Labels:              bold 11px monospace, line-color fill, dark halo,
 *                        rotated parallel to the line direction.
 *
 * Branch: feat/loran-td-grid-usec-md
 */
(function (global) {
  "use strict";

  // ── Configuration ───────────────────────────────────────────────────
  const CONFIG = {
    GEOJSON_URL:    "loran/td_grid_9960_usec_md.geojson",
    REGION:         "usec_md",
    Z_INDEX:        8,
    LABEL_Z_INDEX:  9,
    // Labels are at every 50 µs step (rounded numbers); lines are every 10 µs.
    LABEL_STEP_US:  50,
    STYLES: {
      "9960-X": { color: "#d9534f" },
      "9960-Y": { color: "#0275d8" },
    },
    LINE_WIDTH:    0.8,
    LINE_OPACITY:  0.65,
    // Padding (px) inward from the viewport edge so the label isn't clipped
    // by the map's letterboxing. Per-edge offset uses offsetX/offsetY.
    EDGE_PAD_PX:   8,
  };

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    enabled:       false,
    loaded:        false,
    loading:       null,
    lineLayer:     null,
    lineSource:    null,
    labelLayer:    null,
    labelSource:   null,
    attachedMap:   null,
    fetchErr:      null,
  };

  // ── Helpers ─────────────────────────────────────────────────────────
  // Generator bakes `angle_rad` into each LineString feature (tangent at the
  // centroid, radians CCW from east). For lines that go "downward"
  // (|angle_rad| > π/2), flipping by π keeps the text right-side-up while
  // still parallel to the line.
  function readableRotation(angleRad) {
    if (angleRad >  Math.PI / 2) return angleRad - Math.PI;
    if (angleRad < -Math.PI / 2) return angleRad + Math.PI;
    return angleRad;
  }

  // Find where a LineString crosses the 4 viewport edges. Returns up to 4
  // intersections (one per edge that the line actually crosses). Each
  // intersection is the geographic coordinate of the crossing point and the
  // edge name ('top' / 'bottom' / 'left' / 'right') — used for text padding.
  //
  // Both inputs are in EPSG:3857 (Web Mercator meters).
  function computeEdgeIntersects(lineCoords, extent) {
    const [minX, minY, maxX, maxY] = extent;
    const out = [];

    for (let i = 0; i < lineCoords.length - 1; i++) {
      const [x1, y1] = lineCoords[i];
      const [x2, y2] = lineCoords[i + 1];
      if (!Number.isFinite(x1) || !Number.isFinite(x2)) continue;

      // Left edge (x = minX)
      if ((x1 - minX) * (x2 - minX) < 0) {
        const t = (minX - x1) / (x2 - x1);
        const y = y1 + t * (y2 - y1);
        if (y >= minY && y <= maxY) {
          out.push({ coord: [minX, y], edge: "left" });
        }
      }
      // Right edge (x = maxX)
      if ((x1 - maxX) * (x2 - maxX) < 0) {
        const t = (maxX - x1) / (x2 - x1);
        const y = y1 + t * (y2 - y1);
        if (y >= minY && y <= maxY) {
          out.push({ coord: [maxX, y], edge: "right" });
        }
      }
      // Bottom edge (y = minY)
      if ((y1 - minY) * (y2 - minY) < 0) {
        const t = (minY - y1) / (y2 - y1);
        const x = x1 + t * (x2 - x1);
        if (x >= minX && x <= maxX) {
          out.push({ coord: [x, minY], edge: "bottom" });
        }
      }
      // Top edge (y = maxY)
      if ((y1 - maxY) * (y2 - maxY) < 0) {
        const t = (maxY - y1) / (y2 - y1);
        const x = x1 + t * (x2 - x1);
        if (x >= minX && x <= maxX) {
          out.push({ coord: [x, maxY], edge: "top" });
        }
      }
    }
    return out;
  }

  // Per-edge padding offset for the text. Edges are named relative to the
  // label's screen position — left/right edges push horizontally inward,
  // top/bottom push vertically inward.
  function edgePadding(edge) {
    const p = CONFIG.EDGE_PAD_PX;
    switch (edge) {
      case "left":   return [ p, 0];   // push right (away from edge)
      case "right":  return [-p, 0];   // push left
      case "top":    return [0,  p];   // push down
      case "bottom": return [0, -p];   // push up
      default:       return [0, 0];
    }
  }

  function buildEdgeIntersectionLabels(lineSource, map) {
    const extent = map.getView().calculateExtent(map.getSize());
    const labels = [];
    for (const lineFeature of lineSource.getFeatures()) {
      const td = lineFeature.get("td");
      if (Math.round(td) % CONFIG.LABEL_STEP_US !== 0) continue;
      const coords = lineFeature.getGeometry().getCoordinates();
      if (!coords || coords.length < 2) continue;
      const intersections = computeEdgeIntersects(coords, extent);
      for (const intersection of intersections) {
        labels.push(new ol.Feature({
          geometry: new ol.geom.Point(intersection.coord),
          pair: lineFeature.get("pair"),
          td: td,
          angle_rad: lineFeature.get("angle_rad") || 0,
          edge: intersection.edge,
          kind: "td-label",
        }));
      }
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

  function labelStyleFor(feature) {
    const props = feature.getProperties();
    const cfg = CONFIG.STYLES[props.pair] || { color: "#888" };
    const td = Number(props.td || 0);
    const rotation = readableRotation(Number(props.angle_rad || 0));
    const [offX, offY] = edgePadding(props.edge);
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
        padding: [2, 3, 2, 3],
        offsetX: offX,
        offsetY: offY,
        rotation: rotation,
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
  function buildLabelLayer() {
    const source = new ol.source.Vector({});
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

  // ── Refresh labels based on current viewport ─────────────────────────
  function refreshEdgeLabels() {
    if (!state.attachedMap || !state.lineSource || !state.labelSource) return;
    const labels = buildEdgeIntersectionLabels(
      state.lineSource, state.attachedMap,
    );
    state.labelSource.clear(true);
    state.labelSource.addFeatures(labels);
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
      refreshEdgeLabels();
      return true;
    }
    try {
      const source = await loadGeoJSON();
      if (!state.lineLayer) {
        state.lineLayer = buildLineLayer(source);
        map.addLayer(state.lineLayer);
      }
      if (!state.labelLayer) {
        state.labelLayer = buildLabelLayer();
        map.addLayer(state.labelLayer);
      }
      // First-time attach: bind the map, listen for viewport changes.
      if (!state.attachedMap) {
        state.attachedMap = map;
        map.on("moveend", refreshEdgeLabels);
      }
      refreshEdgeLabels();
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
    if (visible) enable();
    else disable();
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
    _state: state,
  };
})(window);