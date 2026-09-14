/*!
 * My Trips sidebar — saved trips from localStorage, mounted as a sticky
 aside on desktop and a drawer on mobile (handled by CSS).
 *
 * Tapping a trip calls onLoad(trip) — the planner hydrates state from
 * the saved shape (inlet, target, departure, return).
 */
(function attachMyTripsSidebar(global) {
  'use strict';

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', hour12: true });
  }

  function render(opts) {
    const trips = (opts && opts.trips) || [];
    if (!trips.length) {
      return `
        <div class="mts-empty">
          No saved trips yet.<br/>
          <small>Set a trip above and tap "Save trip".</small>
          <div class="mts-trip mts-example" aria-label="Example trip (not saved)">
            <div class="mts-name">Example: Ocean City → Baltimore Canyon</div>
            <div class="mts-meta">Ocean City Inlet · Sep 20, 6:00 AM</div>
            <div class="mts-meta">42.8 nm planned route · planned · Score 78/100</div>
            <small>Example only — not saved to your account</small>
          </div>
        </div>`;
    }
    const items = trips.map(t => `
      <div class="mts-trip" data-trip-id="${t.id}" role="button" tabindex="0">
        <div class="mts-name">${escapeHtml(t.name || 'Untitled trip')}</div>
        <div class="mts-meta">
          ${escapeHtml(t.inlet_key || 'unknown')} ·
          ${t.departure_iso ? fmtDate(t.departure_iso) : 'no departure'}
        </div>
      </div>`).join('');
    return `
      <div class="mts-header">
        <h3>My Trips</h3>
        <span style="font-size:11px;color:var(--dim);">${trips.length}</span>
      </div>
      ${items}
    `;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }

  function mount(host, opts = {}) {
    if (!host) throw new Error('my-trips-sidebar mount: host is required');
    const paint = () => { host.innerHTML = render(opts); bind(opts); };
    paint();
    host.addEventListener('mts:refresh', paint);
    return host;

    function bind() {
      host.querySelectorAll('.mts-trip:not(.mts-example)').forEach(el => {
        const handler = () => opts.onLoad && opts.onLoad(opts.trips.find(t => t.id === el.getAttribute('data-trip-id')));
        el.addEventListener('click', handler);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
      });
    }
  }

  const api = Object.freeze({ render, mount });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FishEdgeTripPlannerUI = Object.assign(global.FishEdgeTripPlannerUI || {}, { MyTripsSidebar: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);
