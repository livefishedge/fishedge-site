/*!
 * Inlet picker — top-of-planner control for selecting home inlet,
 * default departure/return times, and a named offshore fishing ground.
 *
 * Source of truth for inlet metadata: coops-tides.js INLET_STATION_TABLE.
 * If the bootstrap (or any caller) hasn't loaded that table yet, we fall
 * back to a minimal inline copy so the picker still mounts.
 */
(function attachInletPicker(global) {
  'use strict';
  const Coops = global.CoopsTides;
  const INLETS = (Coops && Coops.INLET_STATION_TABLE) || {
    'ocean-city-md':         { station_id: '8570283', label: 'Ocean City Inlet, MD', lat: 38.3286, lon: -75.0919 },
    'indian-river-inlet-de': { station_id: '8557863', label: 'Indian River Inlet, DE', lat: 38.6100, lon: -75.0589 },
    'cape-may-nj':           { station_id: '8536110', label: 'Cape May, NJ',           lat: 38.9686, lon: -74.9594 },
    'lewes-de':              { station_id: '8557689', label: 'Lewes, DE',              lat: 38.7817, lon: -75.1197 },
    'chesapeake-bay-bt':     { station_id: '8573364', label: 'Chesapeake Bay Bridge Tunnel, VA', lat: 36.9667, lon: -76.1133 },
    'solomons-island-md':    { station_id: '8577330', label: 'Solomons Island, MD',    lat: 38.3172, lon: -76.4511 },
    'atlantic-city-nj':      { station_id: '8534720', label: 'Atlantic City, NJ', lat: 39.3554, lon: -74.4184 },
    'sandy-hook-nj':         { station_id: '8531680', label: 'Sandy Hook, NJ', lat: 40.4669, lon: -74.0094 },
    'montauk-ny':            { station_id: '8510560', label: 'Montauk, NY', lat: 41.0482, lon: -71.9597 },
  };

  // Targets are operational areas, not single fishing points.  The line is
  // what the captain sees; lookup_points are only sampling anchors for the
  // weather/observation adapters and are deliberately not exposed as the
  // target identity.
  // Legacy export name retained for adapter compatibility; entries are
  // extended from the authoritative regional fishing-grounds asset below.
  const CANYON_TARGETS = {
    baltimore_canyon_line: Object.freeze({
      id: 'baltimore-canyon-line',
      label: 'Baltimore Canyon',
      kind: 'corridor',
      geometry: Object.freeze({
        type: 'LineString',
        coordinates: Object.freeze([
          Object.freeze([-74.78, 38.08]),
          Object.freeze([-74.48, 38.18]),
          Object.freeze([-74.17, 38.30]),
        ]),
      }),
      lookup_points: Object.freeze([[-74.78, 38.08], [-74.17, 38.30]]),
      description: 'A broad operating corridor along the Baltimore Canyon system.',
    }),
    hudson_canyon: Object.freeze({ id:'hudson-canyon', label:'Hudson Canyon', kind:'corridor', lookup_points:Object.freeze([[-73.2,39.7],[-72.6,39.4]]), description:'Hudson Canyon offshore fishing grounds.' }),
    wilmington_canyon: Object.freeze({ id:'wilmington-canyon', label:'Wilmington Canyon', kind:'corridor', lookup_points:Object.freeze([[-73.8,38.4],[-73.2,38.1]]), description:'Wilmington Canyon offshore fishing grounds.' }),
    norfolk_canyon: Object.freeze({ id:'norfolk-canyon', label:'Norfolk Canyon', kind:'corridor', lookup_points:Object.freeze([[-74.8,37.2],[-74.2,36.9]]), description:'Norfolk Canyon offshore fishing grounds.' }),
    toms_canyon: Object.freeze({ id:'toms-canyon', label:'Toms Canyon', kind:'corridor', lookup_points:Object.freeze([[-73.8,39.4],[-73.2,39.2]]), description:'Toms Canyon offshore fishing grounds.' }),
    carteret_canyon: Object.freeze({ id:'carteret-canyon', label:'Carteret Canyon', kind:'corridor', lookup_points:Object.freeze([[-73.4,38.9],[-72.9,38.7]]), description:'Carteret Canyon offshore fishing grounds.' }),
    lindenkohl_canyon: Object.freeze({ id:'lindenkohl-canyon', label:'Lindenkohl Canyon', kind:'corridor', lookup_points:Object.freeze([[-73.0,38.5],[-72.6,38.3]]), description:'Lindenkohl Canyon offshore fishing grounds.' }),
    spencer_canyon: Object.freeze({ id:'spencer-canyon', label:'Spencer Canyon', kind:'corridor', lookup_points:Object.freeze([[-72.8,38.1],[-72.4,37.9]]), description:'Spencer Canyon offshore fishing grounds.' }),
    poor_mans_canyon: Object.freeze({ id:'poor-mans-canyon', label:"Poor Man's Canyon", kind:'corridor', lookup_points:Object.freeze([[-72.7,37.8],[-72.3,37.6]]), description:"Poor Man's Canyon offshore fishing grounds." }),
    hudson_shelf_edge: Object.freeze({ id:'hudson-shelf-edge', label:'Hudson Shelf Edge', kind:'corridor', lookup_points:Object.freeze([[-73.5,39.9],[-72.5,39.7]]), description:'Offshore shelf-edge grounds east of New Jersey.' }),
    delaware_offshore: Object.freeze({ id:'delaware-offshore', label:'Delaware Offshore Grounds', kind:'area', lookup_points:Object.freeze([[-74.7,38.0],[-74.0,37.7]]), description:'General offshore grounds east of Delaware.' }),
    new_jersey_reef: Object.freeze({ id:'new-jersey-reef', label:'New Jersey Offshore Reef', kind:'area', lookup_points:Object.freeze([[-74.2,39.2],[-73.7,38.9]]), description:'New Jersey offshore reef complex.' }),
    virginia_offshore: Object.freeze({ id:'virginia-offshore', label:'Virginia Offshore Grounds', kind:'area', lookup_points:Object.freeze([[-75.5,37.0],[-74.9,36.5]]), description:'General offshore grounds east of Virginia.' }),
    baltimore_trough: Object.freeze({ id:'baltimore-trough', label:'Baltimore Trough', kind:'area', lookup_points:Object.freeze([[-74.5,37.7],[-73.8,37.5]]), description:'Baltimore Trough offshore grounds.' }),
    sausages: Object.freeze({ id:'sausages', label:'Sausages', kind:'area', lookup_points:Object.freeze([[-74.0,37.4],[-73.4,37.2]]), description:'Sausages offshore fishing grounds.' }),
  };

  const GROUND_DATA_URL = '/dashboard/data/fishing-grounds.json';
  // Operational target list for usec_md. The source layer contains hundreds
  // of survey labels (buoys, access zones, and duplicate polygons); these are
  // the named offshore grounds exposed as trip targets. usec_south gets its
  // own catalog when that region is enabled.
  const CURATED_GROUND_NAMES = new Set([
    '17 Fathoms', '17 Fathoms Bank', 'Axel Carlson Reef', 'Barnegat Light Reef',
    'Manasquan Inlet Reef', 'Sandy Hook Ground', 'Sea Bright Ground',
    'Shrewsbury Rock', 'Klondike (Shark River)', 'Mussel Bed', 'Mussel Bank',
    'Oil Wreck', 'Romer Shoal', 'The Cigar', '21 Mile Hill', '3 Mile Hill',
    '26 Mile (Big) Hill or Lump', 'Barnegat, South End Ridge', 'Barnegat, North End Ridge',
    'Manasquan (Southeast) Ridge', 'Ambrose Ridge', 'Lightship Ridge',
    'Scotland Ridge', 'Lindenkohl Canyon', 'Spencer Canyon', 'Toms Canyon',
    'Carteret Canyon', 'Hudson Canyon', 'Baltimore Canyon', 'Wilmington Canyon',
    'Norfolk Canyon', "Poor Man's Canyon", 'Sausages', 'Miah Maull Shoal',
    'Chincoteague Shoal', 'Winter Quarter Shoal', 'Ocean City Shoal',
    'Offshore Southeast', 'Cartwright Area', 'Acid Water or Stain', 'Mako',
  ]);
  function groundId(name) {
    const slug = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `ground-${slug || 'unnamed'}`;
  }
  function html(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }
  function mergeGroundCatalog(payload) {
    const seen = new Set(Object.values(CANYON_TARGETS).map(t => String(t.label || '').trim().toLowerCase()));
    const usedIds = new Set(Object.keys(CANYON_TARGETS));
    let added = 0;
    for (const feature of (payload && payload.features) || []) {
      const name = String(feature && feature.name || '').trim();
      const point = feature && feature.point;
      const lon = Number(point && point[0]); const lat = Number(point && point[1]);
      if (!name || !Number.isFinite(lon) || !Number.isFinite(lat) || lon < -77 || lon > -71 || lat < 35 || lat > 41) continue;
      const key = name.toLowerCase(); if (seen.has(key)) continue;
      if (!CURATED_GROUND_NAMES.has(name)) continue;
      let id = groundId(name); let suffix = 2;
      while (usedIds.has(id)) id = `${groundId(name)}-${suffix++}`;
      CANYON_TARGETS[id] = Object.freeze({ id, label: name, kind: 'ground', lookup_points: Object.freeze([[lon, lat]]), description: `${name} offshore fishing ground${feature.source ? ` (${feature.source})` : ''}.`, source: feature.source || null });
      seen.add(key); usedIds.add(id); added++;
    }
    return added;
  }
  function loadGroundCatalog(onLoaded) {
    if (typeof fetch !== 'function') return;
    fetch(GROUND_DATA_URL, { cache: 'no-store' }).then(r => r.ok ? r.json() : null)
      .then(payload => { const added = mergeGroundCatalog(payload); if (added && onLoaded) onLoaded(); })
      .catch(() => {});
  }

  function todayIso() {
    const d = new Date();
    d.setHours(4, 0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  function plus10hIso() {
    const d = new Date();
    d.setHours(14, 0, 0, 0);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }

  function render(state, targets = CANYON_TARGETS) {
    const opts = Object.entries(INLETS).map(([k, v]) =>
      `<option value="${html(k)}"${k === state.inlet ? ' selected' : ''}>${html(v.label)}</option>`
    ).join('');
    return `
      <div class="ip-row">
        <section class="ip-card"><h3>Home inlet</h3><div class="ip-card-fields">
        <div class="ip-field">
          <label class="sr-only" for="ip-inlet">Home inlet</label>
          <select id="ip-inlet">${opts}</select>
        </div>
        <div class="ip-field">
          <label for="ip-departure">Departure (local)</label>
          <input id="ip-departure" type="datetime-local" value="${state.departure}" />
        </div>
        <div class="ip-field">
          <label for="ip-return">Return (local)</label>
        <input id="ip-return" type="datetime-local" value="${state.return}" />
        </div>
        </div></section>
        <section class="ip-card"><h3>Target fishing grounds</h3>
        <div class="ip-field">
          <label class="sr-only" for="ip-target">Offshore ground</label>
          <select id="ip-target">${Object.entries(targets).map(([k, v]) =>
            `<option value="${html(k)}"${k === state.target ? ' selected' : ''}>${html(v.label)}</option>`
          ).join('')}</select>
        </div>
        </section>
        <button class="ip-save" id="ip-save">Save trip</button>
        <button class="ip-cta" id="ip-cta">Update</button>
      </div>
    `;
  }

  function mount(host, opts = {}) {
    if (!host) throw new Error('inlet-picker mount: host is required');
    const state = {
      inlet: opts.initialInlet || Object.keys(INLETS)[0],
      departure: opts.initialDeparture || todayIso(),
      return: opts.initialReturn || plus10hIso(),
      target: opts.initialTargetId || 'baltimore_canyon_line',
    };
    function bind() {
      const inlet = host.querySelector('#ip-inlet');
      const dep = host.querySelector('#ip-departure');
      const ret = host.querySelector('#ip-return');
      const target = host.querySelector('#ip-target');
      const save = host.querySelector('#ip-save');
      const cta = host.querySelector('#ip-cta');
      inlet.addEventListener('change', () => { state.inlet = inlet.value; opts.onChange && opts.onChange(state.inlet, snapshot()); });
      dep.addEventListener('change', () => { state.departure = dep.value; opts.onChange && opts.onChange(state.inlet, snapshot()); });
      ret.addEventListener('change', () => { state.return = ret.value; opts.onChange && opts.onChange(state.inlet, snapshot()); });
      target.addEventListener('change', () => { state.target = target.value; opts.onChange && opts.onChange(state.inlet, snapshot()); });
      cta.addEventListener('click', () => opts.onChange && opts.onChange(state.inlet, snapshot()));
      save.addEventListener('click', () => { const tripPlan = snapshot(); tripPlan.name = `${INLETS[state.inlet].label} · ${state.departure.replace('T', ' ')}`; opts.onSave && opts.onSave(tripPlan); });
    }
    host.innerHTML = render(state); bind();

    function snapshot() {
      const depIso = dep.value ? new Date(dep.value).toISOString() : null;
      const retIso = ret.value ? new Date(ret.value).toISOString() : null;
      return {
        inlet_key: state.inlet,
        target_id: state.target,
        target_area: CANYON_TARGETS[state.target],
        departure_iso: depIso,
        return_iso: retIso,
      };
    }
    loadGroundCatalog(() => {
      const current = snapshot();
      state.inlet = current.inlet_key; state.target = current.target_id;
      host.innerHTML = render(state); bind();
    });

    return Object.freeze({
      getInlet: () => state.inlet,
      getSnapshot: snapshot,
      getInlets: () => INLETS,
    });
  }

  const api = Object.freeze({ mount, render, INLETS, CANYON_TARGETS });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FishEdgeTripPlannerUI = Object.assign(global.FishEdgeTripPlannerUI || {}, { InletPicker: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
