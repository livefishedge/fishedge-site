/* ============================================================================
 * FishEdge CTA Personalization — visitor-aware CTAs for fishedge.live.
 *
 * Loads after cta-personalization-config.js (which defines
 * window.FISHEDGE_CTA_CONFIG). Reads cookies, classifies the visitor,
 * and rewrites the [data-cta-surface] elements on the page to match
 * the configured segment matrix.
 *
 * Public API (window.FISHEDGE_CTA):
 *   - classifyVisitor(cookieString, options) → 'anonymous' | 'returning' | 'player' | 'captain'
 *   - render({ cookieString, doc, setCookie, host, query }) → void
 *
 * Shipped DARK (config.enabled = false). Roll out per-segment via
 * flag-only commits — see /home/gzheng/.openclaw/workspace-cto/plans/
 * 2026-08-02T10-45-51Z-visitor-aware-ctas.md.
 *
 * No production query overrides — ?cta_segment= is honored only on
 * localhost / 127.0.0.1 / *.pages.dev.
 * ========================================================================== */
'use strict';

(function () {
  const config = (typeof FISHEDGE_CTA_CONFIG !== 'undefined') ? FISHEDGE_CTA_CONFIG : null;
  if (!config) {
    console.warn('[FISHEDGE_CTA] no config provided; module disabled');
    return;
  }

  const docRef = (typeof document !== 'undefined') ? document : null;

  // Expose API + last document for tests
  const FISHEDGE_CTA = {
    classifyVisitor,
    render,
    __lastDocument: docRef,
  };

  // ----- Cookie parser: exact match per pair, no substring sniffing -----
  function parseCookies(str) {
    const out = {};
    if (!str) return out;
    const pairs = String(str).split(';');
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const idx = pair.indexOf('=');
      if (idx === -1) continue;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }

  // ----- QA override gating -----
  function isPreviewHost(host) {
    if (!host) return false;
    if (Array.isArray(config.previewHosts) && config.previewHosts.indexOf(host) !== -1) return true;
    if (Array.isArray(config.previewHostSuffixes)) {
      for (let i = 0; i < config.previewHostSuffixes.length; i++) {
        if (host.endsWith(config.previewHostSuffixes[i])) return true;
      }
    }
    return false;
  }

  function parseQuery(search) {
    const out = {};
    if (!search) return out;
    const qs = (search.charAt(0) === '?') ? search.slice(1) : search;
    if (!qs) return out;
    const pairs = qs.split('&');
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      const idx = pair.indexOf('=');
      if (idx === -1) {
        const k = decodeURIComponent(pair);
        if (k) out[k] = '';
      } else {
        const k = decodeURIComponent(pair.slice(0, idx));
        const v = decodeURIComponent(pair.slice(idx + 1));
        if (k) out[k] = v;
      }
    }
    return out;
  }

  // ----- Classifier: precedence = login > returning > anonymous -----
  function classifyVisitor(cookieString, options) {
    options = options || {};
    const cookies = parseCookies(cookieString || '');

    // QA override: preview hosts only. Production: silently ignored.
    if (options.host && options.query && Object.prototype.hasOwnProperty.call(options.query, 'cta_segment')) {
      if (isPreviewHost(options.host)) {
        const override = options.query.cta_segment;
        if (override === 'anonymous' || override === 'returning' ||
            override === 'player' || override === 'captain') {
          return override;
        }
      }
    }

    const login = cookies['fishedge_logged_in'] === '1';
    const tier = cookies['fishedge_tier'];
    const returning = cookies['fishedge_returning'] === '1';

    if (login) {
      if (tier === 'captain') return 'captain';
      return 'player'; // tier unset/invalid defaults to player
    }
    if (returning) return 'returning';
    return 'anonymous';
  }

  // ----- Allowlist check -----
  function isAllowedHref(href) {
    if (!href || typeof href !== 'string') return false;
    const allow = config.allowlistedHosts;
    if (!Array.isArray(allow)) return false;
    for (let i = 0; i < allow.length; i++) {
      if (allow[i].test(href)) return true;
    }
    return false;
  }

  function findSurface(doc, surface) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return null;
    const sel = '[data-cta-surface="' + surface.replace(/"/g, '\\"') + '"]';
    const list = doc.querySelectorAll(sel);
    return (list && list.length) ? list[0] : null;
  }

  function defaultSetCookie(name, value, attrs) {
    if (!docRef) return;
    attrs = attrs || {};
    let s = encodeURIComponent(name) + '=' + encodeURIComponent(value);
    if (attrs.maxAge != null) s += '; Max-Age=' + attrs.maxAge;
    if (attrs.path) s += '; Path=' + attrs.path;
    if (attrs.domain) s += '; Domain=' + attrs.domain;
    if (attrs.secure) s += '; Secure';
    if (attrs.sameSite) s += '; SameSite=' + attrs.sameSite;
    docRef.cookie = s;
  }

  function fireEvent(doc, type, detail) {
    if (!doc || typeof doc.dispatchEvent !== 'function') return;
    let ev;
    try {
      if (typeof CustomEvent !== 'undefined') {
        ev = new CustomEvent(type, { detail: detail });
      } else {
        // Older browsers
        ev = doc.createEvent('CustomEvent');
        ev.initCustomEvent(type, false, false, detail);
      }
      doc.dispatchEvent(ev);
    } catch (_) { /* no-op */ }
  }

  // ----- Renderer -----
  function render(opts) {
    opts = opts || {};
    const cookieString = (typeof opts.cookieString === 'string')
      ? opts.cookieString
      : (docRef ? docRef.cookie : '');
    const host = opts.host || (typeof location !== 'undefined' ? location.hostname : '');
    const query = opts.query || parseQuery(
      (typeof location !== 'undefined' ? (location.search || '') : '')
    );
    const setCookie = opts.setCookie || defaultSetCookie;
    const doc = opts.doc || docRef;

    if (!doc) return; // no DOM, nothing to do

    const segment = classifyVisitor(cookieString, { host, query });

    // Flag gate: dark by default; per-segment opt-in.
    if (!config.enabled) return;
    if (!Array.isArray(config.enabledSegments) || config.enabledSegments.indexOf(segment) === -1) {
      return;
    }

    const row = config.matrix && config.matrix[segment];
    if (!row || !row.surfaces) {
      console.warn('[FISHEDGE_CTA] no matrix row for segment', segment);
      return;
    }

    // Validate every href in the row against the allowlist.
    // If any href fails, leave the entire row untouched and warn once.
    const surfaces = row.surfaces;
    for (const surface in surfaces) {
      if (!Object.prototype.hasOwnProperty.call(surfaces, surface)) continue;
      const def = surfaces[surface];
      if (def && def.href != null && !isAllowedHref(def.href)) {
        console.warn('[FISHEDGE_CTA] disallowed href in config; leaving DOM untouched', {
          segment, surface, href: def.href,
        });
        return;
      }
    }

    // Apply each surface.
    const applied = [];
    for (const surface in surfaces) {
      if (!Object.prototype.hasOwnProperty.call(surfaces, surface)) continue;
      const def = surfaces[surface];
      if (!def) continue;
      const el = findSurface(doc, surface);
      if (!el) continue; // no matching element — that's fine, page just isn't using that surface yet

      // textContent only — never innerHTML.
      if (typeof def.label === 'string') el.textContent = def.label;
      if (typeof def.href === 'string') el.setAttribute('href', def.href);

      // QA/analytics attributes
      try { el.dataset.ctaSegment = segment; } catch (_) {}
      try { el.dataset.ctaSurface = surface; } catch (_) {}

      applied.push({ segment: segment, surface: surface, href: def.href || null });
    }

    // Stamp the segment on the root for CSS hooks.
    try {
      if (doc.documentElement) doc.documentElement.dataset.ctaSegment = segment;
      if (doc.body) doc.body.dataset.ctaSegment = segment;
    } catch (_) {}

    // Set the returning cookie if absent. We do NOT re-render after this
    // (the cookie is for the NEXT visit, not this one).
    const cookies = parseCookies(cookieString || '');
    if (!cookies['fishedge_returning']) {
      setCookie('fishedge_returning', '1', {
        maxAge: 15552000, // 180 days
        path: '/',
        domain: '.fishedge.live',
        secure: true,
        sameSite: 'Lax',
      });
    }

    // Fire one impression event per surface actually rendered.
    for (let i = 0; i < applied.length; i++) {
      fireEvent(doc, 'fishedge:cta-impression', applied[i]);
    }
  }

  // Expose
  if (typeof window !== 'undefined') {
    window.FISHEDGE_CTA = FISHEDGE_CTA;
  }

  // ----- Auto-init on DOM ready -----
  function autoInit() {
    render();
  }
  if (docRef) {
    if (docRef.readyState === 'loading') {
      docRef.addEventListener('DOMContentLoaded', autoInit);
    } else {
      // DOM already ready — defer to next tick so late-loading config scripts settle.
      setTimeout(autoInit, 0);
    }
  }
})();