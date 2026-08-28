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


def forecast_keys(keys, model, run_date, hours):
    pattern = re.compile(rf"/{re.escape(model)}\.t\d{{2}}z\.{run_date}\.fields\.f(\d{{3}})\.nc$")
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


def model_grid(path, target_lats, target_lons):
    """Read one ROMS file and build nearest valid model-cell lookup."""
    with xr.open_dataset(path, decode_times=True) as ds:
        required = {"zeta", "lon_rho", "lat_rho", "mask_rho", "ocean_time"}
        missing = required.difference(ds.variables)
        if missing:
            raise RuntimeError(f"OFS file missing {sorted(missing)}")
        lon = np.asarray(ds["lon_rho"].values, dtype=float)
        lat = np.asarray(ds["lat_rho"].values, dtype=float)
        mask = np.asarray(ds["mask_rho"].values, dtype=float)
        zeta = np.asarray(ds["zeta"].isel(ocean_time=0).values, dtype=float)
        model_time = np.datetime64(ds["ocean_time"].values[0], "ms").astype("int64")

    # Model grids are curvilinear.  Nearest wet-cell lookup is stable and
    # avoids smoothing across coastline cells; the 0.25-degree output grid is
    # deliberately coarser than both regional OFS grids.
    lon2, lat2 = np.meshgrid(target_lons, target_lats)
    valid = np.isfinite(lon) & np.isfinite(lat) & (mask > 0.5)
    tree = cKDTree(np.column_stack((lon[valid], lat[valid])))
    distance, index = tree.query(np.column_stack((lon2.ravel(), lat2.ravel())))
    flat_zeta = zeta[valid]
    values = flat_zeta[index]
    # Do not project a model into a distant target cell.  0.45 degrees is
    # generous for the model grids but prevents false offshore coverage.
    values[distance > 0.45] = np.nan
    return model_time, values.reshape(lon2.shape)


def iso_hour(epoch_ms):
    return dt.datetime.fromtimestamp(epoch_ms / 1000, tz=dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")


def build_payload(date, hours):
    target_lats, target_lons = display_grid()
    runs = {}
    keysets = {}
    for model in MODELS:
        run_date, prefix, keys = find_run(model, date)
        runs[model] = {"date": run_date, "prefix": prefix}
        keysets[model] = forecast_keys(keys, model, run_date, hours)
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
                model_time, grid_m = model_grid(path, target_lats, target_lons)
            finally:
                os.unlink(path)
            per_model.append((model, model_time, grid_m))
        if not per_model:
            continue
        # MODELS is ordered by priority. Fill remaining cells from the next
        # model without blending two models across their common boundary.
        merged = np.full((len(target_lats), len(target_lons)), np.nan)
        sources = np.full(merged.shape, "", dtype=object)
        for model, model_time, grid_m in per_model:
            take = np.isnan(merged) & np.isfinite(grid_m)
            merged[take] = grid_m[take]
            sources[take] = model
        # model_grid returns epoch milliseconds already.
        time_ms = per_model[0][1]
        frames_by_time[time_ms] = {
            "time": iso_hour(time_ms),
            "water_level_m": np.where(np.isfinite(merged), merged, None).tolist(),
            "water_level_ft": np.where(np.isfinite(merged), merged * 3.280839895, None).tolist(),
            "tide_height_ft": np.where(np.isfinite(merged), merged * 3.280839895, None).tolist(),
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
        "units": {"water_level_m": "m", "water_level_ft": "ft", "tide_height_ft": "ft"},
        "datum": "model free-surface datum; do not label as MLLW without a datum transform",
        "variable": "zeta",
        "source": "NOAA NOS Operational Forecast Systems via noaa-ofs-pds",
        "source_url": "https://registry.opendata.aws/noaa-ofs/",
        "models": runs,
        "frames": frames,
        "quality": {
            "status": "pass" if frames else "fail",
            "grid_method": "nearest wet ROMS rho cell; no extrapolation beyond 0.45 degrees",
            "notes": "CBOFS/DBOFS zeta is total free-surface elevation and may include surge and river effects; it is not a pure astronomical tide field.",
        },
    }


def merge_forecast(path, tidal):
    """Merge OFS frames into an existing briefing artifact by UTC hour."""
    import json
    payload = json.loads(Path(path).read_text())
    by_time = {frame["time"].replace("Z", ""): frame for frame in tidal["frames"]}
    merged = 0
    for frame in payload.get("frames", []):
        key = frame.get("time", "")
        if key.endswith("Z"):
            key = key[:-1]
        ofs = by_time.get(key)
        if ofs:
            frame["tide_height_ft"] = ofs["tide_height_ft"]
            frame["water_level_ft"] = ofs["water_level_ft"]
            frame["tide_model_source"] = ofs["model_source"]
            frame["tide_model_coverage_cells"] = ofs["coverage_cells"]
            merged += 1
    payload.setdefault("quality", {})["ofs_tidal_source"] = tidal["source"]
    payload["ofs_tidal_forecast"] = {k: tidal[k] for k in ("schema_version", "generated_at", "models", "quality")}
    encoded = json.dumps(payload, allow_nan=False, separators=(",", ":"))
    tmp = Path(path).with_suffix(Path(path).suffix + ".tmp")
    tmp.write_text(encoded)
    tmp.replace(path)
    print(f"merged OFS zeta into {merged}/{len(payload.get('frames', []))} forecast frames: {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", default=dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d"), help="UTC OFS run date")
    parser.add_argument("--hours", type=int, default=24, help="forecast hours to ingest (default: 24)")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument(
        "--merge-forecast", type=Path, action="append", default=[],
        help="merge into a briefing forecast JSON; repeat for the dashboard copy",
    )
    args = parser.parse_args()
    if not 1 <= args.hours <= 72:
        parser.error("--hours must be between 1 and 72")
    payload = build_payload(args.date, args.hours)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    import json
    args.output.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
    print(f"wrote {args.output}: {len(payload['frames'])} frames")
    for forecast_path in args.merge_forecast:
        merge_forecast(forecast_path, payload)


if __name__ == "__main__":
    main()
