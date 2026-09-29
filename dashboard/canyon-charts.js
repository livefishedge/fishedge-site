// fishing-grounds.js — FishEdge toggleable undersea-feature labels.
// The layer merges federal undersea features with local NJ/MD fishing-ground
// and reef datasets so the map uses the names captains actually use.
// Labels are placed at polygon centroids, not at an average of all vertices;
// averaging vertices can put a long/concave canyon label in the wrong water.
// Layer zIndex is above raster products so labels remain visible when the
// Underwater toggle is enabled, while the Captain controls stay on top.

(function () {
  'use strict';

  var SOURCE_LABEL = 'Local fishing grounds + BOEM/GEBCO';
  var SERVICE_ROOT =
    'https://services.arcgis.com/bDAhvQYMG4WL8O5o/arcgis/rest/services/' +
    'US_Submarine_Canyons/FeatureServer/';
  var GEBCO_ROOT =
    'https://services2.arcgis.com/Uq9r85Potqm3MfRV/arcgis/rest/services/' +
    'Undersea_Features/FeatureServer/0/query';
  var NJ_GROUNDS_URL =
    'https://www.shore-guide.com/data/downloads/nj-fishing-grounds.geojson';
  // Local fishing-ground sources are compiled into one static asset during
  // deployment. This avoids four live GIS requests and browser-side cleanup
  // on every map attach/refresh.
  var STATIC_LOCAL_GROUNDS_URL = '/dashboard/data/fishing-grounds.json';
  var STATIC_LOCAL_POINTS_URL = '/dashboard/data/fishing-grounds-points.json';
  var MD_FISHING_ROOT =
    'https://mdgeodata.md.gov/imap/rest/services/Biota/MD_Finfish/FeatureServer/10/query';
  var MD_REEF_ROOT =
    'https://mdgeodata.md.gov/imap/rest/services/Biota/MD_Finfish/FeatureServer/9/query';
  var ATLANTIC_FISHING_ATLAS_ROOT =
    'https://gis.boem.gov/arcgis/rest/services/AtlanticFishGuide/' +
    'Atlantic_Coast_Fishing_Atlas/MapServer/2/query';
  var SOUTH_BOEM_FIELDS = 'OBJECTID,NAME,TYPE';
  var ATTRIBUTION =
    'Underwater structures: NJ DEP + MD DNR + BOEM/GEBCO';
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
    labelLayers: new Map(),
    items: new Map(),
    data: new Map(),
    cache: new Map(),
    inflight: new Map(),
    attributionEl: null,
    visible: false,
    showPolygons: false,
    zoneFilter: 'all',
    sourceFilter: 'all',
    staticLocalPromise: null,
    staticLocalPointsPromise: null,
    staticLocalPolygonsPromise: null,
    staticLocalPointsPromises: new Map(),
    staticLocalPolygonsPromises: new Map(),
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
  function structureMatchesFilters(item) {
    return (!state.zoneFilter || state.zoneFilter === 'all' || item.zone === state.zoneFilter) &&
      (!state.sourceFilter || state.sourceFilter === 'all' || item.source_status === state.sourceFilter);
  }

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
    var region = new URLSearchParams(window.location.search).get('region') || window.REGION_ID || window.__FISHEDGE_ACTIVE_REGION;
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
      // Canyon geometry is retained even in point mode so authoritative
      // offshore canyon polygons can be shown by the shared underwater layer.
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
          var geometry = f.geometry && Array.isArray(f.geometry.rings)
            ? { type: 'Polygon', coordinates: f.geometry.rings } : null;
          return p.Name ? { point: point, geometry: geometry, name: p.Name,
            type: 'Canyon', region: p.Region,
            system: p.Sys_Can } : null;
        }).filter(Boolean);
      })
      .finally(function () { clearTimeout(timeout); });
  }

  function fetchGrounds(bbox) {
    var key = 'grounds:' + (state.showPolygons ? 'polygons:' : 'points:') + bboxKey(bbox);
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

  function pointInBbox(point, bbox) {
    return point && point[0] >= bbox[0] && point[0] <= bbox[2] &&
      point[1] >= bbox[1] && point[1] <= bbox[3];
  }

  function geometryBbox(geometry) {
    if (!geometry) return null;
    var coords = [];
    (function collect(value) {
      if (!Array.isArray(value)) return;
      if (value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number') {
        coords.push(value);
        return;
      }
      value.forEach(collect);
    })(geometry.rings || geometry.coordinates);
    if (!coords.length) return null;
    var minLon = coords[0][0], maxLon = coords[0][0], minLat = coords[0][1], maxLat = coords[0][1];
    coords.forEach(function (point) {
      minLon = Math.min(minLon, point[0]); maxLon = Math.max(maxLon, point[0]);
      minLat = Math.min(minLat, point[1]); maxLat = Math.max(maxLat, point[1]);
    });
    return [minLon, minLat, maxLon, maxLat];
  }

  function featureIntersectsBbox(item, bbox) {
    if (!item) return false;
    if (pointInBbox(item.point, bbox)) return true;
    var featureBox = geometryBbox(item.geometry);
    return Boolean(featureBox && intersectBboxes(featureBox, bbox));
  }

  function intersectBboxes(a, b) {
    var out = [Math.max(a[0], b[0]), Math.max(a[1], b[1]),
      Math.min(a[2], b[2]), Math.min(a[3], b[3])];
    return out[0] <= out[2] && out[1] <= out[3] ? out : null;
  }

  function fetchArcGISLocal(url, bbox, type) {
    var params = new URLSearchParams({
      where: '1=1', geometry: bbox.join(','),
      geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: '*',
      returnGeometry: 'true', resultRecordCount: '2000', f: 'json'
    });
    return fetch(url + '?' + params.toString())
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        if (j.error) throw new Error(j.error.message || 'Maryland query error');
        return (j.features || []).map(function (f) {
          var point = featurePoint(f);
          var p = f.attributes || {};
          var name = p.Name || p.name || p.NAME;
          var geometry = f.geometry && Array.isArray(f.geometry.rings)
            ? { type: 'Polygon', coordinates: f.geometry.rings } : null;
          var item = { point: point, geometry: geometry, name: name, type: type, source: 'Maryland DNR' };
          return point && name && featureIntersectsBbox(item, bbox) ? item : null;
        }).filter(Boolean);
      });
  }

  function fetchNjLocal(bbox) {
    return fetch(NJ_GROUNDS_URL)
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        return (j.features || []).map(function (f) {
          var point = featurePoint(f);
          var p = f.properties || {};
          var item = { point: point, geometry: f.geometry, name: p.name, type: 'Fishing ground',
            region: p.region, system: p.profileType, source: 'NJ DEP / Shore Guide' };
          return point && p.name && featureIntersectsBbox(item, bbox) ? item : null;
        }).filter(Boolean);
      });
  }

  function fetchLocalGrounds(bbox) {
    var key = 'local:' + bboxKey(bbox);
    var cached = state.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached.features);
    if (state.inflight.has(key)) return state.inflight.get(key);
    // One compiled catalog is authoritative for both regions. The old MD
    // legacy asset had a different record set and reintroduced duplicates.
    var pointsUrl = STATIC_LOCAL_POINTS_URL + '?v=20260929-catalog-v8';
    if (!state.staticLocalPointsPromises.has(pointsUrl)) {
      state.staticLocalPointsPromises.set(pointsUrl, fetch(pointsUrl)
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { return Array.isArray(j.features) ? j.features : []; })
        .catch(function (err) {
          logErr('static fishing-ground asset failed', err && err.message ? err.message : err);
          return [];
        }));
    }
    var promise = state.staticLocalPointsPromises.get(pointsUrl).then(function (allFeatures) {
      var features = allFeatures.filter(function (item) { return featureIntersectsBbox(item, bbox); });
      state.cache.set(key, { features: features, fetchedAt: Date.now() });
      return features;
    }).catch(function (err) {
      logErr('local fishing-ground fetch failed', err && err.message ? err.message : err);
      return [];
    }).finally(function () { state.inflight.delete(key); });
    state.inflight.set(key, promise);
    return promise;
  }

  function fetchLocalPolygons(bbox) {
    var key = 'local-polygons:' + bboxKey(bbox);
    var cached = state.cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached.features);
    if (state.inflight.has(key)) return state.inflight.get(key);
    var polygonsUrl = STATIC_LOCAL_GROUNDS_URL + '?v=20260929-catalog-v8';
    if (!state.staticLocalPolygonsPromises.has(polygonsUrl)) {
      state.staticLocalPolygonsPromises.set(polygonsUrl, fetch(polygonsUrl)
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function (j) { return Array.isArray(j.features) ? j.features : []; })
        .catch(function (err) {
          logErr('static fishing-ground polygon asset failed', err && err.message ? err.message : err);
          return [];
        }));
    }
    var promise = state.staticLocalPolygonsPromises.get(polygonsUrl).then(function (allFeatures) {
      var features = allFeatures.filter(function (item) { return featureIntersectsBbox(item, bbox); });
      state.cache.set(key, { features: features, fetchedAt: Date.now() });
      return features;
    }).finally(function () { state.inflight.delete(key); });
    state.inflight.set(key, promise);
    return promise;
  }

  function fetchBoemSouth(bbox) {
    var params = new URLSearchParams({ where:'1=1', geometry:bbox.join(','), geometryType:'esriGeometryEnvelope', inSR:'4326', spatialRel:'esriSpatialRelIntersects', outFields:SOUTH_BOEM_FIELDS, returnGeometry:'true', outSR:'4326', geometryPrecision:'5', resultRecordCount:'100', f:'json' });
    var ctrl = new AbortController();
    var timeout = setTimeout(function () { ctrl.abort(); }, FETCH_TIMEOUT_MS);
    return fetch(ATLANTIC_FISHING_ATLAS_ROOT + '?' + params.toString(), { signal: ctrl.signal }).then(function (r) { if (!r.ok) throw new Error('BOEM HTTP ' + r.status); return r.json(); }).then(function (j) {
      return (j.features || []).map(function (f) {
        var point = featurePoint(f), a = f.attributes || {};
        return point && a.NAME ? { point:point, geometry:f.geometry && f.geometry.rings ? { type:'Polygon', coordinates:f.geometry.rings } : null, name:a.NAME, type:a.TYPE || 'Fishing ground', source:'BOEM Atlantic Fishing Atlas' } : null;
      }).filter(Boolean);
    }).finally(function () { clearTimeout(timeout); }).catch(function (err) { logErr('BOEM South fishing-area fetch failed', err && err.message ? err.message : err); return []; });
  }

  function mergeFeatureSets(sets) {
    return mergeNamedFeatures([].concat.apply([], sets));
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

  function canonicalName(raw) {
    var name = String(raw || '').trim();
    var key = name.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    var aliases = {
      'norfolk': 'Norfolk Canyon',
      'norfolk canyon': 'Norfolk Canyon',
      'norfork canyon': 'Norfolk Canyon',
      'baltimore': 'Baltimore Canyon',
      'baltimore canyon': 'Baltimore Canyon',
      'wilmington': 'Wilmington Canyon',
      'wilmington canyon': 'Wilmington Canyon',
      'hudson': 'Hudson Canyon',
      'hudson canyon': 'Hudson Canyon',
      'poormans canyon': "Poor Man's Canyon",
      'poor mans canyon': "Poor Man's Canyon",
      'cigar or little bimini': 'The Cigar',
      'the cigar': 'The Cigar',
      '21 mile little hill or lump': '21 Mile Hill',
      '21 mile hill': '21 Mile Hill',
      '3 mile 10 mile hill or lump': '3 Mile Hill',
      '3 mile hill': '3 Mile Hill'
    };
    var known = aliases[key];
    if (known) return known;
    // Normalize harmless spelling/punctuation variants while preserving
    // meaningful directional, numbered, depth, and distance qualifiers.
    return name.replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
  }

  function mergeGeometry(a, b) {
    if (!a) return b;
    if (!b) return a;
    var parts = [];
    [a, b].forEach(function (geometry) {
      if (geometry.type === 'Polygon') parts.push(geometry.coordinates);
      if (geometry.type === 'MultiPolygon') parts = parts.concat(geometry.coordinates);
    });
    var unique = [];
    parts.forEach(function (part) {
      var fingerprint = JSON.stringify(part);
      if (!unique.some(function (candidate) { return candidate.fingerprint === fingerprint; })) {
        unique.push({ fingerprint: fingerprint, coordinates: part });
      }
    });
    if (unique.length === 1) return { type: 'Polygon', coordinates: unique[0].coordinates };
    return { type: 'MultiPolygon', coordinates: unique.map(function (part) { return part.coordinates; }) };
  }

  function identityName(raw) {
    return String(raw || '').toLowerCase().replace(/[’']/g, '')
      .replace(/[^a-z0-9()]+/g, ' ').trim().replace(/\s+/g, ' ');
  }

  var identityDescriptors = { canyon:1, valley:1, ridge:1, lump:1, lumps:1,
    rock:1, rocks:1, reef:1, reefs:1, bank:1, banks:1, shoal:1, shoals:1,
    hole:1, holes:1, bed:1, beds:1, ground:1, grounds:1 };
  var identitySynonyms = { inside: 'inside', inner: 'inside', inshore: 'inside', outside: 'outside', outer: 'outside' };
  function identityCore(raw) {
    var value = identityName(raw)
      .replace(/\((?:north|south|east|west|northeast|northwest|southeast|southwest)\)/g, '')
      .replace(/(canyon|valley|ridge|lumps?|rocks?|reefs?|banks?|shoals?|holes?|beds?|grounds?)$/g, ' $1');
    return value.split(' ').filter(function (token) {
      token = identitySynonyms[token] || token;
      return token && !identityDescriptors[token];
    });
  }
  function identityVariants(raw) {
    return String(raw || '').replace(/\((?:north|south|east|west|northeast|northwest|southeast|southwest)\)/gi, ' ')
      .split(/\s+or\s+|\s*\/\s*/i).map(function (part) { return part.trim(); }).filter(Boolean);
  }
  function identityDirections(raw) {
    return identityName(raw).replace(/\([^)]*\)/g, '').split(' ').filter(function (token) {
      return /^(north|south|east|west|northeast|northwest|southeast|southwest)$/.test(token);
    });
  }
  function identitySoundex(raw) {
    var word = String(raw || '').replace(/[^a-z]/gi, '').toUpperCase();
    if (!word) return '';
    var map = { B:1,F:1,P:1,V:1,C:2,G:2,J:2,K:2,Q:2,S:2,X:2,Z:2,D:3,T:3,L:4,M:5,N:5,R:6 };
    var out = word.charAt(0), previous = map[word.charAt(0)] || 0;
    for (var i = 1; i < word.length && out.length < 4; i++) {
      var code = map[word.charAt(i)] || 0;
      if (code && code !== previous) out += code;
      previous = code;
    }
    return (out + '000').slice(0, 4);
  }
  function identityMatch(a, b) {
    var aa = identityCore(a), bb = identityCore(b);
    if (!aa.length || aa.length !== bb.length) return false;
    var da = identityDirections(a), db = identityDirections(b);
    if (da.length && db.length && da.join('|') !== db.join('|')) return false;
    var na = identityName(a).split(' ')[0], nb = identityName(b).split(' ')[0];
    if (/^\d/.test(na) && /^\d/.test(nb) && na !== nb) return false;
    var left = aa.map(identitySoundex), right = bb.map(identitySoundex);
    return left.every(function (code, i) { return code && code === right[i]; });
  }

  // A family is a display hierarchy, not a destructive merge. In particular,
  // distance-suffixed NJ blocks are child polygons of one named fishing area.
  // Keep East and Southeast (and other explicit parents) separate.
  function structureFamilyName(raw) {
    var name = String(raw || '').trim();
    var distanceBlock = name.match(/^(.*?\bblock)\s*(?:[-—]\s*)?(?:\d+(?:\.\d+)?\s*nm)(?:\s+\d+)?$/i);
    if (distanceBlock) return distanceBlock[1].replace(/\s+/g, ' ').trim();
    var numberedBlock = name.match(/^(.*?\bblock)\s*[-—]?\s*\d+$/i);
    return numberedBlock ? numberedBlock[1].replace(/\s+/g, ' ').trim() : name;
  }

  function structureFamilyId(item) {
    return String(item && item.source || SOURCE_LABEL).toLowerCase().replace(/[^a-z0-9]+/g, '-') + ':' +
      structureFamilyName(item && item.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  function isMdRegion() {
    return selectedRegionBbox() === REGION_BBOXES.usec_md;
  }

  // MD's legacy source catalog contains many useful polygons but also
  // provisional NJ distance/block labels. Keep those records in the geometry
  // layer; they are not default captain-facing labels.
  function mdLabelEligible(item) {
    if (!isMdRegion()) return true;
    return !(item && item.source === 'NJ DEP / Shore Guide' && /\b(block|offshore|deep\s*water)\b/i.test(String(item.name || '')));
  }

  function mdLabelPriority(item) {
    if (!item) return 9;
    if (item.type === 'Canyon' || /canyon/i.test(String(item.name || ''))) return 0;
    if (item.source === 'BOEM Atlantic Fishing Atlas' || item.source === 'Maryland DNR') return 1;
    return 2;
  }

  function hasProtectedSubarea(raw) {
    return /(^|\s)(block|site|box|nm|fathom|fathoms)\b|\b\d+(?:\.\d+)?\s*(?:nm|mile|miles|fathom|fathoms)\b/i.test(String(raw || ''));
  }

  function samePhysicalStructure(a, b) {
    if (!a || !b || !a.point || !b.point || hasProtectedSubarea(a.name) || hasProtectedSubarea(b.name)) return false;
    var da = identityDirections(a.name), db = identityDirections(b.name);
    if (da.length && db.length && da.join('|') !== db.join('|')) return false;
    var na = identityName(a.name).split(' ')[0], nb = identityName(b.name).split(' ')[0];
    if (/^\d/.test(na) && /^\d/.test(nb) && na !== nb) return false;
    var dx = (a.point[0] - b.point[0]) * Math.cos((a.point[1] + b.point[1]) * Math.PI / 360);
    var dy = a.point[1] - b.point[1];
    var distance = Math.sqrt(dx * dx + dy * dy);
    // Descriptor changes and phonetic spelling variants are accepted only
    // inside a tight geographic neighborhood. Directional/numbered distance
    // blocks remain protected by hasProtectedSubarea above.
    var matched = identityVariants(a.name).some(function (leftName) {
      return identityVariants(b.name).some(function (rightName) {
        var left = identityCore(leftName).join(''), right = identityCore(rightName).join('');
        return left.length >= 2 && (left === right || identityMatch(leftName, rightName));
      });
    });
    return distance <= 0.12 && matched;
  }

  function structureId(item) {
    var point = item.point || [0, 0];
    return canonicalName(item.name).toLowerCase().replace(/[^a-z0-9]+/g, '-') + ':' +
      Number(point[0]).toFixed(4) + ':' + Number(point[1]).toFixed(4);
  }

  function mergeNamedFeatures(features) {
    var merged = [];
    features.forEach(function (item) {
      var displayName = canonicalName(item.name);
      var existing = merged.find(function (candidate) {
        return samePhysicalStructure(candidate, Object.assign({}, item, { name: displayName }));
      });
      if (!existing) {
        merged.push(Object.assign({}, item, { name: displayName, aliases: item.aliases || [], id: item.id || structureId(item), family_id: structureFamilyId(item), family_name: structureFamilyName(displayName) }));
      } else {
        if (displayName !== existing.name && (existing.aliases || []).indexOf(displayName) < 0) existing.aliases.push(displayName);
        existing.geometry = mergeGeometry(existing.geometry, item.geometry);
      }
    });
    // Draw canyons first so decluttering and label priority favor the
    // highest-value offshore structures when labels overlap.
    return merged.sort(function (a, b) {
      return (a.type === 'Canyon' ? 0 : 1) - (b.type === 'Canyon' ? 0 : 1);
    });
  }

  function mergeFeatures(boem, gebco, local) {
    // Local NJ/MD/Atlantic records own the region. Global BOEM/GEBCO records
    // are used only when no local records are available at all.
    // The local catalog is already identity-resolved at build time. Do not
    // run a second browser-side matcher: it can recreate aliases differently
    // after refresh and can merge legitimate nearby subareas. Keep one
    // authoritative record per persisted structure ID.
    var authoritative = (local || []).filter(function (item) {
      return item && String(item.name || '').trim() && Array.isArray(item.point);
    }).map(function (item) {
      var copy = Object.assign({}, item);
      copy.aliases = Array.isArray(item.aliases) ? item.aliases.slice() : [];
      copy.family_id = item.family_id || structureFamilyId(item);
      copy.family_name = item.family_name || structureFamilyName(item.name);
      copy.id = item.id || structureId(item);
      return copy;
    });
    return authoritative.length ? authoritative : mergeNamedFeatures(gebco.concat(boem));
  }

  function styleForGeometry(feature) {
    var polygon = feature.getGeometry() && feature.getGeometry().getType() !== 'Point';
    var underwaterColor = '#62e6c5';
    return new ol.style.Style({
      fill: polygon ? new ol.style.Fill({ color: 'rgba(98,230,197,0.10)' }) : undefined,
      stroke: polygon ? new ol.style.Stroke({ color: underwaterColor, width: 1.4 }) : undefined,
      image: new ol.style.RegularShape({
        points: 5,
        radius: 4,
        angle: Math.PI / 5,
        fill: new ol.style.Fill({ color: underwaterColor }),
        stroke: new ol.style.Stroke({ color: '#08131b', width: 1.2 }),
      }),
    });
  }

  // One label anchor per logical feature. Polygon components never get
  // their own text, so MultiPolygons cannot repeat a name several times.
  function styleForLabel(feature, resolution) {
    var isCanyon = feature.get('type') === 'Canyon';
    var mobile = window.innerWidth && window.innerWidth < 700;
    var maxResolution = isCanyon ? 3000 : (mobile ? 350 : 550);
    if (resolution > maxResolution) return null;
    return new ol.style.Style({
      text: new ol.style.Text({
        text: feature.get('name'),
        font: '600 11px system-ui, -apple-system, sans-serif',
        fill: new ol.style.Fill({ color: '#a8ffe8' }),
        stroke: new ol.style.Stroke({ color: 'rgba(0,0,0,0.9)', width: 3 }),
        offsetY: -10,
        textAlign: 'center',
        textBaseline: 'bottom',
        overflow: false,
        placement: 'point',
      }),
    });
  }

  function attachToMap(map) {
    // Fishing Grounds is a Captain's Dashboard layer. Product-specific maps
    // (SST/CHL/SLA/Bathymetry/thermal) must never receive these layers.
    // Previously scoutMaps() attached one shared layer pair to every map and
    // the global visibility flag made a Dashboard toggle leak across views.
    if (!map || map !== window._combinedMap || state.layers.has(map) || typeof ol === 'undefined') return;
    var source = new ol.source.Vector({ wrapX: false });
    var layer = new ol.layer.Vector({
      source: source,
      declutter: false,
      zIndex: BASEMAP_ZINDEX,
      properties: { 'fish-layer': 'fishing-grounds', 'fish-source': SOURCE_LABEL },
      style: styleForGeometry,
    });
    var labelSource = new ol.source.Vector({ wrapX: false });
    var labelLayer = new ol.layer.Vector({
      source: labelSource,
      declutter: true,
      zIndex: BASEMAP_ZINDEX + 1,
      properties: { 'fish-layer': 'fishing-ground-labels', 'fish-source': SOURCE_LABEL },
      style: styleForLabel,
      renderOrder: function (a, b) {
        return (a.get('type') === 'Canyon' ? 0 : 1) - (b.get('type') === 'Canyon' ? 0 : 1);
      },
    });
    map.addLayer(layer);
    map.addLayer(labelLayer);
    layer.setVisible(state.visible);
    labelLayer.setVisible(state.visible);
    state.layers.set(map, layer);
    state.labelLayers.set(map, labelLayer);
    var refreshSerial = 0;
    function render(items) {
      if (Array.isArray(items)) state.data.set(map, items);
      items = state.data.get(map) || [];
      source.clear();
      labelSource.clear();
      var geometryFeatures = [];
      var labelCandidates = [];
      var labelGroups = new Set();
      var mapResolution = map.getView() && map.getView().getResolution();
      // Group geometry and labels only at regional scale. The old MD-always-
      // grouped rule hid the zoom transition while still drawing every marker.
      var groupLabels = Number.isFinite(mapResolution) && mapResolution > 180;
      var familyCandidates = new Map();
      if (groupLabels) (items || []).forEach(function (item) {
        var familyId = item.family_id || structureFamilyId(item);
        var bucket = familyCandidates.get(familyId) || { items: [], lon: 0, lat: 0 };
        if (Array.isArray(item.point)) { bucket.items.push(item); bucket.lon += item.point[0]; bucket.lat += item.point[1]; }
        familyCandidates.set(familyId, bucket);
      });
      var familyRepresentatives = new Map();
      familyCandidates.forEach(function (bucket, familyId) {
        if (!bucket.items.length) return;
        var center = [bucket.lon / bucket.items.length, bucket.lat / bucket.items.length];
        var representative = bucket.items.slice().sort(function (a, b) {
          return Math.hypot(a.point[0] - center[0], a.point[1] - center[1]) - Math.hypot(b.point[0] - center[0], b.point[1] - center[1]);
        })[0];
        familyRepresentatives.set(familyId, representative);
      });
      var displayItems = (items || []).filter(function (item) {
        // An unlabeled feature must never create a marker or polygon. This is
        // intentionally enforced at render time because remote enrichments
        // can have a different schema from the compiled catalog.
        return item && String(item.name || '').trim() && mdLabelEligible(item) && structureMatchesFilters(item);
      });
      if (groupLabels && familyRepresentatives.size) {
        var seenFamilies = new Set();
        displayItems = displayItems.filter(function (item) {
          var familyId = item.family_id || structureFamilyId(item);
          if (seenFamilies.has(familyId)) return false;
          seenFamilies.add(familyId);
          return true;
        }).map(function (item) {
          return familyRepresentatives.get(item.family_id || structureFamilyId(item)) || item;
        });
      }
      displayItems.forEach(function (item) {
        var geometry = null;
        if (state.showPolygons && item.geometry && typeof ol.format !== 'undefined') {
          try {
            geometry = new ol.format.GeoJSON().readGeometry(item.geometry, {
              dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857'
            });
          } catch (err) { logErr('polygon geometry skipped', item.name, err); }
        }
        geometry = geometry || new ol.geom.Point(ol.proj.fromLonLat(item.point));
        geometryFeatures.push(new ol.Feature({ geometry: geometry, id: item.id || structureId(item),
          name: item.name, type: item.type, region: item.region, system: item.system,
          source: item.source || SOURCE_LABEL }));
        if (Array.isArray(item.point) && item.name) {
          // At regional scale, collapse nearby equivalent names to one
          // representative label. Geometry and markers are never removed;
          // close zoom reveals every canonical structure again.
          if (!mdLabelEligible(item)) return;
          var familyId = item.family_id || structureFamilyId(item);
          var representative = groupLabels ? familyRepresentatives.get(familyId) : item;
          var labelKey = groupLabels ? familyId : (item.id || structureId(item));
          if (labelGroups.has(labelKey)) return;
          labelGroups.add(labelKey);
          labelCandidates.push({ priority: mdLabelPriority(representative), feature: new ol.Feature({
            geometry: new ol.geom.Point(ol.proj.fromLonLat(representative.point)),
            id: representative.id || structureId(representative),
            name: groupLabels ? (representative.family_name || structureFamilyName(representative.name)) : representative.name,
            type: representative.type, region: representative.region, family_id: familyId,
          }) });
        }
      });
      source.addFeatures(geometryFeatures);
      var mobile = window.innerWidth && window.innerWidth < 700;
      // Every plotted feature has a corresponding label candidate. A prior
      // budget hid labels while leaving their markers/polygons behind, which
      // made the layer appear full of anonymous grounds.
      var labelBudget = labelCandidates.length;
      labelCandidates.sort(function (a, b) { return a.priority - b.priority; });
      labelSource.addFeatures(labelCandidates.slice(0, labelBudget).map(function (candidate) { return candidate.feature; }));
      layer.setVisible(state.visible);
      labelLayer.setVisible(state.visible);
    }
    state.items.set(map, render);
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
      var viewportBbox = paddedBbox(extent);
      var bbox = selectedRegionBbox()
        ? intersectBboxes(viewportBbox, selectedRegionBbox())
        : viewportBbox;
      if (!bbox) return;
      var requestSerial = ++refreshSerial;
      var south = selectedRegionBbox() === REGION_BBOXES.usec_south;
      function publish(items) {
        if (requestSerial !== refreshSerial) return;
        items = (items || []).filter(function (item) { return featureIntersectsBbox(item, bbox); });
        state.items.set(map, render);
        render(items);
        log('refreshed', items.length, 'underwater structures');
      }
      // Load the compiled local asset first. Only query the slower global
      // services when this viewport has no local coverage at all.
      fetchLocalGrounds(bbox).then(function (local) {
        if (local.length) {
          var basePromise = state.showPolygons ? fetchLocalPolygons(bbox) : Promise.resolve(local);
          return basePromise.then(function (base) {
            // The local catalog is already resolved by the build-time identity
            // ledger. Re-running the legacy browser matcher here recreates
            // aliases and duplicate labels. Preserve the authoritative IDs.
            var initial = mergeFeatures([], [], base);
            publish(initial);
            // The compiled catalog is authoritative in both regions. Do not
            // append live South enrichments after publication; those records
            // bypass the audited alias map and reintroduce duplicates.
            return;
          });
        }
        return Promise.all([fetchGrounds(bbox), fetchGebco(bbox)])
          .then(function (sets) {
            var initial = mergeFeatures(sets[0], sets[1], []);
            publish(initial);
            if (!south) return;
            return fetchBoemSouth(bbox).then(function (remote) {
              publish(mergeFeatureSets([initial, remote]));
            });
          });
      }).catch(function (err) { logErr('fishing-ground refresh failed', err); });
    }
    render.refresh = refresh;
    map.on('moveend', refresh);
    map.on('change:size', refresh);
    refresh();
  }

  function scoutMaps() {
    // The dashboard keeps desktopMapState/mobileMapState module-scoped, so
    // they are not available as window properties. Its map instrumentation
    // exposes the live OpenLayers instances here; use those as the primary
    // attachment path and retain the older globals for compatibility.
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
    state.labelLayers.forEach(function (layer) { layer.setVisible(state.visible); });
    hideAttribution();
    window.dispatchEvent(new CustomEvent('fishedge-underwater-visibility', {
      detail: { visible: state.visible }
    }));
    return state.visible;
  }

  function setFullPolygons(visible) {
    state.showPolygons = Boolean(visible);
    state.items.forEach(function (render) { render(); });
    // Polygon geometry is fetched lazily. Re-run each attached map only when
    // the user explicitly enables the full-polygon view.
    if (state.showPolygons) {
      state.layers.forEach(function (_, map) {
        var render = state.items.get(map);
        if (render && render.refresh) render.refresh();
      });
    }
    window.dispatchEvent(new CustomEvent('fishedge-fishing-ground-polygons', {
      detail: { visible: state.showPolygons }
    }));
    return state.showPolygons;
  }

  function setZoneFilter(value) {
    state.zoneFilter = value || 'all';
    state.items.forEach(function (render) { render(); });
    return state.zoneFilter;
  }

  function setSourceFilter(value) {
    state.sourceFilter = value || 'all';
    state.items.forEach(function (render) { render(); });
    return state.sourceFilter;
  }

  function init() {
    if (window.__fishing_grounds_loaded) return;
    window.__fishing_grounds_loaded = true;
    if (typeof ol === 'undefined') return;
    window.fishedgeUnderwater = {
      setVisible: setVisible,
      setFullPolygons: setFullPolygons,
      setZoneFilter: setZoneFilter,
      setSourceFilter: setSourceFilter,
      toggle: function () { return setVisible(!state.visible); },
      isVisible: function () { return state.visible; },
      isFullPolygons: function () { return state.showPolygons; },
      getZoneFilter: function () { return state.zoneFilter; },
      getSourceFilter: function () { return state.sourceFilter; },
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
