# Structure deduplication correction — 2026-09-29 UTC

## Verified local result

- Immutable source catalog: 851 records; unchanged by this correction.
- Display entries: 759 → 754.
- Screenshot pairs collapsed: Barnegat Inlet Buoy / BI; Barnegat Ridge South / Barnegat, South End Ridge; Barnrgat Ridge North / Barnegat, North End Ridge; Rock Pile / Rock Piles.
- Additional catalog-wide scan finding corrected: HA Bouy / HA Buoy.
- North ridge label corrected to Barnegat Ridge North; original spelling remains an alias and the stable ID is retained.
- Directional “end” wording and reordered phonetic tokens are handled by the resolver; buoy spelling correction preserves the rest of the name.
- BI and Rock Pile display decisions are scoped to the specific source coordinates from Mike's screenshot review. Rock Pile is a display grouping, not a claim that the disjoint source coordinates have been reconciled.
- Every source ID and polygon part survives. Display anchors are real source points, not invented midpoints.
- Importer now applies display grouping and writes both the full and points catalogs; browser script and data URLs have cache-version updates.

## Checks

- `node --test tests/fishing-ground-identity.mjs`: 9/9 pass.
- Syntax checks: importer and map client pass.
- `git diff --check`: pass.
- Existing `tests/chartbook-ui-contract.cjs` fails on LogBook Edit action text. The expected text is also absent in the unchanged HEAD dashboard; unrelated to this change.
- Existing whole-catalog candidate audit and review ledger regenerated. These are candidate lists, not a certification that every semantic duplicate has been eliminated. Remaining unresolved candidates need source-level decisions; they are not auto-merged.
- Browser check: managed browser is not running. No live visual verification has been performed.
- No push or deployment performed. Production remains unchanged, consistent with the standing dev-first / explicit production approval instruction.

## Delivery scope

This change fixes the five verified pairs and the implicated naming rules. It does not claim the entire catalog is duplicate-free. Production rollout and live-map verification remain outstanding.
