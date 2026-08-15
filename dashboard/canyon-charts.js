// fishing-grounds.js — FishEdge toggleable undersea-feature labels.
// The current authoritative source is BOEM's US Submarine Canyons service.
// Labels are placed at polygon centroids, not at an average of all vertices;
// averaging vertices can put a long/concave canyon label in the wrong water.
// Layer zIndex is above raster products so labels remain visible when the
// Underwater toggle is enabled, while the Captain controls stay on top.

(function () {
  'use strict';

  var SOURCE_LABEL = 'BOEM US Submarine Canyons';
  var SERVICE_ROOT =
    'https://services.arcgis.com/bDAhvQYMG4WL8O5o/arcgis/rest/services/' +
    'US_Submarine_Canyons/FeatureServer/';
  var GEBCO_ROOT =
    'https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/' +
    'Undersea_Features/FeatureServer/0/query';
  var ATTRIBUTION =
    'Underwater structures: BOEM canyons + GEBCO undersea features';
  var CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  var FETCH_TIMEOUT_MS = 12000;
  var BBOX_PAD = 0.05;
  var MAX_FEATURES = 250;
  // Labels must sit above raster products (zIndex 10+) and beneath the
  // Captain controls. The previous zIndex 5 put every structure underneath
  // CHL/SST/UV imagery, making the toggle appear to do nothing.
  var BASEMAP_ZINDEX = 60;
  var REGION_BBOXES = {
    usec_south: [-81, 31, -73, 36],
    usec_md: [-76.5, 35.5, -71.5, 40.5],
  };

  var state = {
    layers: new Map(),
    cache: new Map(),
    inflight: new Map(),
    attributionEl: null,
    visible: false,
  };

  function log() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[fishing-grounds]');
    if (window.console && console.log) console.log.apply(console, args);
  }
  function logErr() {
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[fishing-grounds]');
    if (window.console && console.error) console.error.apply(console, args);
  }
  function bboxKey(bbox) { return bbox.map(function (v) { return v.toFixed(2); }).join(','); }

  function paddedBbox(extent) {
    var min = ol.proj.toLonLat([extent[0], extent[1]]);
    var max = ol.proj.toLonLat([extent[2], extent[3]]);
    var dx = (max[0] - min[0]) * BBOX_PAD;
    var dy = (max[1] - min[1]) * BBOX_PAD;
    return [
      Math.max(-180, min[0] - dx), Math.max(-90, min[1] - dy),
      Math.min(180, max[0] + dx), Math.min(90, max[1] + dy),
    ];
  }

  function selectedRegionBbox() {
    var region = new URLSearchParams(window.location.search).get('region');
    return REGION_BBOXES[region] || null;
  }

  function ringCentroid(ring) {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    var twiceArea = 0, cx = 0, cy = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      var a = ring[i], b = ring[i + 1];
      var cross = a[0] * b[1] - b[0] * a[1];
      twiceArea += cross;
      cx += (a[0] + b[0]) * cross;
      cy += (a[1] + b[1]) * cross;
    }
    if (Math.abs(twiceArea) < 1e-12) return null;
    return { area: Math.abs(twiceArea) / 2, point: [cx / (3 * twiceArea), cy / (3 * twiceArea)] };
  }

  function polygonCentroid(polygon) {
    if (!Array.isArray(polygon) || !polygon.length) return null;
    // The outer ring determines the geographic label location. Holes are not
    // relevant to a named canyon's label anchor.
    return ringCentroid(polygon[0]);
  }

  function featurePoint(feature) {
    var geometry = feature.geometry || {};
    if (feature.centroid && Number.isFinite(Number(feature.centroid.x)) && Number.isFinite(Number(feature.centroid.y))) {
      return [Number(feature.centroid.x), Number(feature.centroid.y)];
    }
    if (feature.centroid && Array.isArray(feature.centroid.coordinates)) return feature.centroid.coordinates;
    // ArcGIS JSON polygon geometry uses `rings`; normalize it for the same
    // centroid fallback used by GeoJSON responses.
    if (Array.isArray(geometry.rings)) {
      geometry = { type: 'Polygon', coordinates: geometry.rings };
    }
    var candidates = [];
    if (geometry.type === 'Polygon') {
      var polygon = polygonCentroid(geometry.coordinates);
      if (polygon) candidates.push(polygon);
    } else if (geometry.type === 'MultiPolygon') {
      (geometry.coordinates || []).forEach(function (poly) {
        var candidate = polygonCentroid(poly);
        if (candidate) candidates.push(candidate);
      });
    }
    if (candidates.length) {
      candidates.sort(function (a, b) { return b.area - a.area; });
      return candidates[0].point;
    }
    // Defensive fallback for a future point/line service.
    var coords = [];
    (function collect(value) {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') { coords.push(value); return; }
      value.forEach(collect);
    })(geometry.coordinates);
    if (!coords.length) return null;
    var lon = 0, lat = 0;
    coords.forEach(function (c) { lon += c[0]; lat += c[1]; });
    return [lon / coords.length, lat / coords.length];
  }

  function fetchLayer(layerId, where, bbox) {
    var params = new URLSearchParams({
      where: where,
      geometry: bbox.join(','),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      outFields: 'Name,Region,Sys_Can,DepthMin_m,DepthMax_m,Length_Km',
      // ArcGIS JSON includes the service-calculated centroid when
      // returnCentroid=true. GeoJSON silently omitted that field, which made
      // multipart canyons fall back to an inaccurate largest-polygon point.
      f: 'json',
      returnGeometry: 'true',
      returnCentroid: 'true',
      resultRecordCount: String(MAX_FEATURES),
      returnExceededLimitFeatures: 'false',
    });
    var ctrl = new AbortController();
    var timeout = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(SERVICE_ROOT + layerId + '/query?' + params.toString(), { signal: ctrl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (j.error) throw new Error(j.error.message || 'GEBCO query error');
        return (j.features || []).map(function (f) {
          var point = featurePoint(f);
          if (!point) return null;
          var p = f.attributes || {};
          return { point: point, name: p.Name || 'Unnamed',
            type: 'Canyon', region: p.Region,
            system: p.Sys_Can };
        }).filter(Boolean);
      })
      .finally(function () { clearTimeout(timeout); });
  }

  function fetchGrounds(bbox) {
    var key = bboxKey(bbox);
    var cached = state.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached.features);
    if (state.inflight.has(key)) return state.inflight.get(key);
    var promise = fetchLayer(0, '1=1', bbox).then(function (features) {
      state.cache.set(key, { features: features, fetchedAt: Date.now() });
      return features;
    }).catch(function (err) {
      logErr('fetch failed', err && err.message ? err.message : err);
      return [];
    }).finally(function () { state.inflight.delete(key); });
    state.inflight.set(key, promise);
    return promise;
  }

  function gebcoType(code) {
    var map = { CNYU: 'Canyon', SHSU: 'Shoal', RISU: 'Ridge', TERU: 'Terrace',
      PLNU: 'Plain', SHVU: 'Shelf valley', SPUR: 'Spur', SEAU: 'Seamount',
      BANK: 'Bank', REEF: 'Reef' };
    return map[code] || code || 'Undersea feature';
  }

  function fetchGebco(bbox) {
    var key = 'gebco:' + bboxKey(bbox);
    var cached = state.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached.features);
    if (state.inflight.has(key)) return state.inflight.get(key);
    var params = new URLSearchParams({
      where: '1=1', geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope',
      inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
      outFields: 'UF_NAME,DSG,CENT_LAT,CENT_LONG', returnGeometry: 'false',
      resultRecordCount: '2000', f: 'json'
    });
    var ctrl = new AbortController();
    var timeout = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    var promise = fetch(GEBCO_ROOT + '?' + params.toString(), { signal: ctrl.signal })
      .then(function (r) { if (!r.ok) throw new Error('GEBCO HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (j.error) throw new Error(j.error.message || 'GEBCO query error');
        return (j.features || []).map(function (f) {
          var p = f.attributes || {};
          var lon = Number(p.CENT_LONG), lat = Number(p.CENT_LAT);
          if (!Number.isFinite(lon) || !Number.isFinite(lat) || !p.UF_NAME) return null;
          return { point: [lon, lat], name: p.UF_NAME, type: gebcoType(p.DSG), source: 'GEBCO' };
        }).filter(Boolean);
      })
      .then(function (features) { state.cache.set(key, { features: features, fetchedAt: Date.now() }); return features; })
      .catch(function (err) { logErr('GEBCO fetch failed', err && err.message ? err.message : err); return []; })
      .finally(function () { clearTimeout(timeout); state.inflight.delete(key); });
    state.inflight.set(key, promise);
    return promise;
  }

  function mergeFeatures(boem, gebco) {
    // Prefer the gazetteer anchor for a named feature; BOEM's polygon
    // centroid is retained only when GEBCO has no matching name.
    var merged = gebco.slice();
    boem.forEach(function (item) {
      var duplicate = merged.some(function (existing) {
        var nameA = String(existing.name || '').toLowerCase();
        var nameB = String(item.name || '').toLowerCase();
        var nameMatch = nameA === nameB || nameB.indexOf(nameA) === 0 || nameA.indexOf(nameB) === 0;
        // BOEM uses short names ("Norfolk") while GEBCO uses the full
        // gazetteer name ("Norfolk Canyon"). Treat those as the same named
        // feature even when the polygon centroid and gazetteer anchor differ.
        return nameMatch;
      });
      if (!duplicate) merged.push(item);
    });
    return merged;
  }

  function styleFor(feature) {
    var type = feature.get('type');
    var canyon = type === 'Canyon';
    return new ol.style.Style({
      image: new ol.style.RegularShape({
        points: canyon ? 3 : 5,
        radius: canyon ? 5 : 4,
        angle: canyon ? 0 : Math.PI / 5,
        fill: new ol.style.Fill({ color: canyon ? '#ffd166' : '#62e6c5' }),
        stroke: new ol.style.Stroke({ color: '#08131b', width: 1.2 }),
      }),
      text: new ol.style.Text({
        text: feature.get('name'),
        font: '600 11px system-ui, -apple-system, sans-serif',
        fill: new ol.style.Fill({ color: canyon ? '#ffe9b3' : '#a8ffe8' }),
        stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,0.9)', width: 3 }),
        offsetY: -10,
        textAlign: 'center',
        textBaseline: 'bottom',
        overflow: true,
      }),
    });
  }

  function attachToMap(map) {
    if (!map || state.layers.has(map) || typeof ol === 'undefined') return;
    var source = new ol.source.Vector({ wrapX: false });
    var layer = new ol.layer.Vector({
      source: source,
      declutter: true,
      zIndex: BASEMAP_ZINDEX,
      properties: { 'fish-layer': 'fishing-grounds', 'fish-source': SOURCE_LABEL },
      style: styleFor,
    });
    map.addLayer(layer);
    layer.setVisible(state.visible);
    state.layers.set(map, layer);
    function refresh() {
      var view = map.getView();
      // Combined mode attaches this layer while the OL view is still being
      // fitted. OpenLayers throws if calculateExtent() runs before a center
      // exists; defer until the first move/resize event instead of aborting
      // the dashboard renderer.
      if (!view || !view.getCenter()) return;
      var extent = view.calculateExtent(map.getSize() || [800, 600]);
      // Never let a broad/temporarily-unfitted map viewport turn a regional
      // dashboard into a worldwide feature-name layer.
      var bbox = selectedRegionBbox() || paddedBbox(extent);
      Promise.all([fetchGrounds(bbox), fetchGebco(bbox)]).then(function (sets) {
        var items = mergeFeatures(sets[0], sets[1]);
        source.clear();
        source.addFeatures(items.map(function (item) {
          var f = new ol.Feature({ geometry: new ol.geom.Point(ol.proj.fromLonLat(item.point)),
            name: item.name, type: item.type, region: item.region,
            system: item.system, source: item.source || SOURCE_LABEL });
          return f;
        }));
        layer.setVisible(state.visible);
        log('refreshed', items.length, 'underwater structures');
      });
    }
    map.on('moveend', refresh);
    map.on('change:size', refresh);
    refresh();
  }

  function scoutMaps() {
    // The dashboard keeps desktopMapState/mobileMapState module-scoped, so
    // they are not available as window properties. Its map instrumentation
    // exposes the live OpenLayers instances here; use those as the primary
    // attachment path and retain the older globals for compatibility.
    if (window.__fishedgeMaps && window.__fishedgeMaps.length) {
      window.__fishedgeMaps.forEach(attachToMap);
    }
    if (window.desktopMapState && window.desktopMapState.map) attachToMap(window.desktopMapState.map);
    if (window.mobileMapState && window.mobileMapState.map) attachToMap(window.mobileMapState.map);
    if (window._combinedMap) attachToMap(window._combinedMap);
  }

  function showAttribution() {
    // Source metadata remains on the vector layer for diagnostics, but the
    // viewer intentionally has no visible attribution card.
  }

  function hideAttribution() {
    if (!state.attributionEl) return;
    state.attributionEl.remove();
    state.attributionEl = null;
  }

  function setVisible(visible) {
    state.visible = Boolean(visible);
    state.layers.forEach(function (layer) { layer.setVisible(state.visible); });
    hideAttribution();
    window.dispatchEvent(new CustomEvent('fishedge-underwater-visibility', {
      detail: { visible: state.visible }
    }));
    return state.visible;
  }

  function init() {
    if (window.__fishing_grounds_loaded) return;
    window.__fishing_grounds_loaded = true;
    if (typeof ol === 'undefined') return;
    window.fishedgeUnderwater = {
      setVisible: setVisible,
      toggle: function () { return setVisible(!state.visible); },
      isVisible: function () { return state.visible; },
      attachMap: attachToMap
    };
    var tick = 0;
    scoutMaps();
    var interval = setInterval(function () {
      scoutMaps();
      if (++tick > 60) clearInterval(interval);
    }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
