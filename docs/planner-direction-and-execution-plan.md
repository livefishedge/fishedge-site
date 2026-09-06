# Planner direction, corrected baseline, and execution plan

Reviewed: 2026-09-06. Baseline before execution: feature branch
`feat/briefing-raster-v2`, commit `d413e4b5`. P0 data/semantics work and the
first P1 renderer pass were subsequently executed in commit `4c909d4a` and
pushed to the feature preview only. Remaining gates below are still planned;
there has been no production merge or deployment.

## 1. Product goal and recommended direction

Build a trustworthy offshore trip-planning and briefing system whose data is
defensible and whose visualization gives captains an immediate, physically
intuitive sense of operating conditions at sea: a useful, accurate **gut feeling**.

The central question is: **If I go there at that time, what will the sea feel
like, and how might it change during the trip?**

- Support inlet → transit → fishing grounds → return, from day selection through
  dock verification and eventually underway reassessment.
- Organize the viewer around four non-overlapping questions: Sea Conditions,
  Weather & Visibility, Fishing Conditions, and Tides & Inlets. Safety,
  comfort and fuel remain briefing questions, not competing layer bins.
- Make swell versus chop, wave travel, crossing seas, gusts, drift, and changing
  conditions understandable before the user reads a detailed legend.
- The feeling must follow the data. Label observations, forecasts, astronomical
  predictions, and derived diagnostics separately; show unknown and stale states.
- Boat response depends on hull, loading, speed, and heading relative to waves.
  Until those inputs and a validated response model exist, describe sea state,
  not predicted boat motion, slamming, fuel consumption, or safe passage.
- Tide height alone provides neither current velocity nor navigable clearance.
  Clearance additionally needs bathymetry/datum, water level, draft, and margins.

**Recommendation:** finish one trustworthy sea-state experience before adding
more layer checkboxes. First establish data semantics and freshness; then shared
sampling; then coherent, uncluttered visualization; then captain comprehension
tests; then connect it to trip timing and routes.

## 2. What the disk actually establishes

This is a code/artifact/document review plus the local/dev verification recorded
below; it is not captain validation or a production release. Previous browser
smoke results remain historical evidence unless explicitly listed as current.

| Area | Evidence/status | What is not established |
|---|---|---|
| Planner UI | Six presets, layer strip/menu, forecast slider, units/colorbar, tide station UI, sun/moon context exist in `dashboard/trip-planner/briefing-viewer.html` | Full inlet-to-return operational workflow and captain usability acceptance |
| Forecast | Local `dashboard/trip-planner/data/usec_md/briefing/forecast.json`: 168 hourly frames, 21×17 delivery grid, generated `2026-09-05T00:23:33Z` | Freshness at use time; reliable scheduled publication; native model resolution |
| Marine/weather | Weather, wave partitions, forecast current/SST and diagnostic fields exist | Observational truth or authoritative inlet-current coverage |
| Waves | Shared deep-water phase formulas, delivery-cell-center seeds, source-cell polygon clipping, subpixel/missing-period texture, click readout | Full viewport-aware density policy, captain validation, coastal physics |
| Tests | `tests/wave-phase.cjs` checks syntax, deep-water ratios, uniform-grid direction/height/calm/missing period | Full-field agreement, pixel masking, all frames, mobile usability or perceptual fidelity |
| Tides | Fetchers, harmonic candidates, native rendering and acquisition records exist | One independently validated promoted model across every tide surface |
| Broader ocean products | Other dashboard work exists elsewhere | Integration of chlorophyll, altimetry, bathymetry or inlet-current products into this planner |

### Corrections to earlier completion claims

1. **The 09-06 fix plan was only partially implemented.** Do not repeat “agrees
   everywhere” or “all steps completed.” `ensureWavePackets()` now seeds delivery
   grid coordinates; it does not create viewport-aware samples. These are grid
   nodes, not documented cell centers, and the delivery grid is already remapped
   by the producer rather than native WW3 cells.
2. **Cell confinement is not proved.** `sourceCellPixelSize()` supplies a scalar
   size; `drawWavePackets()` uses pixel minimums and oriented lines, not an actual
   cell polygon or partition-validity clip. It samples only the anchor. Pixel
   minimums can exceed a small projected cell. More grid seeds do not solve this.
3. **Short-chop states disagree.** Renderer uses `gapPx < 3` (about T < 2.77 s)
   for a static line. Readout calls `!wavePhaseMetrics(period)` “texture,” which
   instead means missing/invalid period. Valid 2.5-second chop is not labeled as
   texture there; missing period is hidden by the renderer. Static marks do not
   convey short-wave cadence.
4. **Readout is incomplete.** It hard-codes feet, does not apply the coastline
   test, and is only updated on click (not selected-time changes). It lacks
   selected valid time, provider/run and quality state. Missing direction can
   prevent height/period readout even when those scalars are valid.
