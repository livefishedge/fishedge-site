#!/usr/bin/env python3
"""Fetch NOAA OFS gridded total-water-level forecasts for FishEdge.

This is the authoritative regional tide/water-level path.  It consumes the
public NOAA OFS S3 bucket, extracts ROMS ``zeta`` from CBOFS and DBOFS, and
maps the curvilinear model grids onto the existing 17 x 21 FishEdge grid.

Important distinction: OFS ``zeta`` is free-surface elevation and can include
surge, river, and meteorological effects in addition to astronomical tide.
The output therefore calls it ``water_level`` in metadata while also writing
the legacy ``tide_height_ft`` field for the current viewer contract.

Examples:
  python scripts/fetch_ofs_tidal_forecast.py --date 20260828 --hours 24
  python scripts/fetch_ofs_tidal_forecast.py --date 20260828 --hours 24 \
      --merge-forecast data/usec_md/briefing/forecast.json

The pipeline intentionally does not interpolate beyond a model's valid wet
domain.  Offshore cells outside CBOFS/DBOFS coverage remain null until a
global ESTOFS source is added.
"""

import argparse
import datetime as dt
import os
import re
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import requests
import xarray as xr
from scipy.spatial import cKDTree


S3_BUCKET = "https://noaa-ofs-pds.s3.amazonaws.com"
REGION = "usec_md"
DISPLAY_BBOX = [-77.0, 36.0, -72.0, 40.0]
STEP_DEG = 0.25
OUTPUT = Path(__file__).resolve().parents[1] / "data" / REGION / "briefing" / "tidal_forecast.json"
MODELS = ("dbofs", "cbofs")  # prefer DBOFS in the overlap
NS_PER_HOUR = 3_600_000_000_000


def display_grid():
    lats = np.arange(DISPLAY_BBOX[1], DISPLAY_BBOX[3] + STEP_DEG / 2, STEP_DEG)
    lons = np.arange(DISPLAY_BBOX[0], DISPLAY_BBOX[2] + STEP_DEG / 2, STEP_DEG)
    return np.round(lats, 4).tolist(), np.round(lons, 4).tolist()


def s3_keys(prefix):
    """List NetCDF field files below an S3 prefix without AWS credentials."""
    response = requests.get(
        f"{S3_BUCKET}/",
        params={"list-type": "2", "prefix": f"{prefix}/", "max-keys": 1000},
        timeout=30,
    )
    response.raise_for_status()
    root = ET.fromstring(response.text)
    return [el.text for el in root.findall("{*}Contents/{*}Key") if el.text and el.text.endswith(".nc")]


def find_run(model, requested_date):
    """Return (YYYYMMDD, run_prefix, available field keys), probing recent dates."""
    requested = dt.datetime.strptime(requested_date, "%Y%m%d").date()
    for offset in range(0, 4):
        day = requested - dt.timedelta(days=offset)
        prefix = f"{model}.{day:%Y%m%d}"
        keys = s3_keys(prefix)
        if keys:
            return day.strftime("%Y%m%d"), prefix, sorted(keys)
    raise RuntimeError(f"no {model} OFS run found near {requested_date}")


def forecast_keys(keys, model, run_date, hours, cycle=None):
    cycle_pattern = f"{int(cycle):02d}" if cycle is not None else r"\d{2}"
    pattern = re.compile(rf"/{re.escape(model)}\.t{cycle_pattern}z\.{run_date}\.fields\.f(\d{{3}})\.nc$")
    found = {}
    for key in keys:
        match = pattern.search("/" + key)
        if match:
            number = int(match.group(1))
            if 1 <= number <= hours + 1:
                found[number] = key
    return found


def download_to_temp(key):
    """Stream one model file to a temporary path; caller removes it."""
    fd, path = tempfile.mkstemp(prefix="fishedge-ofs-", suffix=".nc")
    os.close(fd)
    response = requests.get(f"{S3_BUCKET}/{key}", stream=True, timeout=180)
    try:
        response.raise_for_status()
        with open(path, "wb") as handle:
            for chunk in response.iter_content(1024 * 1024):
                if chunk:
                    handle.write(chunk)
    except Exception:
        os.unlink(path)
        raise
    return path


def _map_curvilinear(values, lon, lat, mask, target_lats, target_lons):
    """Map a ROMS rho/u/v field to the FishEdge grid without land extrapolation."""
    lon2, lat2 = np.meshgrid(target_lons, target_lats)
    valid = np.isfinite(lon) & np.isfinite(lat) & (mask > 0.5)
    tree = cKDTree(np.column_stack((lon[valid], lat[valid])))
    distance, index = tree.query(np.column_stack((lon2.ravel(), lat2.ravel())))
    flat_values = values[valid]
    out = flat_values[index].astype(float)
    out[distance > 0.45] = np.nan
    return out.reshape(lon2.shape)


