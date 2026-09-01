# USEC-MD regional tide model plan

FishEdge needs an independent tide-only field that remains accurate at CO-OPS
gauges and physically continuous offshore. CO-OPS predictions are validation
data, not the regional model.

## Design

The current USEC-MD source strategy is documented in
`docs/usec-md-got-vdatum-blend-plan.md`. NASA GOT is the offshore harmonic
base; an independently supplied coastal harmonic field is used in the bays,
estuaries, and nearshore zone; NOAA VDatum supplies vertical-reference
transforms only. VDatum is not treated as a tidal constituent atlas.

- Keep NOAA STOFS as an independent coastal/hydrodynamic candidate and
  benchmark source. For the current GOT/VDatum experiment, it may be the
  coastal harmonic source only when an explicit constituent export is present;
  an HTP time series is never silently relabeled as an atlas.
- Keep CBOFS/DBOFS `zeta` separate as total water level because it can include
  surge, river, and meteorological effects.
- Fit/synthesize constituents consistently and interpolate complex cosine/sine
  coefficients, never phase degrees.
- Apply explicit datum transforms. A global vertical shift is a hypothesis,
  not a general calibration.
- Use water connectivity and coast-aware distance decay for residual correction;
  never interpolate across land or disconnected estuaries.
- Validate with leave-one-station-out and time-held-out splits. Report bias,
  RMSE, MAE, high/low timing, amplitude, phase, and range errors.
- Promote only when held-out independent-model metrics do not regress. Preserve
  the current CO-OPS blend as a clearly labeled reference product.

## Data contract

`regional_tide_model` is the independent astronomical prediction;
`regional_tide_range` is synthesized from that exact field and epoch;
`coops_observed` is measurement-only validation; `ofs_total_water_level` is a
separate surge/weather-aware product. Every artifact carries provider, model,
run, hash, datum, units, UTC convention, constituents, and validation report.

## Gates

1. Provenance and required fields present.
2. Safe remapping with adequate wet-cell coverage.
3. Station/time overlap exists for validation.
4. Held-out phase, amplitude, range, and RMSE do not regress.
5. Popup, map, and co-range use the same promoted model artifact; observations
   remain separate and retain original timestamps.

## Execution

Run `scripts/build_regional_tide_pipeline.py` in shadow mode with a candidate
artifact and report path. Promotion is refused unless provenance and station
overlap gates pass. Existing STOFS/OFS scripts are source adapters. The dev
site receives the orchestration code and plan; the live reference field is not
replaced until an independent candidate passes validation.

### Multi-constituent calibration implementation

`scripts/calibrate_regional_tide.py` consumes a normalized independent harmonic
source containing `lats`, `lons`, and at least M2, S2, K1, and O1 amplitude/phase
grids. The existing STOFS and GOT adapters now emit that grid contract; FES and
TPXO exports can be supplied through the same contract without changing the
calibrator. For every held-out station it fits the observed time series on the
training half, computes complex cosine/sine residuals, applies distance-decayed
spatial corrections without phase-degree interpolation, synthesizes the second
half, and requires both leave-one-station-out and chronological time-held-out
passes. A failed gate writes no candidate output.

The native STOFS HTP regional GRIB is an operational tide-only time series, not
a constituent atlas. It remains a separate adapter/candidate and is not
pretended to satisfy the multi-constituent gate. FES/TPXO files must be
licensed/obtained outside the repository and their source hashes recorded in
the normalized artifact before ingestion.

### GOT/VDatum blend implementation

`scripts/build_got_vdatum_blend.py` creates a shadow normalized harmonic
artifact from a real NASA GOT source and an independent coastal harmonic
source. It blends shared constituents in Re/Im space, carries an explicit
VDatum MSL-to-MLLW offset and coastal-weight grid, and embeds SHA-256 hashes
for every input artifact. It refuses missing shared constituents, mismatched
grids, and implicit inference of tidal fields from VDatum.

The artifact is not promoted merely because it can be generated. It must pass
the untouched-source benchmark, leave-one-station-out validation,
separate-period validation, and separate offshore/estuary continuity gates.

### Acquisition and promotion command

`scripts/build_stofs_htp_native.py` is the bounded acquisition/normalization
boundary for STOFS. It consumes the downloaded regional HTP GRIB, records its
SHA-256, preserves every native hourly field, masks fill/terrain cells, and
derives range from the complete native horizon. It never fits M2 or uses
CO-OPS interpolation. The candidate remains shadow-only until current and
historical validation gates pass.