5. **Sampling rules differ.** Producer `interp_to_display()` can average finite
   neighbors across missing corners; viewer `bilinearPartitionVec()` requires
   all four corners, including zero-weight neighbors at exact nodes. Directions
   use different interpolation paths. This can create false continuity upstream
   and false holes downstream. Opposing directions must be marked ambiguous,
   not mistaken for calm seas.
6. **Derived-data semantics need repair.** Marine request uses imperial height;
   `add_derived_marine_fields()` computes H/(1.56 T²), whose denominator is metres.
   On that declared input contract steepness is too large by about 3.28084.
   Confirm response units in a retained fixture before fixing. The selected
   `wave_period` must not be called peak period without provider evidence.
   `ride_harshness_index` is a threshold heuristic, not measured vessel response;
   `surface_texture_index` is capped wind speed, not observed surface texture.
7. **Freshness and provenance are not solved.** The local artifact was over 40 h
   old at review versus its 12 h age limit, although `quality.status` says `pass`.
   Its timestamp strings lack `Z` despite the producer requesting UTC. Aggregate
   “WW3” metadata is not proof of each variable's backing model. Inspect actual
   scheduled producer, publication path and model metadata before claiming them.
8. **Height/style and units remain unfinished.** Wave line strength saturates
   at 5 ft. Memory calls visibility nmi; producer divides metres by 1609.344 and
   viewer uses `mi` (statute miles). Resolve documentation from actual units,
   not memory. Precipitation interval totals must not silently become rates.

## 3. Document ownership and precedence

This document is the current sequencing/status guide. The following technical
contracts define proposed acceptance criteria, not a claim of implementation:

- [Data and sampling contract](planner-data-contract.md).
- [Visualization contract](planner-visualization-contract.md).

Keep historical evidence immutable. A plan is not a completion report, an
acquisition record is not model validation, and a screenshot is not full-field
verification. New contradictions must be resolved explicitly, not blended.

| Existing document | Role and limits |
|---|---|
| Workspace `plans/2026-08-18T22-50-00Z-offshore-trip-planner-roadmap.md` | Long-term trip workflow and product boundary; subordinate to this sequencing revision |
| `dashboard/trip-planner/conditions-contract.md` | Historical point/segment v1 provenance contract; preserve consumers and add an explicit bridge to grid v2 |
| Workspace `plans/2026-08-27T15-30-00Z-weather-layers.md` | Historical weather ingestion/render plan; producer scheduling and completion still require evidence |
| Workspace `Apple_weather_research.md` | Important visualization inspiration omitted from the earlier summary; incomplete citations, not a verified source/model contract |
| `scripts/tidal-forecast-pipeline.md` | Historical OFS total-water-level path, not proof of current astronomical tide semantics |
| `docs/regional-tide-model-plan.md` and GOT/VDatum docs | Candidate architecture and source acquisition; keep independent validation/promotion gates |
| Workspace `docs/briefing-spec.md`, `data-contracts.md`, `system-architecture.md` | Earlier platform foundation; generic GO/NO-GO language does not override planner's decision-support boundary |
| `evidence/captain-briefing/dev-mvp/2026-08-18-evidence.md` | Historical prototype results, not current end-to-end validation |

## 4. Ordered instructions for the next authorized execution

### Step 1 — Freeze a reproducible baseline

- Record branch, commit, exact preview URL, asset hash, payload hash, source age,
  forecast valid times, enabled layers, viewport and zoom. Preserve unrelated files.
- Capture comparable desktop/mobile screenshots and short motion recordings:
  offshore, coast/inlet, sharp gradients, data gaps; wind/current off and on.
- Inventory every claimed feature as implemented, verified, partial or planned.
- **Exit:** reproducible fixtures and evidence manifest; no reliance on chat claims.

### Step 2 — Repair producer truth and freshness (P0)

- Inventory the real producer and scheduler read-only first; reconcile staging
  versus operational builders. Select one owner per product, not one monolithic
  fetcher that overwrites independent tide products.
- Record provider fields/units, model/run evidence, UTC valid times, native and
  delivery resolution. Validate response units before derived calculations.
- Correct dimensional steepness; distinguish mean/peak period. Audit visibility,
  precipitation accumulation intervals and current-direction convention.
- Recompute time-dependent freshness at consumption; distinguish successful build
  from fresh source. Never update timestamps to make old data appear current.
- Generate a candidate artifact only after authorization; publish atomically only
  after schema/coverage checks. Preserve last-good with an explicit stale state.
- **Exit:** 3 ft, 6 s steepness fixture ≈ 0.01628; UTC playback invariant across
  browser zones; stale data stays visibly stale; a producer failure cannot silently
  replace good data or reset independent tide provenance. Verify a subsequent
  scheduled refresh before declaring the pipeline reliable.

### Step 3 — Unify sampling, validity and inspection (P0)

- Introduce a narrow shared sampler/state classifier for readout and animation;
  align heat-map behavior to the same semantics without an unrelated rewrite.
