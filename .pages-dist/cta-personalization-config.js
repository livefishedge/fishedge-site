/* ============================================================================
 * FishEdge CTA Personalization — production config.
 * Loaded BEFORE cta-personalization.js. Defines window.FISHEDGE_CTA_CONFIG.
 *
 * SHIPPED DARK (enabled = false, enabledSegments = []). Roll out per
 * segment via flag-only commits. See plans/2026-08-02T10-45-51Z-visitor-aware-ctas.md.
 * ========================================================================== */
'use strict';

window.FISHEDGE_CTA_CONFIG = {
  // Master switch. False = module is inert, control markup stays as-is.
  enabled: false,

  // Per-segment opt-in. Empty array = no segment is personalized.
  // Rollout order (per plan): player → captain → returning → anonymous.
  enabledSegments: [],

  // URL allowlist. Any href not matching one of these patterns causes
  // the renderer to leave the DOM untouched (defense in depth).
  allowlistedHosts: [
    /^https:\/\/app\.fishedge\.live\/dashboard\/(?:|account\.html|register\.html|login\.html)$/,
    /^\/about(?:#contact)?$/,
    /^\/blog$/,
  ],

  // QA-only hosts that honor ?cta_segment= overrides.
  // Production hosts (fishedge.live, www.fishedge.live) NEVER honor overrides.
  previewHosts: ['localhost', '127.0.0.1'],
  previewHostSuffixes: ['.pages.dev'],

  // Segment matrix. Every segment has every required surface.
  // Required surfaces: header-primary, header-account, hero-primary,
  //   hero-secondary, closing-kicker, closing-title, closing-body,
  //   closing-primary, footer-primary, footer-secondary.
  matrix: {
    anonymous: {
      surfaces: {
        'header-primary':       { label: 'Get Free Access',              href: 'https://app.fishedge.live/dashboard/register.html' },
        'header-account':       { label: 'Sign In',                      href: 'https://app.fishedge.live/dashboard/login.html' },
        'hero-primary':         { label: 'Get Free Access',              href: 'https://app.fishedge.live/dashboard/register.html' },
        'hero-secondary':       { label: 'See How It Works →',           href: '/about' },
        'closing-kicker':       { label: 'Free access · start with real ocean data' },
        'closing-title':        { label: 'Start finding productive boundaries.' },
        'closing-body':         { label: 'Create a free account to explore satellite temperature, color, and current data in one focused dashboard.' },
        'closing-primary':      { label: 'Get Free Access',              href: 'https://app.fishedge.live/dashboard/register.html' },
        'footer-primary':       { label: 'Get Free Access',              href: 'https://app.fishedge.live/dashboard/register.html' },
        'footer-secondary':     { label: 'How It Works',                 href: '/about' },
      },
    },
    returning: {
      surfaces: {
        'header-primary':       { label: 'Welcome Back — Sign In',       href: 'https://app.fishedge.live/dashboard/login.html' },
        'header-account':       { label: 'Create Account',               href: 'https://app.fishedge.live/dashboard/register.html' },
        'hero-primary':         { label: 'Sign In to Continue',          href: 'https://app.fishedge.live/dashboard/login.html' },
        'hero-secondary':       { label: 'Create an Account →',          href: 'https://app.fishedge.live/dashboard/register.html' },
        'closing-kicker':       { label: 'Welcome back · your next session starts here' },
        'closing-title':        { label: 'Pick up where you left off.' },
        'closing-body':         { label: 'Sign in to return to the dashboard, or create an account if you have not finished registration.' },
        'closing-primary':      { label: 'Welcome Back — Sign In',       href: 'https://app.fishedge.live/dashboard/login.html' },
        'footer-primary':       { label: 'Sign In',                      href: 'https://app.fishedge.live/dashboard/login.html' },
        'footer-secondary':     { label: 'Create Account',               href: 'https://app.fishedge.live/dashboard/register.html' },
      },
    },
    player: {
      surfaces: {
        'header-primary':       { label: 'Open Dashboard',               href: 'https://app.fishedge.live/dashboard/' },
        'header-account':       { label: 'Account',                      href: 'https://app.fishedge.live/dashboard/account.html' },
        'hero-primary':         { label: 'Open Dashboard',               href: 'https://app.fishedge.live/dashboard/' },
        'hero-secondary':       { label: 'Ask About Captain Access →',  href: '/about#contact' },
        'closing-kicker':       { label: 'Dashboard ready · latest data is waiting' },
        'closing-title':        { label: 'Open your fishing dashboard.' },
        'closing-body':         { label: 'Jump back into the latest imagery and briefing. Captain access is available by request while the pilot evolves.' },
        'closing-primary':      { label: 'Open Dashboard',               href: 'https://app.fishedge.live/dashboard/' },
        'footer-primary':       { label: 'Dashboard',                    href: 'https://app.fishedge.live/dashboard/' },
        'footer-secondary':     { label: 'Captain Access',               href: '/about#contact' },
      },
    },
    captain: {
      surfaces: {
        'header-primary':       { label: 'Open Captain’s Dashboard',    href: 'https://app.fishedge.live/dashboard/' },
        'header-account':       { label: 'Account & Regions',            href: 'https://app.fishedge.live/dashboard/account.html' },
        'hero-primary':         { label: 'Open Captain’s Dashboard',    href: 'https://app.fishedge.live/dashboard/' },
        'hero-secondary':       { label: 'Manage Account & Regions →',  href: 'https://app.fishedge.live/dashboard/account.html' },
        'closing-kicker':       { label: 'Captain access · dashboard and regions ready' },
        'closing-title':        { label: 'Open your Captain’s Dashboard.' },
        'closing-body':         { label: 'Continue to the latest imagery and briefing, or manage your account and regional access.' },
        'closing-primary':      { label: 'Open Captain’s Dashboard',    href: 'https://app.fishedge.live/dashboard/' },
        'footer-primary':       { label: 'Captain’s Dashboard',         href: 'https://app.fishedge.live/dashboard/' },
        'footer-secondary':     { label: 'Account & Regions',            href: 'https://app.fishedge.live/dashboard/account.html' },
      },
    },
  },
};