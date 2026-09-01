# USEC-MD regional tide model plan

FishEdge needs an independent tide-only field that remains accurate at CO-OPS
gauges and physically continuous offshore. CO-OPS predictions are validation
data, not the regional model.

## Design

- Ingest independent candidates (NOAA STOFS tide-only first; FES2022/TPXO10
  when source/licensing permits) as immutable, provenance-rich artifacts.
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

### Acquisition and promotion command

`scripts/acquire_harmonic_source.py` is the bounded acquisition boundary. It
accepts either a local licensed atlas directory or an explicit archive URL with
an expected SHA-256, extracts outside the web tree, and writes a manifest. It
rejects absent, unhashed, or unrecognized inputs. The normalized source is then
passed to `scripts/calibrate_regional_tide.py`, which benchmarks the untouched
atlas first and promotes only when every station has a leave-one-station-out
result, the chronological holdout exists, and calibrated RMSE does not regress
against the untouched baseline. No source file is currently bundled here, so no
candidate is promoted until an actual atlas archive is acquired.