- Honor coordinate arrays and exact-node weights. Validate regular grids or use
  bracket lookup for irregular axes. Reject out-of-domain sampling.
- Apply field-specific validity and coastline/connectivity rules before blending;
  distinguish scalar availability from direction ambiguity. Do not interpolate
  across disconnected waters or manufacture valid data from an invalid region.
- Readout updates on click, time, units and relevant layer changes; include provider,
  valid time and quality. Land and outside-domain samples report their real state.
- **Exit:** independent oracle comparisons at grid nodes, edges, interiors and
  gaps across all 168 frames; renderer and readout classify states identically.

### Step 4 — Replace the remaining wave-display shortcuts (P1)

- Use stable world-anchored, viewport-aware display sampling with bounded density.
  Repeated display samples may use the shared interpolator; explicitly retain the
  native-resolution limit. This is not additional model information.
- Shorten/split glyphs where local values change or become invalid; validate the
  full footprint and mask. Pixel-length heuristics alone are not confinement.
- Preserve phase continuously during pan/zoom and forecast changes where valid;
  reset visibly and intentionally when source data or direction becomes invalid.
- Use one shared spatial/time scaling rule for both partitions. Resolve short
  chop with the contract's representative texture and matching readout state.
- Keep long-period wave information visible even when no crest happens to pass
  through a small glyph window. Separate height cues from screen sampling density.
- **Exit:** measured motion/spacing/passage checks plus no unsupported footprint,
  correct missing-data behavior and stable coverage across zoom/device sizes.

### Step 5 — Make the sea-state experience intuitive (P1)

- Tune sea-state-only view first, then add wind and current one at a time. Reduce
  overlay competition; active scalar and its legend must always be obvious.
- Implement the visual grammar, over-range indication and reduced-motion version
  in the visualization contract. Keep four primary views, one visible scalar map,
  and supporting data behind Details. Never rely on checked-but-hidden layers.
- Compare low/high swell, short steep chop, crossing seas, gust changes and poor
  visibility at fixed location/time. Do not add 3D/hull simulation at this stage.
- **Exit:** independent screen + motion evidence; no color-only discrimination;
  numeric readout agrees with what a captain sees.

### Step 6 — Verify engineering and captain comprehension (release gate)

- Test units/time/direction/validity first, then mask and motion pixel tests,
  then desktop/mobile interactions. Rotation stays disabled unless all overlay
  projection paths pass; do not re-enable it for a test matrix checkbox.
- Include missing periods, zero height, opposing vectors, coast holes, >5 ft,
  short/long periods, forecast transitions, pan/zoom and reduced motion.
- Target ≥20 fps on the nominated mid-range mobile device, responsive controls
  within 200 ms, and no unbounded frame-time growth as zoom changes; record actual
  device/browser and results, not just target values.
- Prepare a blind comparison protocol for at least five captains: within 5 s,
  distinguish swell/chop, dominant travel, worsening sea state and unknown data.
  Proposed pilot gate: ≥80% correct classifications overall and no unknown-data
  scenario interpreted as confirmed calm/safe. Record misunderstandings and revise.
  Do not contact participants without Mike's authorization.
- **Exit:** evidence report identifies numerical, visual and user checks separately.
  If captain testing has not happened, label perceptual validation pending.

### Step 7 — Integrate the trip workflow (after sea-state gate)

- Connect selected inlet, outbound/return timing, route and forecast windows.
- Add heading/speed context only from entered values; keep vessel-response/fuel
  outputs experimental until independently validated. Separate fishing potential.
- Reconcile named observations against forecasts at the dock; retain decision-time
  data snapshots for later comparison. Underway/offline behavior is a later gate.
- Rank additional data integrations by demonstrated captain need and source
  coverage. Do not block the current sea-state experience on rebuilding tides,
  global bathymetry or obtaining every oceanographic layer.
- **Exit:** a captain can compare candidate trips and explain evidence, unknowns
  and return-window tradeoffs without a hidden composite safety score.

### Step 8 — Stage, inspect, then stop before production

- On later authorization, deploy only the verified feature-branch candidate to
  dev; inspect the exact served URL and exercise the interaction in an isolated
  browser. Keep code publication, live assets, fresh data and user acceptance as
  separate status items. Record production identity before/after.
- Hand off before/after motion, source snapshots, failures and rollback target.
- **Exit:** Mike reviews dev. Production merge remains a separate explicit approval.

## 5. Review completion rule

This revision is now an execution record as well as a sequencing guide. Executed
in `4c909d4a`: producer rerun, UTC frame normalization, tide-merge parser fix,
feet-to-metre steepness correction, cell-center sampling, source-cell clipping,
partial-validity sampling, unit-aware readout, readout refresh on time changes,
local regression/browser checks, feature-branch push, and exact dev-preview
verification. Not executed: captain comprehension study, native-resolution
comparison, scheduler reliability proof beyond this manual refresh, production
merge, or any broader unimplemented ocean-product integration.
