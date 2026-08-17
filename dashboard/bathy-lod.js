/* dashboard/bathy-lod.js
 *
 * Progressive bathymetric contours (Level-of-Detail controller).
 * Coarse GEBCO grid always available; medium/fine PBF tiles requested
 * only when zoom + coverage thresholds are crossed. Loaded as a classic
 * <script> BEFORE the inline bathy code in dashboard/index.html.
 *
 * Single global: window.BathyLodController.
 * Single config:   window.BATHY_LOD_CONFIG (tweak tile roots / coverage
 *                   boxes here; everything else is internal).
 *
 * Author: CTO. Branch: feat/bathy-lod-canyon-zoom (dev preview only).
 * Dev build marker: 2026-08-16T22-41Z-v12-bathy-lod-dev
 */
(function (global) {
  "use strict";

  // ─── Configuration ───────────────────────────────────────────────────
  const CONFIG = {
    // CDN roots for medium/fine PBF vector tiles. Keys are REGION_IDs.
    // Each URL follows the standard {z}/{x}/{y}.pbf XYZ scheme used by
    // OpenLayers' ol.source.VectorTile.
    TILE_ROOTS: {
      usec_md: {
        medium: "https://data.fishedge.live/dev/bathy/v1/usec_md/medium/{z}/{x}/{y}.pbf",
        fine:   "https://data.fishedge.live/dev/bathy/v1/usec_md/fine/{z}/{x}/{y}.pbf"
      },
      usec_south: {
        medium: "https://data.fishedge.live/dev/bathy/v1/usec_south/medium/{z}/{x}/{y}.pbf",
        fine:   "https://data.fishedge.live/dev/bathy/v1/usec_south/fine/{z}/{x}/{y}.pbf"
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

    // Hysteresis band (zoom units) around the medium/fine thresholds so a
    // tiny fractional-zoom wobble at z=8.00 doesn't ping-pong.
    HYSTERESIS: 0.25,

    // First-load timeout for medium/fine tiles. On expiry, fall back to
    // coarse and remember the failure for FAILURE_COOLDOWN_MS.
    FIRST_LOAD_TIMEOUT_MS: 8000,

    // After a failed tile load, skip retries for this many ms. Prevents
    // a 404-on-every-keystroke retry storm.
    FAILURE_COOLDOWN_MS: 30000,

    // Cross-fade duration between coarse and the new LOD's tile layer.
    CROSS_FADE_MS: 200,

    // Zoom thresholds for switching between LODs.
    THRESHOLDS: { medium: 8, fine: 11 },

    // PBF tile pyramid zoom bounds (Tippecanoe -Z/-z flags). Tiles
    // outside this range won't be requested by OL.
    MIN_ZOOM: { medium: 8, fine: 11 },
    MAX_ZOOM: { medium: 10, fine: 14 },

    // Mobile is opt-in for high-res tiles by default (separate perf
    // envelope). Pass { mobileEnabled: true } in opts to override.
    DEFAULT_MOBILE_ENABLED: false,

    // Feature style for tile-derived contours. Matches the existing
    // desktop/mobile/combined palette but tuned for higher density.
    STYLE: function (feature) {
      const depth = Number(feature.get("depth")) || 0;
      const major = depth >= 1000;
      return new ol.style.Style({
        stroke: new ol.style.Stroke({
          color: major ? "rgba(178, 92, 255, 1.00)" : "rgba(178, 92, 255, 0.85)",
          width: major ? 1.2 : 0.9
        })
      });
    }
  };

  // ─── Helpers ─────────────────────────────────────────────────────────

  // Viewport center in WGS84 lon/lat, regardless of view projection.
  function viewportCenterLonLat(map) {
    const view = map.getView();
    const center = view.getCenter();
    if (!center) return null;
    const projCode = view.getProjection().getCode();
    if (projCode === "EPSG:4326") return center;
    return ol.proj.toLonLat(center);
  }

  function viewportInBbox(bbox) {
    if (!bbox || bbox.length !== 4) return false;
    const ll = viewportCenterLonLat(this.map);
    if (!ll) return false;
    const [w, s, e, n] = bbox;
    return ll[0] >= w && ll[0] <= e && ll[1] >= s && ll[1] <= n;
  }

  // Decide which LOD to show given current zoom, region, and the LOD
  // we're already on (for hysteresis). Cascade fine→medium→coarse on
  // coverage miss.
  function pickLod(zoom, regionId, activeLod) {
    const cov = CONFIG.COVERAGE[regionId] || {};
    const fineCov = cov.fine;
    const medCov  = cov.medium;
    const fineT = CONFIG.THRESHOLDS.fine;
    const medT  = CONFIG.THRESHOLDS.medium;
    const h = CONFIG.HYSTERESIS;

    // Natural LOD for the current zoom.
    let candidate = zoom >= fineT ? "fine"
                  : zoom >= medT  ? "medium"
                  : "coarse";

    // Hysteresis: stick with the previous LOD if we're wobbling inside
    // the band. Only smooth transitions medium↔fine and coarse↔medium.
    if (activeLod === "fine" && zoom < fineT && zoom >= medT - h) {
      candidate = "fine";
    } else if (activeLod === "medium" && zoom < medT && zoom >= medT - h) {
      candidate = "medium";
    } else if (activeLod === "coarse" && zoom >= medT - h && zoom < medT) {
      candidate = "coarse";
    }

    // Coverage fallback. Fine unavailable → medium; medium unavailable → coarse.
    if (candidate === "fine" && !viewportInBbox.call({ map: this.map }, fineCov)) {
      candidate = viewportInBbox.call({ map: this.map }, medCov) ? "medium" : "coarse";
    }
    if (candidate === "medium" && !viewportInBbox.call({ map: this.map }, medCov)) {
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
    this.swapToken = 0;             // monotonic — detect stale swaps
    this.tileLayers = {};           // { medium: VectorTile, fine: VectorTile }
    this.failedLods = {};           // { "fine:usec_md": Date.now() }
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

  // Cheap idempotent gate. Returns the current active LOD if unchanged.
  // Otherwise kicks off an async swap and returns the *current* LOD
  // (the swap will complete on its own; the 150ms moveend caller doesn't
  // need to await it before doing its coarse rebuild).
  BathyLodController.prototype.syncForView = function () {
    if (this.disposed) return this.activeLod;
    if (this.scope === "mobile" && !this.mobileEnabled) return this.activeLod;

    const view = this.map.getView();
    const zoom = view.getZoom();
    if (!Number.isFinite(zoom)) return this.activeLod;

    const candidate = pickLod.call(this, zoom, this.regionId, this.activeLod);
    if (candidate === this.activeLod) return this.activeLod;

    // Fire-and-forget; the swap runs in the background and the next
    // syncForView() will see the new activeLod once it lands.
    this._swapTo(candidate, zoom, "zoom-change");
    return this.activeLod;
  };

  BathyLodController.prototype._swapTo = function (target, zoom, reason) {
    const from = this.activeLod;
    const token = ++this.swapToken;
    const startedAt = performance.now();
    const self = this;
    const failKey = `${target}:${this.regionId}`;
    const failedAt = this.failedLods[failKey];

    // Cooldown gate
    if (failedAt && Date.now() - failedAt < CONFIG.FAILURE_COOLDOWN_MS) {
      const ageS = Math.round((Date.now() - failedAt) / 1000);
      this._log("skip", `${from}->${target} failed ${ageS}s ago; cooldown`);
      return Promise.resolve(this.activeLod);
    }

    if (target === "coarse") {
      this._showOnly("coarse");
      this.activeLod = "coarse";
      const elapsed = performance.now() - startedAt;
      this._log("swap", `${from}->coarse; zoom ${zoom.toFixed(2)}; ${reason}; ${elapsed.toFixed(0)}ms`);
      return Promise.resolve("coarse");
    }

    // medium or fine: build tile layer, await first tile, cross-fade
    return this._ensureTileLayer(target, token).then(function (tileLayer) {
      if (self.disposed || token !== self.swapToken) {
        self._log("stale", `${target} aborted; map changed mid-load`);
        return self.activeLod;
      }
      if (!tileLayer) {
        // Timeout/error
        self.failedLods[failKey] = Date.now();
        self._showOnly("coarse");
        self.activeLod = "coarse";
        self._log("unavailable", `${target}; retaining coarse; timeout or error`);
        return self.activeLod;
      }
      return self._crossFade(target, tileLayer).then(function () {
        if (self.disposed || token !== self.swapToken) {
          self._log("stale", `${target} cross-fade aborted`);
          return self.activeLod;
        }
        self.activeLod = target;
        const elapsed = performance.now() - startedAt;
        self._log("swap", `${from}->${target}; zoom ${zoom.toFixed(2)}; ${reason}; ${elapsed.toFixed(0)}ms`);
        return target;
      });
    });
  };

  BathyLodController.prototype._ensureTileLayer = function (lod, token) {
    const self = this;
    if (this.tileLayers[lod]) return Promise.resolve(this.tileLayers[lod]);
    const rootUrl = (CONFIG.TILE_ROOTS[this.regionId] || {})[lod];
    if (!rootUrl) return Promise.resolve(null);

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
      style: CONFIG.STYLE,
      opacity: 0,
      zIndex: (this.coarseLayer.getZIndex ? this.coarseLayer.getZIndex() : 15) + 0.1
    });
    this.map.addLayer(layer);
    this.tileLayers[lod] = layer;

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
      // No explicit "kick" needed: the source starts loading as soon as
      // the layer is added to the map and there are visible tiles.
      // Edge case: if the layer is added but the current zoom is outside
      // [minZoom, maxZoom], no tiles are requested → timeout fires → null.
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
            fromLayer.setOpacity(1);
            fromLayer.setVisible(target === "coarse");
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
    this.swapToken++;       // invalidate any in-flight swap
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