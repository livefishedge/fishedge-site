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
 *   2. Label layer (zIndex 1000): TD value labels at every 50 µs step,
 *      positioned on the line just inside the current viewport edges
 *      (top / bottom / left / right).
 *
 * Rotation rule (Mike, #32126, #32139, #32142, #32262):
 *   - Labels follow the analytic local tangent of the TD hyperbola at the
 *     label point. TD isolines curve continuously, so a single segment
 *     chord is not sufficient where the line bends.
 *   - The rendered LineString segment is used only to choose the tangent's
 *     sign, preserving the actual branch direction. The label coordinate
 *     remains on the rendered line just inside the viewport edge.
 *   - No fixed per-pair rotation offset is applied. Adding +15° X / +9° Y
 *     drifts labels away from the local curve direction.
 *   - Readability flip (separate concern from parallelism — this is about
 *     text reading direction east vs west, not about parallelism):
 *       9960-Y (horizontal lines, edge tangent ~0° or ~π): flip applied
 *       → text always reads east regardless of which way matplotlib
 *       ordered the LineString vertices. Without the flip (b6daa83),
 *       some Y labels read east, others read west.
 *       9960-X (vertical lines, edge tangent ~±90°): NO flip → NNE
 *       branch reads NNE, SSW branch reads SSW, each parallel to its
 *       own branch. Flipping vertical lines (be7396b) makes both
 *       branches read in the same compass direction — Mike called
 *       this "tilt reversed".
 *
 * Single global: window.LoranTdController
 *
 * Branch: feat/loran-td-grid-usec-md
 */
(function (global) {
  "use strict";

  // ── Configuration ───────────────────────────────────────────────────
  const CONFIG = {
      // This script is shared by /dashboard/ and nested Planner routes.
      // Keep the data URL absolute so fetch does not resolve to
      // /dashboard/trip-planner/loran/... on the Planner viewer.
      GEOJSON_URL:    "/dashboard/loran/td_grid_9960_usec_md.geojson",
      REGION:        "usec_md",
      Z_INDEX:       8,
      LABEL_Z_INDEX: 1000,
      LABEL_STEP_US: 50,
      STYLES: {
        "9960-X": { color: "#d9534f" },
        "9960-Y": { color: "#0275d8" },
      },
      LINE_WIDTH:    0.8,
      LINE_OPACITY:  0.65,
      EDGE_PAD_PX:   32,
    };

  // These must match generate_td_grid.py exactly. A TD isoline is a level
  // set of (distance(P, secondary) - distance(P, master)). Its tangent is
  // perpendicular to that function's gradient; this gives the real curve
  // direction at the label point, including the bend between GeoJSON
  // vertices.
  const STATIONS_3857 = {
    M: ol.proj.fromLonLat([-76.82591889, 42.71408778]),
    X: ol.proj.fromLonLat([-69.97737111, 41.25334611]),
    Y: ol.proj.fromLonLat([-77.91280556, 34.06283556]),
  };

  function trueTangentAt(px, py, secKey, segmentAngle) {
    const master = STATIONS_3857.M;
    const secondary = STATIONS_3857[secKey];
    const dm = Math.hypot(master[0] - px, master[1] - py);
    const ds = Math.hypot(secondary[0] - px, secondary[1] - py);
    if (dm < 1 || ds < 1) return segmentAngle;

    // Gradient of distance-to-secondary minus distance-to-master.
    const gx = (secondary[0] - px) / ds - (master[0] - px) / dm;
    const gy = (secondary[1] - py) / ds - (master[1] - py) / dm;
    const tangent = Math.atan2(gx, -gy);
    const opposite = tangent + Math.PI;

    // Preserve the LineString's direction so the readability rule below
    // remains deterministic for the two branches.
    const angularDistance = (a, b) => {
      let d = a - b;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      return Math.abs(d);
    };
    return angularDistance(tangent, segmentAngle) <=
      angularDistance(opposite, segmentAngle) ? tangent : opposite;
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
    moveendKey:  null,
    fetchErr:    null,
  };

  // ── Edge intersections ──────────────────────────────────────────────
  //
  // For each segment of the LineString, check the four viewport edges.
  // Emits one record per crossing with coord ON THE SEGMENT, pushed into
  // the viewport along the segment itself so the label stays on the line.
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

      const segDx = p2[0] - p1[0];
      const segDy = p2[1] - p1[1];
      const segLen = Math.hypot(segDx, segDy);
      if (segLen < 1) continue;
      const segAngle = Math.atan2(segDy, segDx);
      const ux = segDx / segLen;
      const uy = segDy / segLen;

      const inside = (p) => (
        p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY
      );

      const anchorOnSegment = (x, y) => {
        const forward = [x + ux * paddingGeo, y + uy * paddingGeo];
        if (inside(forward)) return forward;
        return [x - ux * paddingGeo, y - uy * paddingGeo];
      };

      // Left edge (x = minX, west). Push anchor east (into the viewport).
      if ((p1[0] - minX) * (p2[0] - minX) < 0) {
        const t = (minX - p1[0]) / (p2[0] - p1[0]);
        const y = p1[1] + t * (p2[1] - p1[1]);
        if (y >= minY && y <= maxY) {
          out.push({ coord: anchorOnSegment(minX, y), edge: "left", rotation: segAngle });
        }
      }
      // Right edge (x = maxX, east). Push anchor west.
      if ((p1[0] - maxX) * (p2[0] - maxX) < 0) {
        const t = (maxX - p1[0]) / (p2[0] - p1[0]);
        const y = p1[1] + t * (p2[1] - p1[1]);
        if (y >= minY && y <= maxY) {
          out.push({ coord: anchorOnSegment(maxX, y), edge: "right", rotation: segAngle });
        }
      }
      // Bottom edge (y = minY, south). Push anchor north.
      if ((p1[1] - minY) * (p2[1] - minY) < 0) {
        const t = (minY - p1[1]) / (p2[1] - p1[1]);
        const x = p1[0] + t * (p2[0] - p1[0]);
        if (x >= minX && x <= maxX) {
          out.push({ coord: anchorOnSegment(x, minY), edge: "bottom", rotation: segAngle });
        }
      }
      // Top edge (y = maxY, north). Push anchor south.
      if ((p1[1] - maxY) * (p2[1] - maxY) < 0) {
        const t = (maxY - p1[1]) / (p2[1] - p1[1]);
        const x = p1[0] + t * (p2[0] - p1[0]);
        if (x >= minX && x <= maxX) {
          out.push({ coord: anchorOnSegment(x, maxY), edge: "top", rotation: segAngle });
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

      const intersections = computeEdgeIntersects(coords, map);
      for (const intersection of intersections) {
        const secKey = pair === "9960-X" ? "X" : "Y";
        // trueTangentAt is expressed in EPSG:3857 (east-right,
        // north-up). Canvas/OpenLayers text rotation is screen-space
        // (east-right, down-positive), so negate the map angle here.
        let rotation = -trueTangentAt(
          intersection.coord[0], intersection.coord[1], secKey,
          intersection.rotation,
        );

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

        // DEBUG: log both the rendered chord and analytic curve tangent.
        console.log(
          `[loran-td:label] pair=${pair} TD=${Math.round(td)} edge=${intersection.edge} ` +
          `segAngle=${(intersection.rotation * 180 / Math.PI).toFixed(1)}° → ` +
          `labelAngle=${(rotation * 180 / Math.PI).toFixed(1)}°`
        );

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
    if (labels.length === 0) {
      console.warn(
        `[loran-td] No labels placed. ` +
        `lineSource has ${lineSource.getFeatures().length} features. ` +
        `Viewport: ${map.getView().calculateExtent(map.getSize()).join(", ")}`
      );
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
    // Labels are parallel to the local segment tangent at the edge
    // intersection (set in buildEdgeIntersectionLabels as feature.rotation).
    // TD isolines are hyperbolic curves — tangent varies continuously
    // along the curve, so NO fixed per-pair rotation offset is applied.
    // (Mike, 2026-08-18 #32262)
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
        rotateWithView: true,
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

  function getActiveMap(mapOverride) {
    return mapOverride || global._combinedMapRef || global._combinedMap || null;
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

  function attachLayersToMap(map) {
    if (!map) return false;
    if (state.attachedMap === map) return true;

    if (state.attachedMap) {
      if (state.moveendKey && ol.Observable?.unByKey) {
        ol.Observable.unByKey(state.moveendKey);
      }
      if (state.lineLayer) state.attachedMap.removeLayer(state.lineLayer);
      if (state.labelLayer) state.attachedMap.removeLayer(state.labelLayer);
    }

    map.addLayer(state.lineLayer);
    map.addLayer(state.labelLayer);
    state.attachedMap = map;
    state.moveendKey = map.on("moveend", refreshEdgeLabels);
    return true;
  }

  // ── Public API ──────────────────────────────────────────────────────
  async function enable(mapOverride) {
    if (!regionOk()) return false;
    const map = getActiveMap(mapOverride);
    if (!map) {
      console.warn("[loran-td] No active OpenLayers map present; deferring.");
      return false;
    }
    if (state.enabled && state.lineLayer && state.attachedMap === map) {
      state.lineLayer.setVisible(true);
      if (state.labelLayer) state.labelLayer.setVisible(true);
      refreshEdgeLabels();
      return true;
    }
    try {
      const source = await loadGeoJSON();
      if (!state.lineLayer) {
        state.lineLayer = buildLineLayer(source);
      }
      if (!state.labelLayer) {
        state.labelLayer = buildLabelLayer();
      }
      attachLayersToMap(map);
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

  function toggle(visible, mapOverride) {
    if (visible) return enable(mapOverride);
    else disable();
    return Promise.resolve(true);
  }

  function isEnabled(mapOverride) {
    const map = getActiveMap(mapOverride);
    return Boolean(
      state.enabled &&
      state.lineLayer &&
      state.lineLayer.getVisible() &&
      (!map || state.attachedMap === map)
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
