/*!
 * Tab switcher — shared navigation between /dashboard/ and /planner/.
 * Mounts into any container; renders two tabs (Dashboard / Planner) with
 * the active one highlighted, plus an account link and an optional meta
 * line (e.g. "4 AM · Ocean City").
 *
 * Peer-level navigation: neither tab is a sub-page of the other.
 */
(function attachTabSwitcher(global) {
  'use strict';

  const TABS = [
    { key: 'dashboard', label: 'Dashboard', icon: '🗺️', href: '/dashboard/',  blurb: 'Go where?' },
    { key: 'planner',   label: 'Planner',   icon: '⚓', href: '/planner/',    blurb: 'To go or not to go?' },
  ];

  const CSS = `
    #fishedge-tab-switcher .ts-tab.active { box-shadow: 0 0 0 1px var(--accent) inset; }
    #fishedge-tab-switcher .ts-tab .ts-blurb { font-size: 10px; color: var(--dim); margin-left: 4px; }
  `;

  function isActive(activeKey, key) { return activeKey === key; }

  function render(opts) {
    const meta = (opts && opts.meta) || null;
    const html = TABS.map(t =>
      `<a class="ts-tab${isActive(opts.active, t.key) ? ' active' : ''}" href="${t.href}" data-tab="${t.key}" aria-current="${isActive(opts.active, t.key) ? 'page' : 'false'}">
        <span class="ts-icon">${t.icon}</span>
        <span>${t.label}</span>
        <span class="ts-blurb">${t.blurb}</span>
      </a>`
    ).join('');
    const metaHtml = meta ? `<span class="ts-meta">${meta.label || ''}</span>` : '';
    return `
      <div class="ts-tabs">${html}</div>
      ${metaHtml}
      <a class="ts-account" href="/dashboard/account.html">Account</a>
    `;
  }

  function mount(host, opts) {
    if (!host) throw new Error('tab-switcher mount: host is required');
    if (!document.getElementById('__fishedge_tab_switcher_style__')) {
      const s = document.createElement('style');
      s.id = '__fishedge_tab_switcher_style__';
      s.textContent = CSS;
      document.head.appendChild(s);
    }
    host.innerHTML = render(opts);
    // Activate the current path if `opts.active` was not passed.
    if (!opts || !opts.active) {
      const path = (location.pathname || '').replace(/\/$/, '');
      const guess = path.startsWith('/planner') ? 'planner' : 'dashboard';
      host.querySelectorAll('.ts-tab').forEach(el => {
        if (el.getAttribute('data-tab') === guess) el.classList.add('active');
      });
    }
    return host;
  }

  const api = Object.freeze({ mount, render, TABS });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FishEdgeTripPlannerUI = Object.assign(global.FishEdgeTripPlannerUI || {}, { TabSwitcher: api });
})(typeof globalThis !== 'undefined' ? globalThis : this);