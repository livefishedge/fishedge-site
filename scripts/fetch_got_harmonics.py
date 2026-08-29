#!/usr/bin/env python3
"""Extract a compact FishEdge harmonic artifact from NASA GSFC GOT4.10.

GOT4.10 is a global harmonic atlas, unlike STOFS operational zeta forecasts.
The source files are HDF5 NetCDF and are intentionally kept out of the web
artifact; only the requested regional constituent fields are published.
"""

import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np
import xarray as xr

CONSTITUENTS = {"M2": 12.4206, "S2": 12.0, "K1": 23.9345, "O1": 25.8193}
BBOX = (-77.0, 36.0, -72.0, 40.0)
STEP = 0.25
CM_TO_FT = 0.032808399


def atlas_field(model_dir, name):
    path = Path(model_dir) / "grids_oceantide_netcdf" / f"{name.lower()}.nc"
    with xr.open_dataset(path, engine="h5netcdf") as source:
        # GOT longitudes are 0..360; preserve the atlas phase and interpolate
        # only onto the compact FishEdge display grid.
        source = source.assign_coords(lat=source["latitude"], lon=source["longitude"])
        lons = np.arange(BBOX[0], BBOX[2] + STEP / 2, STEP)
        lats = np.arange(BBOX[1], BBOX[3] + STEP / 2, STEP)
        lon360 = xr.DataArray((lons % 360.0), dims="lon")
        lat = xr.DataArray(lats, dims="lat")
        amp = source["amplitude"].interp(lon=lon360, lat=lat, method="linear").values
        phase = source["phase"].interp(lon=lon360, lat=lat, method="linear").values
    # GOT amplitudes are centimeters.  Values at/below the documented 0.05 cm
    # floor are land/no-data or an effectively zero amphidromic signal.
    valid = np.isfinite(amp) & (amp > 0.05)
    amp_ft = np.where(valid, amp * CM_TO_FT, np.nan)
    phase = np.where(valid, phase % 360.0, np.nan)
    return amp_ft, phase, valid


def make_fields(model_dir):
    result = {}
    common = None
    for name in CONSTITUENTS:
        amp, phase, valid = atlas_field(model_dir, name)
        common = valid if common is None else (common | valid)
        result[name] = {
            "amplitude_ft": [[None if not np.isfinite(v) else float(v) for v in row] for row in amp],
            "phase_deg": [[None if not np.isfinite(v) else float(v) for v in row] for row in phase],
        }
    # Co-lines need a complete M2 cell; this prevents interpolation across
    # atlas land/no-data boundaries while preserving the open ocean.
    m2 = np.asarray(result["M2"]["amplitude_ft"], dtype=float)
    points = np.isfinite(m2)
    result["wet_mask"] = (points[:-1, :-1] & points[1:, :-1] & points[:-1, 1:] & points[1:, 1:]).tolist()
    return result


def merge_forecast(path, fields):
    payload = json.loads(Path(path).read_text())
    # This artifact is intentionally atlas-only for the map tide layer. Keep
    # the separate CO-OPS station predictions, but remove legacy OFS total
    # water-level grids so consumers cannot silently fall back to them.
    for frame in payload["frames"]:
        frame.pop("tide_height_ft", None)
        frame.pop("tide_model_source", None)
        frame.pop("tide_model_datum", None)
    amp = fields["M2"]["amplitude_ft"]
    phase = fields["M2"]["phase_deg"]
    first = dt.datetime.strptime(payload["frames"][0]["time"].replace("Z", ""), "%Y-%m-%dT%H:%M")
    for frame in payload["frames"]:
        current = dt.datetime.strptime(frame["time"].replace("Z", ""), "%Y-%m-%dT%H:%M")
        hours = (current - first).total_seconds() / 3600.0
        frame["tide_amplitude_ft"] = amp
        frame["tide_phase_deg"] = [[None if value is None else float((value + 360.0 * hours / CONSTITUENTS["M2"]) % 360.0) for value in row] for row in phase]
    payload["tide_water_cells"] = fields["wet_mask"]
    payload.pop("ofs_tidal_forecast", None)
    payload.get("units", {}).pop("tide_height_ft", None)
    quality = payload.get("quality", {})
    quality.pop("ofs_tidal_source", None)
    quality.pop("coops_tidal_fallback", None)
    quality["co_tidal_source"] = "NASA GSFC GOT4.10c static harmonic atlas; no OFS water-level layer"
    payload["tide_harmonic_source"] = {
        "provider": "NASA GSFC Goddard Ocean Tide GOT4.10c",
        "model": "GOT4.10c",
        "constituents": list(CONSTITUENTS),
        "primary": "M2",
        "method": "regional bilinear extraction from global harmonic atlas",
        "amplitude_units": "ft (converted from atlas cm)",
    }
    Path(path).write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True, type=Path, help="GOT4.10c directory")
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--merge-forecast", nargs="*", default=[])
    args = ap.parse_args()
    fields = make_fields(args.model_dir)
    args.output.write_text(json.dumps({"source": "NASA GSFC GOT4.10c", "constituents": fields, "bbox": BBOX, "grid_step_deg": STEP, "wet_mask": fields["wet_mask"]}, allow_nan=False, separators=(",", ":")))
    for path in args.merge_forecast:
        merge_forecast(path, fields)
        print(f"merged GOT4.10c harmonic fields: {path}")


if __name__ == "__main__":
    main()
