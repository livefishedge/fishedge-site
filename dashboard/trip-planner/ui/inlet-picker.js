/*!
 * Inlet picker — top-of-planner control for selecting home inlet,
 * default departure/return times, and a named canyon-area corridor.
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
  const CANYON_TARGETS = Object.freeze({
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
  });

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

  function render(state) {
    const opts = Object.entries(INLETS).map(([k, v]) =>
      `<option value="${k}"${k === state.inlet ? ' selected' : ''}>${v.label}</option>`
    ).join('');
    return `
      <div class="ip-row">
        <div class="ip-field">
          <label for="ip-inlet">Home inlet</label>
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
        <div class="ip-field">
          <label for="ip-target">Target area</label>
          <select id="ip-target">${Object.entries(CANYON_TARGETS).map(([k, v]) =>
            `<option value="${k}"${k === state.target ? ' selected' : ''}>${v.label}</option>`
          ).join('')}</select>
        </div>
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
    host.innerHTML = render(state);

    const inlet = host.querySelector('#ip-inlet');
    const dep = host.querySelector('#ip-departure');
    const ret = host.querySelector('#ip-return');
    const target = host.querySelector('#ip-target');
    const save = host.querySelector('#ip-save');
    const cta = host.querySelector('#ip-cta');

    inlet.addEventListener('change', () => {
      state.inlet = inlet.value;
      opts.onChange && opts.onChange(state.inlet, snapshot());
    });
    [dep, ret, target].forEach(el => el.addEventListener('change', () => opts.onChange && opts.onChange(state.inlet, snapshot())));

    cta.addEventListener('click', () => opts.onChange && opts.onChange(state.inlet, snapshot()));

    save.addEventListener('click', () => {
      const tripPlan = snapshot();
      tripPlan.name = `${INLETS[state.inlet].label} · ${state.departure.replace('T', ' ')}`;
      opts.onSave && opts.onSave(tripPlan);
    });

    function snapshot() {
      const depIso = dep.value ? new Date(dep.value).toISOString() : null;
      const retIso = ret.value ? new Date(ret.value).toISOString() : null;
      return {
        inlet_key: state.inlet,
        target_id: target.value,
        target_area: CANYON_TARGETS[target.value],
        departure_iso: depIso,
        return_iso: retIso,
      };
    }

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
