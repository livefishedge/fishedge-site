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
 * Rotation rule (Mike, #32126, #32139, #32142):
 *   - Rotation source: per-segment edge angle (the local tangent at
 *     the segment that crosses the viewport edge). NOT the centroid
 *     angle baked into the GeoJSON — for curved hyperbolas the centroid
 *     tangent can be ±37° off from the local tangent at the edge, which
 *     Mike saw as labels that "are still wrong" in 7e4fe97.
 *   - 9960-Y (horizontal lines, edge tangent ~0° or ~π): readability
 *     flip applied → text always reads east consistently regardless of
 *     which way matplotlib ordered the LineString vertices. Without
 *     the flip (b6daa83), some Y labels read east, others read west.
 *   - 9960-X (vertical lines, edge tangent ~±90°): NO flip → text
 *     reads along the line's actual direction. NNE branch reads NNE,
 *     SSW branch reads SSW, each parallel to its own branch — which
 *     is what "all labels have to be in parallel with and on the line
 *     of the line they're labeling" requires.
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

  // ── Station positions in EPSG:3857 (for true-tangent computation) ──
  // Computed from the corrected lat/lon in the generator (commit 9ab12e1).
  //   M (Seneca, NY):          lat 42.714258, lon -76.825828
  //   X (Nantucket, MA):      lat 41.253011, lon -69.983944
  //   Y (Carolina Beach, NC):  lat 34.062836, lon -77.912806  ← NOT Cape Fear
  const STATIONS_3857 = {
    M: ol.proj.fromLonLat([-76.825828, 42.714258]),  // [lon, lat]
    X: ol.proj.fromLonLat([-69.983944, 41.253011]),
    Y: ol.proj.fromLonLat([-77.912806, 34.062836]),
  };

  // ── True tangent at a point P on a TD line ──────────────────────────
  // The gradient of the TD function at P is:
  //   ∇TD_S = (P→S unit vector) − (P→M unit vector)
  // where S is the secondary (X or Y) and M is the master. The tangent
  // to the line is perpendicular to this gradient. We pick the perpendicular
  // direction closer to the segment direction (segAngleHint) so the sign
  // matches the line's actual travel direction.
  function trueTangentAt(px, py, secKey, segAngleHint) {
    const m = STATIONS_3857.M;
    const s = STATIONS_3857[secKey];
    // Unit vector from P to M
    const dxM = m[0] - px, dyM = m[1] - py;
    const lenM = Math.hypot(dxM, dyM);
    if (lenM < 1) return segAngleHint;
    const uxM = dxM / lenM, uyM = dyM / lenM;
    // Unit vector from P to S
    const dxS = s[0] - px, dyS = s[1] - py;
    const lenS = Math.hypot(dxS, dyS);
    if (lenS < 1) return segAngleHint;
    const uxS = dxS / lenS, uyS = dyS / lenS;
    // Gradient of TD
    const gx = uxS - uxM;
    const gy = uyS - uyM;
    // Two perpendicular directions
    const t1 = Math.atan2(gx, -gy);
    const t2 = t1 + Math.PI;
    // Normalize to [-π, π]
    const norm = (a) => {
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a < -Math.PI) a += 2 * Math.PI;
      return a;
    };
    const t1n = norm(t1), t2n = norm(t2);
    const sN = norm(segAngleHint);
    // Pick the one closer to segAngleHint (with wraparound)
    const d1 = Math.min(Math.abs(t1n - sN), Math.abs(t1n - sN + 2*Math.PI), Math.abs(t1n - sN - 2*Math.PI));
    const d2 = Math.min(Math.abs(t2n - sN), Math.abs(t2n - sN + 2*Math.PI), Math.abs(t2n - sN - 2*Math.PI));
    return d1 < d2 ? t1n : t2n;
  }

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
  // in geo units so the text never clips), the edge name, AND the
  // segment's local tangent angle (radians CCW from east in EPSG:3857).
  // This per-segment angle is what makes the label exactly parallel to
  // the line AT THAT POINT — a centroid angle would be off by up to ±37°
  // for X lines (which are nearly vertical) and ±17° for Y lines.
  function computeEdgeIntersects(lineCoords, map, secKey) {
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

      // Segment direction (secant from p1 to p2) — used as a hint for
      // the true-tangent sign. The true tangent at the intersection
      // point is perpendicular to the TD gradient and is the exact
      // orientation the label needs (Mike #32161: "close to the right
      // orientation but not quite" — the per-segment secant is off by
      // up to ±37° from the true tangent for X lines, ±17° for Y).
      const segDx = p2[0] - p1[0];
      const segDy = p2[1] - p1[1];
      const segAngle = Math.atan2(segDy, segDx);

      // Left edge (x = minX, west). Push anchor east (into the viewport).
      if ((p1[0] - minX) * (p2[0] - minX) < 0) {
        const t = (minX - p1[0]) / (p2[0] - p1[0]);
        const y = p1[1] + t * (p2[1] - p1[1]);
        if (y >= minY && y <= maxY) {
          const cx = minX + paddingGeo;
          const rot = trueTangentAt(cx, y, secKey, segAngle);
          out.push({ coord: [cx, y], edge: "left", rotation: rot });
        }
      }
      // Right edge (x = maxX, east). Push anchor west.
      if ((p1[0] - maxX) * (p2[0] - maxX) < 0) {
        const t = (maxX - p1[0]) / (p2[0] - p1[0]);
        const y = p1[1] + t * (p2[1] - p1[1]);
        if (y >= minY && y <= maxY) {
          const cx = maxX - paddingGeo;
          const rot = trueTangentAt(cx, y, secKey, segAngle);
          out.push({ coord: [cx, y], edge: "right", rotation: rot });
        }
      }
      // Bottom edge (y = minY, south). Push anchor north.
      if ((p1[1] - minY) * (p2[1] - minY) < 0) {
        const t = (minY - p1[1]) / (p2[1] - p1[1]);
        const x = p1[0] + t * (p2[0] - p1[0]);
        if (x >= minX && x <= maxX) {
          const cy = minY + paddingGeo;
          const rot = trueTangentAt(x, cy, secKey, segAngle);
          out.push({ coord: [x, cy], edge: "bottom", rotation: rot });
        }
      }
      // Top edge (y = maxY, north). Push anchor south.
      if ((p1[1] - maxY) * (p2[1] - maxY) < 0) {
        const t = (maxY - p1[1]) / (p2[1] - p1[1]);
        const x = p1[0] + t * (p2[0] - p1[0]);
        if (x >= minX && x <= maxX) {
          const cy = maxY - paddingGeo;
          const rot = trueTangentAt(x, cy, secKey, segAngle);
          out.push({ coord: [x, cy], edge: "top", rotation: rot });
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
      const secKey = pair === "9960-X" ? "X" : "Y";

      const intersections = computeEdgeIntersects(coords, map, secKey);
      for (const intersection of intersections) {
        let rotation = intersection.rotation;

        // Conditional readability flip — the key part of Mike's feedback.
        //   - 9960-Y (horizontal lines, edge tangent ~0° or ~π): apply
        //     the flip so text reads east consistently regardless of which
        //     way matplotlib ordered the LineString vertices. Without
        //     the flip, some Y labels read east, others read west
        //     (inconsistent). Mike saw this in b6daa83.
        //   - 9960-X (vertical lines, edge tangent ~±90°): NO flip. The
        //     text must read along the line direction (parallel to the
        //     line) as Mike asked for in #32102 / #32139 / #32142.
        //     Without the flip, the NNE branch reads NNE and the SSW
        //     branch reads SSW — each parallel to its own branch.
        //     With the flip (be7396b), both branches read NNE — the SSW
        //     branch's text was reversed relative to its line, which
        //     Mike called 'tilt reversed' in #32114.
        if (pair === "9960-Y") {
          if (rotation > Math.PI / 2)        rotation -= Math.PI;
          else if (rotation <= -Math.PI / 2) rotation += Math.PI;
        }

        labels.push(new ol.Feature({
          geometry: new ol.geom.Point(intersection.coord),
          pair:        pair,
          td:          td,
          rotation:    rotation,
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
        // Semi-transparent dark background so the label is clearly
        // readable on top of any line behind it. Mike (#32161) saw
        // "red labels placed on the wrong line" — the issue was visual
        // proximity with a nearby blue Y line, not a data problem.
        // The background removes the ambiguity.
        backgroundFill: new ol.style.Fill({
          color: "rgba(15, 20, 30, 0.65)",
        }),
        backgroundStroke: new ol.style.Stroke({
          color: "rgba(0, 0, 0, 0.4)",
          width: 1,
        }),
        overflow:     true,
        textAlign:    "center",
        textBaseline: "middle",
        padding: [2, 4, 2, 4],
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
      declutter: false,
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