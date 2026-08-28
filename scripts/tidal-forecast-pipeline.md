# FishEdge gridded tidal forecast pipeline

## Source and semantics

The regional layer comes from NOAA NOS Operational Forecast Systems in the
public `noaa-ofs-pds` S3 bucket. The pipeline currently mosaics:

- DBOFS (preferred where its wet grid covers a target cell)
- CBOFS (fills remaining Chesapeake / coastal cells)

Both are ROMS models and expose `zeta`, `lon_rho`, `lat_rho`, and `mask_rho`.
`zeta` is free-surface elevation, not a pure astronomical tide: it can include
surge, river, and meteorological effects. The artifact therefore labels the
source as total water level and preserves the legacy `tide_height_ft` field so
the current viewer can consume it.

Cells outside the wet model domains remain `null`; the pipeline never
extrapolates a regional model over open ocean. CO-OPS predictions remain the
authoritative station curves and provide the fallback point product.

## Run locally or in the scheduled job

From the repository root:

```bash
python3 scripts/fetch_wave_openmeteo.py
python3 scripts/fetch_ofs_tidal_forecast.py \
  --date "$(date -u +%Y%m%d)" --hours 24 \
  --merge-forecast data/usec_md/briefing/forecast.json \
  --merge-forecast dashboard/trip-planner/data/usec_md/briefing/forecast.json
python3 scripts/refresh_coops_tidal_grids.py --hours 72 \
  data/usec_md/briefing/forecast.json \
  dashboard/trip-planner/data/usec_md/briefing/forecast.json
```

The first command creates the base wave/weather/CO-OPS artifact. The second
command downloads only the requested hourly OFS field files, maps the
curvilinear grids to the existing 17 x 21 display grid, writes
`data/usec_md/briefing/tidal_forecast.json`, and merges matching UTC hours
into both viewer artifacts.

The third command extends the map layer with a 72-hour CO-OPS station-blend
estimate for forecast hours that have no OFS frame. It never overwrites an
OFS frame, and marks fallback frames with `coops_station_blend` and MLLW
metadata. This keeps the slider continuous while making the lower-confidence
fallback explicit.

Use `--hours 1` for a smoke test. A production job should use 24 hours and
refresh at least hourly. The S3 run resolver probes the requested date and
the prior three UTC dates, which handles delayed or missing model cycles.

## Viewer contract

Each OFS frame contains:

- `water_level_m` — model `zeta`, meters
- `water_level_ft` — model `zeta`, feet
- `tide_height_ft` — compatibility alias, feet; still model water level
- `model_source` — `dbofs`, `cbofs`, or both
- `coverage_cells` — count of non-null display cells

The UI should label this layer `OFS total water level` (and show the model
timestamp / datum metadata), not imply that it is a chart-datum tide height.
