# Planner data and sampling contract — proposed revision

2026-09-06. Design requirements, partially implemented in feature commit
`4c909d4a`. Remaining gaps are listed in the [direction and execution plan](planner-direction-and-execution-plan.md).

## Field identity

Each product/partition carries provider, actual model when verified, source run,
retrieval time, valid time with UTC offset, units, temporal statistic/interval,
native resolution, delivery grid/CRS, domain, mask and quality. Unknown model
identity remains unknown; provider branding is not model verification.

- Preserve explicit-unit grid v2 keys during migration. The old point/segment
  `captain-conditions-v1` is not interchangeable with grid v2: provide an adapter.
- Compute physics in dimensionally consistent SI quantities; convert at boundaries.
  Do not blindly rename a legacy metre field to `_ft`.
- Significant height is a sea-state statistic, not every crest's height. Store
  period statistic explicitly: mean, peak or other provider-defined statistic.
- Meteorological wave/wind FROM bearings convert once to travel TO; current
  bearings use their own verified convention. Circular means need ambiguity
  detection. Zero resultant direction is not zero wave height.
- UTC strings include `Z`/offset; generation time, model run and valid time differ.
  Seven days of frames do not prove that today's source is fresh.
- Visibility uses an explicit unit (`mi` means statute miles, not nmi). Precipitation
  total, rate and probability are separate semantics. Validate provider units.

## Sampling result

Shared logical result: location, selected valid time, field values, provenance,
interpolation method, contributing cells/weights, data state and display state.

Data states: valid, calm/zero, missing scalar, missing period, missing/ambiguous
direction, stale, land, outside coverage. Staleness can coexist with valid values.
Display states: resolved crests, representative short-chop texture, stationary
direction cue, scalar-only, or unavailable. Display decimation is not missing data.

- Exact nodes must not depend on zero-weight neighboring values. At interpolation
  locations, only supported wet-connected contributors are eligible; a documented
  partial-support rule must not fill an unsupported water body or cross land.
- Distinguish native cells, remapped delivery nodes, and display samples. More
  display marks may improve legibility but cannot improve forecast resolution.
- Color, animation and inspection use the same scalar/direction/time/validity
  semantics. Each train's full footprint must respect local validity and variation.
- Missing period may leave height and direction usable, but not fabricated motion.
  No blank region may silently stand for both known calm and unknown data.
- Inspection honors coast/domain, selected units and time; updates when these
  change. Include the source/valid time, and label interpolated values as such.

## Diagnostics and tide separation

- Deep-water steepness proxy: Hs_m / (1.56 T_s²), with actual period statistic named.
  Example: 3 ft and 6 s gives about 0.01628. This is not a vessel safety threshold.
- Current ride-harshness thresholds and capped-wind surface texture are heuristics.
  Expose their inputs/version and experimental status; do not call them measured
  sea surface or validated ride predictions.
- Astronomical tide, OFS total water level, observed station level, current velocity,
  range and chart-depth clearance are distinct products with independent metadata.
  Range must identify its field and epoch/window. No tide-height-to-current inference.
- GOT/VDatum acquisition proves acquisition only. VDatum transforms vertical
  references; it supplies neither tidal constituents nor verified inlet conditions.

## Producer and publication acceptance

Candidate → validate → atomic publication. Owners of weather/waves and independent
tides must not silently replace one another's fields or timestamps. Validate hashes,
grid axes/shapes, masks, horizon and provider units. Retain raw/provider fixtures
outside the web tree where appropriate. Last-good fallback remains explicitly stale.

Prove scheduler identity and at least a subsequent refresh before claiming reliable
fresh delivery. Recompute age in the consumer; static `quality.status=pass` describes
build-time checks only. Data freshness failure is separate from UI deployment success.

Acceptance tests must use independent expected values at nodes, off-node samples,
boundaries, wet/dry and missing corners, all forecast times, unit modes and browser
time zones. A self-consistent animation formula alone does not validate the producer.