def model_grid(path, target_lats, target_lons):
    """Read zeta plus depth-averaged ROMS currents and map them to the display grid."""
    with xr.open_dataset(path, decode_times=True) as ds:
        required = {"zeta", "lon_rho", "lat_rho", "mask_rho", "ocean_time"}
        missing = required.difference(ds.variables)
        if missing:
            raise RuntimeError(f"OFS file missing {sorted(missing)}")
        lon = np.asarray(ds["lon_rho"].values, dtype=float)
        lat = np.asarray(ds["lat_rho"].values, dtype=float)
        mask = np.asarray(ds["mask_rho"].values, dtype=float)
        zeta = np.asarray(ds["zeta"].isel(ocean_time=0).values, dtype=float)
        # OFS ROMS files expose 3-D u/v on staggered grids. Depth averaging
        # gives the operational surface/depth-mean flow used by the viewer.
        u = v = None
        if {"u", "v", "lon_u", "lat_u", "lon_v", "lat_v", "mask_u", "mask_v"}.issubset(ds.variables):
            u = np.asarray(ds["u"].isel(ocean_time=0).mean(dim="s_rho", skipna=True).values, dtype=float)
            v = np.asarray(ds["v"].isel(ocean_time=0).mean(dim="s_rho", skipna=True).values, dtype=float)
            lon_u = np.asarray(ds["lon_u"].values, dtype=float)
            lat_u = np.asarray(ds["lat_u"].values, dtype=float)
            mask_u = np.asarray(ds["mask_u"].values, dtype=float)
            lon_v = np.asarray(ds["lon_v"].values, dtype=float)
            lat_v = np.asarray(ds["lat_v"].values, dtype=float)
            mask_v = np.asarray(ds["mask_v"].values, dtype=float)
        model_time = np.datetime64(ds["ocean_time"].values[0], "ms").astype("int64")

    # Model grids are curvilinear.  Nearest wet-cell lookup is stable and
    # avoids smoothing across coastline cells; the 0.25-degree output grid is
    # deliberately coarser than both regional OFS grids.
    zeta_grid = _map_curvilinear(zeta, lon, lat, mask, target_lats, target_lons)
    u_grid = _map_curvilinear(u, lon_u, lat_u, mask_u, target_lats, target_lons) if u is not None else None
    v_grid = _map_curvilinear(v, lon_v, lat_v, mask_v, target_lats, target_lons) if v is not None else None
    return model_time, zeta_grid, u_grid, v_grid


