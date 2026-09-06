# Planner visualization contract — intuitive sea conditions

2026-09-06. Current requirements. Commit `76bdcb0a` implements the four-view
information architecture and low-fatigue layer hierarchy. Commit `4c909d4a` implements the first
data-grounded cell sampling, clipping, texture and inspection subset; this file
is not a claim that all perceptual, native-resolution or captain-validation gates
are complete.
Read with the [data contract](planner-data-contract.md) and
[execution plan](planner-direction-and-execution-plan.md).

## North star

Give captains a data-grounded gut feeling of being out there operating. Within
seconds they should distinguish rolling swell from sharp chop, see wave travel
and crossing systems, recognize gusts/drift and changing conditions, and notice
when the data is unknown. Follow with precise values on demand.

The map expresses sea state, not a simulated vessel ride. Hull, loading, speed
and heading are required before predicting vessel response. Perceptual realism
does not mean 3D, cinematic effects or geographically literal wave crests at
regional zoom. A clean 2D schematic with consistent physics is the first target.

## Visual grammar

| Signal | Intended cue | Guardrail |
|---|---|---|
| Significant height | Consistent magnitude color/line-strength cue | Statistical height, not each crest; mark over-range values rather than hiding them at 5 ft |
| Swell | Coherent crest trains, distinct solid style | Longer tangential lines identify partition style, not wavelength |
| Wind waves | Shorter, less visually coherent chop marks, distinct style | Period/height still come from that partition, not an assumed default |
| Period | Coupled crest speed, normal spacing and passage cadence | Same scaling law across both partitions; identify approximation |
| Very short waves | Representative directional texture, visibly distinct from resolved crests | Never invent an individual-crest wavelength or hide a valid cell; readout must name the same display state |
| Crossing seas | Two distinct superposed travel directions | Do not vector-average separate partitions into one fictitious sea |
| Steepness | Increased perceived sharpness/choppiness | Use corrected units; proxy, not validated breaking/boat-risk model |
| Wind/gust | Subordinate persistent flow with distinguishable bursts | Forecast peak gust is not a prediction of the exact second/location of a burst |
| Current | Separate drift cue | Never confuse current advection, wave phase speed and wind; verify TO convention |
| Visibility | Restrained haze/contrast cue with numeric range | Preserve coast, labels and controls; weather is not a measured 3D fog field |
| Tide/inlet | Time-dependent level/range and independently sourced flow context | Neither clearance nor bar passability follows from tide alone |

## Motion and scale

- For deep-water linear gravity waves, c = gT/(2π), λ = cT; group speed is c/2.
  Displayed crests use phase speed, not group speed or height-as-speed.
- With common space factor S and time factor A: gap = Sλ; screen speed = SAc;
  passage interval = T/A. Do not independently clamp these three quantities and
  still label them physically consistent. Crest-normal spacing is wavelength;
  tangential crest length is not.
- Finite depth changes dispersion: ω² = gk tanh(kh). Do not apply this without
  trusted, aligned depth, or claim to model shoaling/refraction/current interaction.
  A provider forecast may already contain coastal effects; our schematic is not
  another calibrated coastal model.
- When gap is unresolvable, switch to a representative texture. Temporal activity
  may distinguish short/long periods without asserting individually resolved crests.
  Label the mode; do not substitute missing period with that mode.
- Screen glyph placement follows stable viewport-aware coverage, with bounded
  density and spatially coherent changes. Sampling density is a readability choice,
  not a second accidental encoding of wave height or native data resolution.
- Preserve phase through ordinary pans/zooms; cap work, not data coverage. Test
  forecast transitions without teleportation or misleading persistence.
- Height differences above the selected range need explicit over-range treatment;
  exact values remain accessible. Do not quietly rescale every frame and make
  worsening conditions look unchanged.

## Layer hierarchy and interaction

- One clearly named active scalar fill and its matching colorbar; no unexplained
  blend of unrelated magnitudes. Supporting contours/vectors remain subordinate.
- Four views answer four distinct captain questions: Sea Conditions, Weather &
  Visibility, Fishing Conditions, and Tides & Inlets. Each layer has one home.
  Safety, comfort and fuel are briefing questions, not competing layer bins.
  Each view exposes a small primary set; supporting layers stay behind Details
  and never all start checked.
- Only one scalar field owns the color map at a time. Its name and unit are
  visible in the colorbar; selecting a secondary scalar is an explicit action.
- Progressive disclosure is mandatory: immediate impression first, tap/readout
  values second, provenance and technical diagnostics under Details.
- Provide color-independent partition styles and reduced-motion/static equivalents.
  Keep mobile controls/readout usable without covering the operating area.
- Inspection shows what the user is seeing at the selected time, including units,
  source, actual period statistic, direction convention and display/quality state.
- Unknown, stale, calm and outside-domain are visibly distinguishable. A missing
  forecast cannot look reassuringly smooth. No universal GO/NO-GO score.

## Validation, not aesthetic assertion

Engineering checks: reference-sample agreement, numeric motion ratios, full
footprint/coast masking, data-gap handling, long/short periods, crossings, above-range
height, pan/zoom, time/unit changes and mobile/reduced-motion operation.

Perceptual checks: blind paired scenarios with captains, fixed camera/legend scale,
measured interpretation accuracy and time. Ask what the sea would feel like and
which way systems travel; do not teach the answer during the test. Include stale
and missing cases. Proposed pilot targets and device budgets are in the execution
plan. Record actual results and unresolved misunderstandings separately from FPS
and browser console health. Screenshots cannot prove motion or captain intuition.

## Source note

Workspace `Apple_weather_research.md` is design inspiration for weather/visibility,
visual hierarchy and operational modes. Its incomplete citations and model-source
claims require verification; they do not override provider contracts or physics.
