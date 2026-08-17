/* dashboard/bathy-lod.js
 *
 * Progressive bathymetric contours (Level-of-Detail controller).
 * Coarse GEBCO grid always available; medium (25 m) and fine (10 m)
 * contour data are requested only when zoom + coverage thresholds are
 * crossed. Loaded as a classic <script> BEFORE the inline bathy code in
 * dashboard/index.html.
 *
 * v1 (shipped today, 2026-08-16T22-41Z-v12-bathy-lod-dev): flat GeoJSON
 *     files for medium and fine. Pivoted away from tippecanoe PBF tiles
 *     because no-root apt blocks libsqlite3-dev. The controller detects
 *     flat vs tile URLs from the URL pattern and routes accordingly.
 *
 * v2 (future upgrade, see lod-manifest.json): replace the GeoJSON URLs
 *     with tippecanoe-built {z}/{x}/{y}.pbf tiles sourced from NOAA
 *     BlueTopo + NCEI multibeam. The PBF path is already wired in this
 *     controller — flip the URLs and you're done.
 *
 * Single global: window.BathyLodController.
 * Single config:   window.BATHY_LOD_CONFIG.
 *
 * Author: CTO. Branch: feat/bathy-lod-canyon-zoom (dev preview only).
 */
(function (global) {
  "use strict";

  // ─── Configuration ───────────────────────────────────────────────────
  const CONFIG = {
    // v1: flat GeoJSON. v2: swap the URLs for {z}/{x}/{y}.pbf (PBF
    //     VectorTile) — the controller detects the pattern and routes
    //     to the right loader automatically.
    TILE_ROOTS: {
      usec_md: {
        medium: "https://data.fishedge.live/dev/bathy/v1/usec_md/medium/{z}/{x}/{y}.pbf",
        fine:   "https://data.fishedge.live/dev/bathy/v1/usec_md/fine/{z}/{x}/{y}.pbf?v=20260817-ncei-dense-fine"
      },
      usec_south: {
        medium: "https://data.fishedge.live/dev/bathy/v1/usec_south/medium.json",
        fine:   "https://data.fishedge.live/dev/bathy/v1/usec_south/fine.json"
      }
    },

    // Coverage bboxes (WGS84 [w, s, e, n]) — viewport center must be
    // inside the box for the LOD to be eligible. Outside coverage,
    // cascade down to the next-best LOD. Set to null to disable.
    COVERAGE: {
      usec_md: {
        medium: [-76.5, 35.5, -71.5, 40.5],         // whole usec_md
        fine:   [-74.85, 38.05, -73.65, 38.55]      // Baltimore Canyon pilot
      },
      usec_south: {
        medium: [-82.0, 24.0, -75.0, 35.0],         // whole usec_south
        fine:   null                                // no fine pilot yet
      }
    },

    HYSTERESIS: 0.25,
    FIRST_LOAD_TIMEOUT_MS: 8000,
    FAILURE_COOLDOWN_MS: 30000,
    CROSS_FADE_MS: 200,

    // Zoom thresholds for switching between LODs.
    THRESHOLDS: { medium: 8, fine: 11 },

    // PBF tile pyramid zoom bounds (Tippecanoe -Z/-z flags). Only used
    // when the URL contains {z}/{x}/{y} (PBF path). Ignored for flat
    // GeoJSON.
    MIN_ZOOM: { medium: 8, fine: 11 },
    MAX_ZOOM: { medium: 10, fine: 14 },

    DEFAULT_MOBILE_ENABLED: false,

    STYLE: function (feature) {
      const depth = Number(feature.get("depth_m") ?? feature.get("depth")) || 0;
      const major = depth >= 1000;
      return new ol.style.Style({
        stroke: new ol.style.Stroke({
          color: major ? "rgba(178, 92, 255, 1.00)" : "rgba(178, 92, 255, 0.85)",
          width: major ? 1.2 : 0.9
        })
      });
    },

    // Make the LOD transition visually unambiguous in the dev pilot:
    // coarse stays subdued, medium becomes amber, and fine becomes cyan
    // with a wider stroke. Production styling is unchanged because this
    // controller is only loaded by the feature preview branch.
    STYLE_FOR_LOD: function (lod) {
      const color = lod === "fine" ? "rgba(0, 229, 255, 0.98)" : "rgba(255, 170, 0, 0.96)";
      const width = lod === "fine" ? 2.4 : 1.7;
      const cache = Object.create(null);
      return function (feature) {
        const depth = Number(feature.get("depth_m") ?? feature.get("depth")) || 0;
        const key = String(depth);
        if (!cache[key]) {
          cache[key] = new ol.style.Style({
            stroke: new ol.style.Stroke({
              color: color,
              width: depth >= 1000 ? width + 0.5 : width
            })
          });
        }
        return cache[key];
      };
    }
  };

  // ─── Helpers ─────────────────────────────────────────────────────────

  function viewportCenterLonLat(map) {
    const view = map.getView();
    const center = view.getCenter();
    if (!center) return null;
    const projCode = view.getProjection().getCode();
    if (projCode === "EPSG:4326") return center;
    return ol.proj.toLonLat(center);
  }

  function viewportInBbox(map, bbox) {
    if (!bbox || bbox.length !== 4) return false;
    const ll = viewportCenterLonLat(map);
    if (!ll) return false;
    const [w, s, e, n] = bbox;
    return ll[0] >= w && ll[0] <= e && ll[1] >= s && ll[1] <= n;
  }

  function pickLod(zoom, regionId, activeLod, map) {
    const cov = CONFIG.COVERAGE[regionId] || {};
    const fineCov = cov.fine;
    const medCov  = cov.medium;
    const fineT = CONFIG.THRESHOLDS.fine;
    const medT  = CONFIG.THRESHOLDS.medium;
    const h = CONFIG.HYSTERESIS;

    let candidate = zoom >= fineT ? "fine"
                  : zoom >= medT  ? "medium"
                  : "coarse";

    // Hysteresis
    if (activeLod === "fine" && zoom < fineT && zoom >= medT - h) {
      candidate = "fine";
    } else if (activeLod === "medium" && zoom < medT && zoom >= medT - h) {
      candidate = "medium";
    } else if (activeLod === "coarse" && zoom >= medT - h && zoom < medT) {
      candidate = "coarse";
    }

    // Coverage fallback
    if (candidate === "fine" && !viewportInBbox(map, fineCov)) {
      candidate = viewportInBbox(map, medCov) ? "medium" : "coarse";
    }
    if (candidate === "medium" && !viewportInBbox(map, medCov)) {
      candidate = "coarse";
    }

    return candidate;
  }

  // ─── Controller ──────────────────────────────────────────────────────

  function BathyLodController(opts) {
    if (!opts || !opts.map || !opts.coarseLayer) {
      throw new Error("BathyLodController requires { map, coarseLayer }");
    }
    this.map = opts.map;
    this.coarseLayer = opts.coarseLayer;
    this.regionId = opts.regionId || (global.REGION_ID || "usec_md");
    this.scope = opts.scope || "desktop";
    this.mobileEnabled = opts.mobileEnabled === true
      ? true
      : (opts.mobileEnabled === false ? false : CONFIG.DEFAULT_MOBILE_ENABLED);

    this.activeLod = "coarse";
    this.swapToken = 0;
    this.pendingLod = null;
    this.tileLayers = {};
    this.failedLods = {};
    this._coarseBaseOpacity = 1;
    this._coarseBaseVisible = true;
    if (this.coarseLayer) {
      this._coarseBaseOpacity = this.coarseLayer.getOpacity();
      this._coarseBaseVisible = this.coarseLayer.getVisible();
    }
    this.disposed = false;
    this._log("init", `scope=${this.scope}; region=${this.regionId}; mobile=${this.mobileEnabled}`);
  }

  BathyLodController.prototype._log = function (event, msg) {
    console.info(`[bathy] lod ${event} ${msg}`);
  };

  BathyLodController.prototype.syncForView = function () {
    if (this.disposed) return this.activeLod;
    if (this.scope === "mobile" && !this.mobileEnabled) return this.activeLod;
    const view = this.map.getView();
    const zoom = view.getZoom();
    if (!Number.isFinite(zoom)) return this.activeLod;
    const candidate = pickLod(zoom, this.regionId, this.activeLod, this.map);
    if (candidate === this.activeLod) return this.activeLod;
    // Serialize transitions: rapid wheel events must not create overlapping
    // VectorTile layers and concurrent cross-fades.
    if (this.pendingLod) return this.activeLod;
    this._swapTo(candidate, zoom, "zoom-change");
    return this.activeLod;
  };

  BathyLodController.prototype._swapTo = function (target, zoom, reason) {
    const from = this.activeLod;
    this.pendingLod = target;
    const token = ++this.swapToken;
    const startedAt = performance.now();
    const self = this;
    const failKey = `${target}:${this.regionId}`;
    const failedAt = this.failedLods[failKey];

    if (failedAt && Date.now() - failedAt < CONFIG.FAILURE_COOLDOWN_MS) {
      const ageS = Math.round((Date.now() - failedAt) / 1000);
      this._log("skip", `${from}->${target} failed ${ageS}s ago; cooldown`);
      this.pendingLod = null;
      return Promise.resolve(this.activeLod);
    }

    if (target === "coarse") {
      this._showOnly("coarse");
      this.activeLod = "coarse";
      this.pendingLod = null;
      const elapsed = performance.now() - startedAt;
      this._log("swap", `${from}->coarse; zoom ${zoom.toFixed(2)}; ${reason}; ${elapsed.toFixed(0)}ms`);
      return Promise.resolve("coarse");
    }

    return this._ensureLayer(target, token).then(function (layer) {
      if (self.disposed || token !== self.swapToken) {
        self.pendingLod = null;
        self._log("stale", `${target} aborted; map changed mid-load`);
        return self.activeLod;
      }
      if (!layer) {
        self.pendingLod = null;
        self.failedLods[failKey] = Date.now();
        self._showOnly("coarse");
        self.activeLod = "coarse";
        self._log("unavailable", `${target}; retaining coarse; timeout or error`);
        return self.activeLod;
      }
      return self._crossFade(target, layer).then(function () {
        if (self.disposed || token !== self.swapToken) {
          self.pendingLod = null;
          self._log("stale", `${target} cross-fade aborted`);
          return self.activeLod;
        }
        self.activeLod = target;
        self.pendingLod = null;
        const elapsed = performance.now() - startedAt;
        self._log("swap", `${from}->${target}; zoom ${zoom.toFixed(2)}; ${reason}; ${elapsed.toFixed(0)}ms`);
        return target;
      });
    });
  };

  // Dual-path: detects {z}/{x}/{y}.pbf (PBF VectorTile) vs flat .json
  // (GeoJSON Vector). Returns the layer on success, null on
  // timeout/error.
  BathyLodController.prototype._ensureLayer = function (lod, token) {
    const self = this;
    if (this.tileLayers[lod]) return Promise.resolve(this.tileLayers[lod]);
    const rootUrl = (CONFIG.TILE_ROOTS[this.regionId] || {})[lod];
    if (!rootUrl) return Promise.resolve(null);

    const isTileUrl = rootUrl.indexOf("{z}") !== -1;

    if (isTileUrl) {
      // ─── v2 path: PBF VectorTile ────────────────────────────────────
      const source = new ol.source.VectorTile({
        url: rootUrl,
        format: new ol.format.MVT(),
        projection: "EPSG:3857",
        minZoom: CONFIG.MIN_ZOOM[lod],
        maxZoom: CONFIG.MAX_ZOOM[lod],
        wrapX: false
      });
      const layer = new ol.layer.VectorTile({
        source: source,
        style: CONFIG.STYLE_FOR_LOD(lod),
        opacity: 0,
        zIndex: (this.coarseLayer.getZIndex ? this.coarseLayer.getZIndex() : 15) + 0.1
      });

      return new Promise(function (resolve) {
        let resolved = false;
        const finish = function (ok) {
          if (resolved) return;
          resolved = true;
          source.un("tileloadend", onOk);
          source.un("tileloaderror", onErr);
          clearTimeout(timer);
          resolve(ok ? layer : null);
        };
        const onOk = function () { finish(true); };
        const onErr = function () { finish(false); };
        source.on("tileloadend", onOk);
        source.on("tileloaderror", onErr);
        const timer = setTimeout(function () { finish(false); }, CONFIG.FIRST_LOAD_TIMEOUT_MS);

        // Register listeners before attaching the layer. Adding a VectorTile
        // layer can synchronously schedule/load its first tile; registering
        // afterward can miss the only tileloadend event and falsely time out.
        self.map.addLayer(layer);
        self.tileLayers[lod] = layer;
      });
    }

    // ─── v1 path: flat GeoJSON ────────────────────────────────────────
    const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, CONFIG.FIRST_LOAD_TIMEOUT_MS);

    return fetch(rootUrl, ctrl ? { signal: ctrl.signal } : {})
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (gj) {
        clearTimeout(timer);
        if (self.disposed || token !== self.swapToken) return null;
        const format = new ol.format.GeoJSON();
        const features = format.readFeatures(gj, {
          dataProjection: "EPSG:4326",
          featureProjection: "EPSG:3857"
        });
        const source = new ol.source.Vector({ features: features, wrapX: false });
        const layer = new ol.layer.Vector({
          source: source,
          style: CONFIG.STYLE_FOR_LOD(lod),
          opacity: 0,
          zIndex: (self.coarseLayer.getZIndex ? self.coarseLayer.getZIndex() : 15) + 0.1
        });
        self.map.addLayer(layer);
        self.tileLayers[lod] = layer;
        return layer;
      })
      .catch(function () {
        clearTimeout(timer);
        return null;
      });
  };

  BathyLodController.prototype._crossFade = function (target, toLayer) {
    const fromLayer = this.coarseLayer;
    const dur = CONFIG.CROSS_FADE_MS;
    return new Promise(function (resolve) {
      const start = performance.now();
      toLayer.setOpacity(0);
      toLayer.setVisible(true);
      const tick = function () {
        const t = Math.min(1, (performance.now() - start) / dur);
        if (fromLayer) fromLayer.setOpacity(1 - t);
        toLayer.setOpacity(t);
        if (t < 1) requestAnimationFrame(tick);
        else {
          if (fromLayer) {
            // Keep the dynamic field-of-view contours faintly visible under
            // the NOAA tile layer. This makes the zoom-density change
            // obvious even where a particular vector tile is sparse.
            fromLayer.setOpacity(target === "coarse" ? 1 : 0.24);
            fromLayer.setVisible(true);
          }
          resolve();
        }
      };
      tick();
    });
  };

  BathyLodController.prototype._showOnly = function (which) {
    if (this.coarseLayer) {
      this.coarseLayer.setOpacity(this._coarseBaseOpacity || 1);
      this.coarseLayer.setVisible(which === "coarse");
    }
    ["medium", "fine"].forEach(function (lod) {
      const l = this.tileLayers[lod];
      if (!l) return;
      const want = lod === which;
      l.setVisible(want);
      l.setOpacity(want ? 1 : 0);
    }, this);
  };

  BathyLodController.prototype.dispose = function () {
    this.disposed = true;
    this.swapToken++;
    Object.keys(this.tileLayers).forEach(function (lod) {
      const l = this.tileLayers[lod];
      if (l && this.map) this.map.removeLayer(l);
    }, this);
    this.tileLayers = {};
    if (this.coarseLayer) {
      this.coarseLayer.setOpacity(this._coarseBaseOpacity || 1);
      this.coarseLayer.setVisible(this._coarseBaseVisible !== false);
    }
    this.activeLod = "coarse";
    this._log("dispose", `scope=${this.scope}`);
  };

  // ─── Export ──────────────────────────────────────────────────────────
  global.BathyLodController = BathyLodController;
  global.BATHY_LOD_CONFIG = CONFIG;
})(window);
