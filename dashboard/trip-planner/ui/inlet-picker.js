/*!
 * Inlet picker — top-of-planner control for selecting home inlet,
 * default departure/return times, and a target grounds lat/lon.
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
  };

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
          <label for="ip-target-lat">Target lat / lon</label>
          <div style="display:flex;gap:4px;">
            <input id="ip-target-lat" type="number" step="0.0001" placeholder="38.5" value="${state.target_lat}" style="flex:1;" />
            <input id="ip-target-lon" type="number" step="0.0001" placeholder="-74.5" value="${state.target_lon}" style="flex:1;" />
          </div>
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
      target_lat: opts.initialTarget ? opts.initialTarget[1] : 38.5,
      target_lon: opts.initialTarget ? opts.initialTarget[0] : -74.5,
    };
    host.innerHTML = render(state);

    const inlet = host.querySelector('#ip-inlet');
    const dep = host.querySelector('#ip-departure');
    const ret = host.querySelector('#ip-return');
    const lat = host.querySelector('#ip-target-lat');
    const lon = host.querySelector('#ip-target-lon');
    const save = host.querySelector('#ip-save');
    const cta = host.querySelector('#ip-cta');

    inlet.addEventListener('change', () => {
      state.inlet = inlet.value;
      // Snap target to the inlet + a small offset for "15 nm offshore" demo.
      const meta = INLETS[state.inlet];
      if (meta && (!lat.value || !lon.value)) {
        lat.value = (meta.lat - 0.20).toFixed(4);
        lon.value = (meta.lon + 0.30).toFixed(4);
      }
      opts.onChange && opts.onChange(state.inlet, snapshot());
    });
    [dep, ret, lat, lon].forEach(el => el.addEventListener('change', () => opts.onChange && opts.onChange(state.inlet, snapshot())));

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
        target_lonlat: [Number(lon.value), Number(lat.value)],
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

  const api = Object.freeze({ mount, render, INLETS });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FishEdgeTripPlannerUI = Object.assign(global.FishEdgeTripPlannerUI || {}, { InletPicker: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);