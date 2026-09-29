# Display hierarchy execution report — 2026-09-29

## Completed

1. Independent fields added: `geographic_class`, `display_tier`, `default_visible`, source provenance, and classification reason.
2. Catalog audit completed without removing source records or geometry.
3. Reviewed default inventory produced: 27 key offshore grounds.
4. Rendering pipeline changed so filtering happens before family representatives are chosen; filtered children cannot reappear through grouping.
5. Mixed provenance is eligible for either Official or Unofficial evidence filters; official evidence is not discarded merely because a record also has a reference source.
6. Regression suite: 13/13 passing. Static catalog checks: default inventory count, negative examples, source lineage, and duplicate aliases.
7. Dev preview branch updated through commit `8a055ea0d`.

## Browser limitation

An isolated Chromium session reaches the dev dashboard but is redirected to `/dashboard/login`. Without an authenticated browser session, map screenshots and click-level map verification cannot be honestly completed. The deployed catalog and dashboard controls can be checked unauthenticated, but the actual OpenLayers render requires Mike's authenticated session.

## Review inventory

See `reports/default-offshore-inventory-20260929.md` for the exact 27 default entries and negative controls.