def iso_hour(epoch_ms):
    return dt.datetime.fromtimestamp(epoch_ms / 1000, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def build_payload(date, hours, cycle=None):
    target_lats, target_lons = display_grid()
    runs = {}
    keysets = {}
    for model in MODELS:
        run_date, prefix, keys = find_run(model, date)
        runs[model] = {"date": run_date, "prefix": prefix}
        keysets[model] = forecast_keys(keys, model, run_date, hours, cycle=cycle)
        if not keysets[model]:
            raise RuntimeError(f"{model} run {run_date} has no forecast field files")

    frames_by_time = {}
    for forecast_hour in range(1, hours + 2):
        per_model = []
        for model in MODELS:
            key = keysets[model].get(forecast_hour)
            if not key:
                continue
            path = download_to_temp(key)
            try:
                model_time, grid_m, u_grid, v_grid = model_grid(path, target_lats, target_lons)
            finally:
                os.unlink(path)
            per_model.append((model, model_time, grid_m, u_grid, v_grid))
        if not per_model:
            continue
        # MODELS is ordered by priority. Fill remaining cells from the next
        # model without blending two models across their common boundary.
        merged = np.full((len(target_lats), len(target_lons)), np.nan)
        sources = np.full(merged.shape, "", dtype=object)
        merged_u = np.full(merged.shape, np.nan)
        merged_v = np.full(merged.shape, np.nan)
        for model, model_time, grid_m, u_grid, v_grid in per_model:
            take = np.isnan(merged) & np.isfinite(grid_m)
            merged[take] = grid_m[take]
            sources[take] = model
            if u_grid is not None and v_grid is not None:
                current_take = np.isnan(merged_u) & np.isfinite(u_grid) & np.isfinite(v_grid)
                merged_u[current_take] = u_grid[current_take]
                merged_v[current_take] = v_grid[current_take]
        # model_grid returns epoch milliseconds already.
        time_ms = per_model[0][1]
        frames_by_time[time_ms] = {
            "time": iso_hour(time_ms),
            "water_level_m": np.where(np.isfinite(merged), merged, None).tolist(),
            # Captain-facing alias for the forecast sea-surface elevation;
            # this is OFS zeta (total free-surface height), not an SSH anomaly.
            "surface_height_m": np.where(np.isfinite(merged), merged, None).tolist(),
            "water_level_ft": np.where(np.isfinite(merged), merged * 3.280839895, None).tolist(),
            "tide_height_ft": np.where(np.isfinite(merged), merged * 3.280839895, None).tolist(),
            "current_u_ms": np.where(np.isfinite(merged_u), merged_u, None).tolist(),
            "current_v_ms": np.where(np.isfinite(merged_v), merged_v, None).tolist(),
            "current_speed_kn": np.where(np.isfinite(merged_u) & np.isfinite(merged_v), np.hypot(merged_u, merged_v) * 1.943844492, None).tolist(),
            "current_lats": target_lats,
            "current_lons": target_lons,
            "current_source": "NOAA NOS Operational Forecast Systems",
            "current_depth_contract": "depth-averaged ROMS u/v",
            "model_source": sorted(set(sources.ravel()) - {""}),
            "coverage_cells": int(np.isfinite(merged).sum()),
        }

    frames = [frames_by_time[key] for key in sorted(frames_by_time)]
    return {
        "schema_version": "fishedge-ofs-tidal-v1",
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "region": REGION,
        "display_bbox": DISPLAY_BBOX,
        "lats": target_lats,
        "lons": target_lons,
        "frame_interval_hours": 1,
        "units": {"water_level_m": "m", "surface_height_m": "m", "water_level_ft": "ft", "tide_height_ft": "ft", "current_u_ms": "m/s", "current_v_ms": "m/s", "current_speed_kn": "kn"},
        "datum": "model free-surface datum; do not label as MLLW without a datum transform",
        "variable": "zeta",
        "source": "NOAA NOS Operational Forecast Systems via noaa-ofs-pds",
        "source_url": "https://registry.opendata.aws/noaa-ofs/",
        "models": runs,
        "frames": frames,
        "quality": {
            "status": "pass" if frames else "fail",
            "grid_method": "nearest wet ROMS rho cell; no extrapolation beyond 0.45 degrees",
            "notes": "CBOFS/DBOFS zeta is total free-surface elevation and may include surge and river effects; depth-averaged ROMS u/v are included where available.",
        },
    }


def merge_forecast(path, tidal):
    """Merge OFS frames into an existing briefing artifact by UTC hour."""
    import json
    payload = json.loads(Path(path).read_text())
    by_time = {frame["time"].replace("Z", ""): frame for frame in tidal["frames"]}
    frame_sets = [(payload, payload.get("frames", []), None)]
    manifest = payload.get("frames_manifest") or {}
    if not frame_sets[0][1] and manifest.get("chunks"):
        base = Path(path).parent / str(manifest.get("dir", "frames"))
        frame_sets = []
        for name in manifest["chunks"]:
            chunk_path = base / str(name)
            chunk = json.loads(chunk_path.read_text())
            frame_sets.append((chunk, chunk.get("frames", []), chunk_path))
    merged = 0
    total = 0
    for container, frames, chunk_path in frame_sets:
      total += len(frames)
      for frame in frames:
        key = frame.get("time", "")
        if key.endswith("Z"):
            key = key[:-1]
        ofs = by_time.get(key)
        if ofs:
            frame["tide_height_ft"] = ofs["tide_height_ft"]
            frame["water_level_ft"] = ofs["water_level_ft"]
            frame["surface_height_m"] = ofs["surface_height_m"]
            frame["tide_model_source"] = ofs["model_source"]
            frame["tide_model_coverage_cells"] = ofs["coverage_cells"]
            for key in ("current_u_ms", "current_v_ms", "current_speed_kn", "current_lats", "current_lons", "current_source", "current_depth_contract"):
                frame[key] = ofs[key]
            merged += 1
      if chunk_path is not None:
          chunk_path.write_text(json.dumps(container, allow_nan=False, separators=(",", ":")))
    payload.setdefault("quality", {})["ofs_tidal_source"] = tidal["source"]
    payload["ofs_tidal_forecast"] = {k: tidal[k] for k in ("schema_version", "generated_at", "models", "quality")}
    encoded = json.dumps(payload, allow_nan=False, separators=(",", ":"))
    tmp = Path(path).with_suffix(Path(path).suffix + ".tmp")
    tmp.write_text(encoded)
    tmp.replace(path)
    print(f"merged OFS zeta into {merged}/{total} forecast frames: {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", default=dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d"), help="UTC OFS run date")
    parser.add_argument("--hours", type=int, default=24, help="forecast hours to ingest (default: 24)")
    parser.add_argument("--cycle", type=int, help="UTC model cycle to use, e.g. 12; default selects matching keys")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument(
        "--merge-forecast", type=Path, action="append", default=[],
        help="merge into a briefing forecast JSON; repeat for the dashboard copy",
    )
    args = parser.parse_args()
    if not 1 <= args.hours <= 72:
        parser.error("--hours must be between 1 and 72")
    if args.cycle is not None and not 0 <= args.cycle <= 23:
        parser.error("--cycle must be between 0 and 23")
    payload = build_payload(args.date, args.hours, cycle=args.cycle)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    import json
    args.output.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
    print(f"wrote {args.output}: {len(payload['frames'])} frames")
    for forecast_path in args.merge_forecast:
        merge_forecast(forecast_path, payload)


if __name__ == "__main__":
    main()
