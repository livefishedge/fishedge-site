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
 *      (top / bottom / left / right). Each label uses ONE rotation per
 *      line (the centroid angle baked into the GeoJSON by the generator)
 *      so labels on the same line are visually consistent.
 *
 * Rotation rule (Mike, #32126):
 *   - 9960-Y (horizontal lines): readability flip applied → text always
 *     reads east consistently regardless of which way matplotlib ordered
 *     the vertices.
 *   - 9960-X (vertical lines): NO flip → text reads along the line's
 *     actual direction. The NNE branch and SSW branch read in opposite
 *     directions (NNE vs SSW), each parallel to its own branch — which is
 *     what "rotate each grid label to be exactly in parallel with the line"
 *     requires.
 *
 * Single global: window.LoranTdController
 *
 * Branch: feat/loran-td-grid-usec-md
 */
(function (global) {
  "use strict";

  // ── Configuration ───────────────────────────────────────────────────
  const CONFIG = {
      GEOJSON_URL:    "loran/td_grid_9960_usec_md.geojson",
      REGION:        "usec_md",
      Z_INDEX:       8,
      LABEL_Z_INDEX: 9,
      LABEL_STEP_US: 50,
      STYLES: {
        "9960-X": { color: "#d9534f" },
        "9960-Y": { color: "#0275d8" },
      },
      LINE_WIDTH:    0.8,
      LINE_OPACITY:  0.65,
      EDGE_PAD_PX:   32,
    };

  // ── State ───────────────────────────────────────────────────────────
  const state = {
    enabled:     false,
    loaded:      false,
    loading:     null,
    lineLayer:   null,
    lineSource:  null,
    labelLayer:  null,
    labelSource: null,
    attachedMap: null,
    fetchErr:    null,
  };

  // ── Edge intersections ──────────────────────────────────────────────
  //
  // For each segment of the LineString, check the four viewport edges.
  // Emits one record per crossing with coord (pushed EDGE_PAD_PX inward
  // in geo units so the text never clips) and the edge name. Rotation is
  // NOT computed here — it comes from the LineString-level centroid angle
  // baked into the GeoJSON (see buildEdgeIntersectionLabels).
  function computeEdgeIntersects(lineCoords, map) {
    const view = map.getView();
    const extent = view.calculateExtent(map.getSize());
    const [minX, minY, maxX, maxY] = extent;
    const out = [];

    const resolution = view.getResolution();
    const paddingGeo = CONFIG.EDGE_PAD_PX * resolution;

    for (let i = 0; i < lineCoords.length - 1; i++) {
      const p1 = lineCoords[i];
      const p2 = lineCoords[i + 1];
      if (!Number.isFinite(p1[0]) || !Number.isFinite(p2[0])) continue;

      // Left edge (x = minX, west). Push anchor east (into the viewport).
      if ((p1[0] - minX) * (p2[0] - minX) < 0) {
        const t = (minX - p1[0]) / (p2[0] - p1[0]);
        const y = p1[1] + t * (p2[1] - p1[1]);
        if (y >= minY && y <= maxY) {
          out.push({ coord: [minX + paddingGeo, y], edge: "left" });
        }
      }
      // Right edge (x = maxX, east). Push anchor west.
      if ((p1[0] - maxX) * (p2[0] - maxX) < 0) {
        const t = (maxX - p1[0]) / (p2[0] - p1[0]);
        const y = p1[1] + t * (p2[1] - p1[1]);
        if (y >= minY && y <= maxY) {
          out.push({ coord: [maxX - paddingGeo, y], edge: "right" });
        }
      }
      // Bottom edge (y = minY, south). Push anchor north.
      if ((p1[1] - minY) * (p2[1] - minY) < 0) {
        const t = (minY - p1[1]) / (p2[1] - p1[1]);
        const x = p1[0] + t * (p2[0] - p1[0]);
        if (x >= minX && x <= maxX) {
          out.push({ coord: [x, minY + paddingGeo], edge: "bottom" });
        }
      }
      // Top edge (y = maxY, north). Push anchor south.
      if ((p1[1] - maxY) * (p2[1] - maxY) < 0) {
        const t = (maxY - p1[1]) / (p2[1] - p1[1]);
        const x = p1[0] + t * (p2[0] - p1[0]);
        if (x >= minX && x <= maxX) {
          out.push({ coord: [x, maxY - paddingGeo], edge: "top" });
        }
      }
    }
    return out;
  }

  function buildEdgeIntersectionLabels(lineSource, map) {
    const labels = [];
    for (const lineFeature of lineSource.getFeatures()) {
      const td = lineFeature.get("td");
      if (Math.round(td) % CONFIG.LABEL_STEP_US !== 0) continue;
      const coords = lineFeature.getGeometry().getCoordinates();
      if (!coords || coords.length < 2) continue;
      const pair = lineFeature.get("pair");

      // Per-LineString rotation: read the centroid angle baked into the
      // GeoJSON by the generator. ONE rotation per line so all labels
      // on the same line look identical (no per-edge drift).
      let lineAngle = Number(lineFeature.get("angle_rad") || 0);

      // Conditional readability flip:
      //   - 9960-Y (horizontal lines, centroid near 0° or π): apply the
      //     flip so the text always reads east consistently, regardless of
      //     which way matplotlib ordered the LineString vertices.
      //   - 9960-X (vertical lines, centroid near ±80°): NO flip. The
      //     NNE-ordered branch keeps its +78° rotation (text reads NNE);
      //     the SSW-ordered branch keeps its −102° rotation (text reads
      //     SSW). Both read along their own branch — parallel to the line
      //     as Mike asked for in #32102.
      if (pair === "9960-Y") {
        if (lineAngle > Math.PI / 2)        lineAngle -= Math.PI;
        else if (lineAngle <= -Math.PI / 2) lineAngle += Math.PI;
      }

      const intersections = computeEdgeIntersects(coords, map);
      for (const intersection of intersections) {
        labels.push(new ol.Feature({
          geometry: new ol.geom.Point(intersection.coord),
          pair:        pair,
          td:          td,
          rotation:    lineAngle,
          edge:        intersection.edge,
          kind:        "td-label",
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
        color:   cfg.color,
        width:   CONFIG.LINE_WIDTH,
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
    const rotation = Number(props.rotation || 0);
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
        overflow:     true,
        textAlign:    "center",
        textBaseline: "middle",
        padding: [2, 3, 2, 3],
        rotation:     rotation,
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