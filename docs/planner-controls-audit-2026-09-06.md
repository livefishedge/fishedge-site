# Planner controls audit — September 6, 2026

## Corrected baseline

Earlier legend/console checks did not establish visible scalar rendering or complete interaction behavior. This audit repairs confirmed viewer failures; it does not certify every forecast value or captain comprehension.

## Implemented

- Selected wave-height, swell-height and wind-wave-height fields paint the scalar canvas independent of motion. None clears the scalar; a single partition no longer paints its magnitude twice.
- One scalar state drives the selector and legacy inspector. All-null fields are unavailable, with explicit selected-time labels; valid zeros remain available.
- Sea exposes combined Wave motion and Wind controls alongside the color-map selector. Component motion remains available in Details.
- Grouped Details stays open during selection and fits mobile. Supporting overlays have removable controls, view choices are remembered during the session, and Reset restores view defaults.
- Tides starts with station markers/chart and no regional fill. Station curves now use the station's CO-OPS predictions, not regional model samples under a station label. Chart bounds include observations, upcoming events exclude past extrema, and readings show their age.
- Readouts refresh with forecast-time and unit changes; selected scalar values use strict local sampling without the station shoreline fallback. Missing/subpixel period states match the wave metric threshold.
- Coast-mask point queries use alpha; optional marine motion no longer masks atmospheric scalar fills. Missing native mesh metadata is guarded. The summary steepness calculation uses metres.
- Mobile freshness remains visible.
- Wave packets require a finite source-vector cell and a wet coastline-mask center; the high-resolution mask clips the crest itself. The coarse tide wet-cell grid is not used as a wave boundary because it suppresses valid narrow Chesapeake channels.
- Map clicks now leave a persistent location marker and show signed coordinates, ET forecast timestamp, separate significant/swell/chop rows, and a shrinkable readout.

## Chesapeake correction — September 7, 2026

- Replaced the fixed line used for subpixel chop with a phase-advancing directional hatch texture. A valid short-period cell now visibly evolves without claiming individually resolved crests.
- Made the unresolved-period branch null-safe. A missing period is not assigned a fabricated phase speed; it is rendered as a separate low-confidence texture state.
- Added per-crest coastline sampling and segment splitting. A destination-in canvas mask remains a final safety clip, but a crest is no longer drawn as one uninterrupted line across a narrow barrier.
- Regenerated `native_wave_mask.png` from wet native mesh triangles using normalized EPSG:3857 rows, matching the viewer's sampling projection. Added `wave_water_mask_contract` metadata to both forecast artifacts.
- Removed the coarse tidal wet-cell grid as a wave boundary; it was suppressing valid narrow-channel coverage. Wave eligibility uses finite partition data plus the projected native coastline mask.

## Performance and swell-source correction — September 7, 2026

- Moved expensive coastline sampling out of the normal offshore crest path. Non-coastal packets use direct canvas strokes; only packets near a mask edge use pixel-scale barrier sampling. This keeps the animation bounded instead of doing geographic mask lookups for every crest on every frame.
- Increased the native mask raster to 400 subdivisions per forecast cell and burned Natural Earth 10 m land polygons into it. The mask remains a display boundary, not a claim of shallow-water refraction or breaking physics.
- Added a source-backed component contract to both forecast artifacts. The swell partition is NOAA WaveWatch III via Open-Meteo Marine; that regional/coarse source does not resolve Chesapeake entrance shielding, bars, or shallow transformation. Swell is therefore excluded and labeled unsupported inside the named Chesapeake Bay polygon; wind-wave data remain available.
- Cached the exclusion-geometry lookup and avoid advancing/rendering excluded bay swell packets. This prevents the source-quality correction from adding frame-time lag.
- The planner deliberately does not reinterpret a coarse offshore swell value as a Chesapeake-local wave. A future bay wave product requires a bathymetry-aware nearshore model or observations.

The targeted browser suite now checks rendered wave motion, rather than only aggregate canvas movement. It still cannot certify every Chesapeake shoreline or a captain's visual interpretation; those require representative location/zoom review.

## Evidence

- `node tests/wave-phase.cjs`: inline syntax, phase ratios, units/partition samples, calm and missing cases.
- `node tests/planner-controls.cjs`: actual scalar pixels for three wave products, None clearing, Details persistence, per-view memory/reset, eight station prediction charts and observation fields, mobile bounds/freshness, no page errors.
- Same browser test can target dev with `PLANNER_URL`; Playwright/Chromium locations are configurable via environment variables.
- Payload audit: 168 frames, 38 grid fields, no entirely null frames for those fields. Generated timestamp: 2026-09-06T19:43:43Z. This is coverage evidence, not proof of freshness at a later viewing time or upstream model quality.

## Remaining validation boundaries

- Captain comprehension requires actual captain sessions; automated tests cannot establish the intended gut feeling.
- Native-resolution comparison, all-location numerical fidelity, scheduled refresh/publication reliability, and tide-native-product time alignment remain separate gates from these viewer regressions.
- No new source products, vessel simulation or production deployment are included.
