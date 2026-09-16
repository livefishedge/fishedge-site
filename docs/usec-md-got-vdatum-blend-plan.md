# USEC-MD GOT + VDatum tide model plan

## Objective

Build an independent astronomical tide product for USEC-MD first, with NASA
GOT as the offshore harmonic base and an independent coastal harmonic source
given priority inside bays, estuaries, and nearshore waters. NOAA VDatum is
used to express the vertical-reference conversion; it is **not** treated as a
source of tidal constituents.

The production field must remain independent of CO-OPS station interpolation.
CO-OPS is used only for benchmark, held-out validation, and datum metadata.

## Source contract and acquisition

1. Acquire NASA GOT4.10c/GOT5.5 constituent files through an authoritative
   source. Normalize longitude to -180..180, use WGS84 coordinates, retain
   M2/S2/N2/K2/K1/O1/P1/Q1, and record the exact archive and SHA-256.
2. Acquire an independent coastal harmonic field. Acceptable examples are an
   explicitly published ADCIRC/STOFS constituent atlas or a reproducible
   long-period STOFS harmonic extraction. A short HTP forecast must not be
   mislabeled as a native constituent atlas.
3. Acquire the NOAA VDatum regional transformation grid and normalize its
   MSL-to-MLLW offset field, wet/coastal mask, coverage, units, CRS, and hash.
   VDatum does not contain the GOT/ADCIRC harmonic A/phase fields; any such
   coastal constituent field must be supplied separately.
4. Keep all source archives and manifests outside the web tree. The generated
   artifact must include source hashes, units, CRS, datum, constituent set, and
   coverage.

## Spatial model

- Zone 1: coastal/estuarine priority, `W=1` where the coastal harmonic source
  is valid and the VDatum coastal mask applies.
- Zone 2: 20–50 nautical-mile transition; use a continuous monotone weight
  from 1 to 0. The implementation accepts a precomputed weight grid so the
  shoreline and bathymetric mask are explicit rather than guessed from a
  rectangle.
- Zone 3: offshore, `W=0`; NASA GOT is the sole harmonic source.

For each shared constituent, blend `Re=A*cos(phi)` and `Im=A*sin(phi)`, then
reconstruct amplitude and phase with `hypot` and `atan2`. Never interpolate
phase degrees directly.

## Datum and prediction engine

Apply VDatum's station/grid vertical offset as a separate elevation-reference
term during output/validation. Do not use a datum offset to modify phase or
amplitude. `scripts/synthesize_got_vdatum_tide.py` evaluates the standard
summation over every shared constituent using explicit UTC astronomical
arguments and nodal factors. MSL is the default output; MLLW adds the VDatum
offset grid. Derive the displayed co-range from the same synthesized
prediction field and label whether it is a forecast-window range or a
long-term spring/neap range.

## Validation and promotion gates

1. Benchmark untouched GOT and untouched coastal sources separately before
   blending: per-station bias, RMSE, amplitude error, phase error, timing, and
   range error.
2. Fit any spatially smooth correction using training stations only; never
   interpolate a gauge height into the offshore field.
3. Run leave-one-station-out validation across every target station and a
   chronological separate-period validation using another STOFS/CO-OPS window.
4. Report offshore cells and estuarine cells separately. Check wet-cell
   coverage, continuity across the transition, maximum gradients, and missing
   data around Cape May/Delaware Bay and Chesapeake Bay.
5. Promote only if the blend improves or does not regress the untouched
   baselines on all required gates. Otherwise retain the current dev artifact.

The coastal gauge acceptance target is `<0.1 ft` only after the model is
evaluated at the station's actual point, in the correct datum and UTC window.
It is a gate, not an assumed result. Offshore validation requires an
independent altimetry matchup; missing altimetry data blocks that claim.

## Implementation

`scripts/build_got_vdatum_blend.py` consumes normalized GOT and coastal
harmonic artifacts plus an optional normalized VDatum offset/weight grid. It
refuses fewer than four shared constituents, grid mismatches, and implicit
VDatum constituent inference. The output is a shadow candidate; a separate
benchmark/promotion command must approve it before changing the viewer JSON.

`scripts/synthesize_got_vdatum_tide.py` consumes that blend and writes UTC
prediction frames plus the max-minus-min range from the same frames. It does
not use station values to fill cells.

The current dev site is not changed until real GOT, coastal harmonic, and
VDatum assets are acquired and the validation report passes.
