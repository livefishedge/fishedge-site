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
from shapely.geometry import Point
from shapely.prepared import prep
import cartopy.io.shapereader as shapereader

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


def ocean_grid_mask(lats, lons):
    """Reject atlas cells whose display-grid points fall on geographic land."""
    land_path = shapereader.natural_earth(resolution="10m", category="physical", name="land")
    land = [prep(record.geometry) for record in shapereader.Reader(land_path).records()]
    return np.array([[not any(shape.contains(Point(lon, lat)) for shape in land)
                      for lon in lons] for lat in lats], dtype=bool)


def ocean_cell_mask(lats, lons):
    """Keep cells whose centers are ocean; retain coastal coverage."""
    land_path = shapereader.natural_earth(resolution="10m", category="physical", name="land")
    land = [prep(record.geometry) for record in shapereader.Reader(land_path).records()]
    def ocean(lon, lat):
        return not any(shape.contains(Point(lon, lat)) for shape in land)
    mask = np.array([[ocean((lons[xi] + lons[xi + 1]) / 2,
                            (lats[yi] + lats[yi + 1]) / 2)
                      for xi in range(len(lons) - 1)]
                     for yi in range(len(lats) - 1)], dtype=bool)
    # At this compact resolution, favor retaining nearshore ocean cells over
    # a perfectly conservative shoreline. This one-cell halo is documented
    # and keeps coastal tidal contours continuous.
    expanded = mask.copy()
    for yi in range(mask.shape[0]):
        for xi in range(mask.shape[1]):
            if any(mask[yj, xj]
                   for yj in range(max(0, yi - 1), min(mask.shape[0], yi + 2))
                   for xj in range(max(0, xi - 1), min(mask.shape[1], xi + 2))):
                expanded[yi, xi] = True
    return expanded


def fill_ocean_gaps(values, valid, ocean):
    """Nearest-neighbor fill only for ocean points missing in the atlas grid."""
    out = values.copy()
    source = np.argwhere(valid)
    for yi, xi in np.argwhere(ocean & ~valid):
        if not len(source):
            continue
        nearest = source[np.argmin((source[:, 0] - yi) ** 2 + (source[:, 1] - xi) ** 2)]
        out[yi, xi] = values[nearest[0], nearest[1]]
    return out


def make_fields(model_dir):
    result = {}
    common = None
    lons = np.arange(BBOX[0], BBOX[2] + STEP / 2, STEP)
    lats = np.arange(BBOX[1], BBOX[3] + STEP / 2, STEP)
    ocean = ocean_grid_mask(lats, lons)
    ocean_cells = ocean_cell_mask(lats, lons)
    for name in CONSTITUENTS:
        amp, phase, valid = atlas_field(model_dir, name)
        valid &= ocean
        amp = np.where(valid, amp, np.nan)
        phase = np.where(valid, phase, np.nan)
        amp = fill_ocean_gaps(amp, valid, ocean)
        phase = fill_ocean_gaps(phase, valid, ocean)
        valid = ocean.copy()
        common = valid if common is None else (common | valid)
        result[name] = {
            "amplitude_ft": [[None if not np.isfinite(v) else float(v) for v in row] for row in amp],
            "phase_deg": [[None if not np.isfinite(v) else float(v) for v in row] for row in phase],
        }
    # Co-lines need a complete M2 cell; this prevents interpolation across
    # atlas land/no-data boundaries while preserving the open ocean.
    m2 = np.asarray(result["M2"]["amplitude_ft"], dtype=float)
    points = np.isfinite(m2)
    result["wet_mask"] = ((points[:-1, :-1] & points[1:, :-1] & points[:-1, 1:] & points[1:, 1:]) & ocean_cells).tolist()
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
        # Astronomical tide prediction: sum the four atlas constituents at
        # the selected hour. This is a predictable tide height relative to
        # the atlas mean, not an OFS total-water-level/surge product.
        tide = []
        for yi in range(len(amp)):
            row = []
            for xi in range(len(amp[yi])):
                value = 0.0
                usable = False
                for name, period in CONSTITUENTS.items():
                    a = fields[name]["amplitude_ft"][yi][xi]
                    p = fields[name]["phase_deg"][yi][xi]
                    if a is None or p is None:
                        continue
                    value += float(a) * np.cos(np.deg2rad(float(p) + 360.0 * hours / period))
                    usable = True
                row.append(float(value) if usable else None)
            tide.append(row)
        frame["astronomical_tide_ft"] = tide
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
    args.output.write_text(json.dumps({"source": "NASA GSFC GOT4.10c", "provider": "NASA GSFC", "model": "GOT4.10c", "constituents": fields, "lats": lats.tolist(), "lons": lons.tolist(), "bbox": BBOX, "grid_step_deg": STEP, "wet_mask": fields["wet_mask"]}, allow_nan=False, separators=(",", ":")))
    for path in args.merge_forecast:
        merge_forecast(path, fields)
        print(f"merged GOT4.10c harmonic fields: {path}")


if __name__ == "__main__":
    main()
