#!/usr/bin/env python3
"""Materialize NOAA STOFS HTP without harmonic reconstruction.

The regional HTP GRIB contains the native hourly tide-only forecast.  This
adapter only reprojects it to the viewer grid, masks NOAA fill/terrain values,
and derives co-range from the complete native horizon.  It never fits M2 and
never uses CO-OPS values to create the spatial field.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path

import numpy as np
from osgeo import gdal

BBOX = (-77.0, 36.0, -72.0, 40.0)

def sha256(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for b in iter(lambda: f.read(1024 * 1024), b""): h.update(b)
    return h.hexdigest()

def read_native(path):
    ds = gdal.Open(str(path))
    if ds is None: raise SystemExit(f"cannot open HTP GRIB: {path}")
    warped = gdal.Warp("", ds, format="MEM", dstSRS="EPSG:4326",
                       outputBounds=BBOX, width=21, height=17,
                       resampleAlg="bilinear", srcNodata=9999,
                       dstNodata=np.nan, multithread=True)
    if warped is None: raise SystemExit("failed to reproject HTP GRIB")
    values = np.stack([warped.GetRasterBand(i).ReadAsArray().astype(float)
                       for i in range(1, ds.RasterCount + 1)])
    values[(values < -9000) | (values >= 9990) | (np.abs(values) >= 5.0)] = np.nan
    # GDAL rows are north-to-south; FishEdge coordinates are south-to-north.
    return values[:, ::-1, :]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grib", required=True, type=Path)
    ap.add_argument("--forecast", required=True, type=Path)
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--run", required=True)
    ap.add_argument("--source-object", required=True)
    args = ap.parse_args()
    values = read_native(args.grib)
    payload = json.loads(args.forecast.read_text())
    if values.shape[0] < len(payload["frames"]):
        raise SystemExit("HTP horizon is shorter than viewer frames")
    valid = np.isfinite(values)
    if not valid.any(): raise SystemExit("HTP contains no finite wet-cell values")
    ranges = np.nanmax(values, axis=0) - np.nanmin(values, axis=0)
    lats = np.asarray(payload["lats"]); lons = np.asarray(payload["lons"])
    # Native output is on the same 21x17 target, but assert that contract.
    if values.shape[1:] != (len(lats), len(lons)):
        raise SystemExit(f"grid mismatch: HTP {values.shape[1:]} vs viewer {(len(lats),len(lons))}")
    for i, frame in enumerate(payload["frames"]):
        grid = values[i]
        frame["astronomical_tide_ft"] = np.where(np.isfinite(grid), grid, np.nan).tolist()
        frame["tide_range_ft"] = np.where(np.isfinite(ranges), ranges, np.nan).tolist()
        frame["tide_amplitude_ft"] = np.where(np.isfinite(ranges), ranges / 2, np.nan).tolist()
        frame["tide_phase_deg"] = [[None for _ in lons] for _ in lats]
    # JSON cannot carry NaN. Convert only masked cells to null.
    def clean(x): return [[None if not np.isfinite(v) else float(v) for v in row] for row in x]
    for frame in payload["frames"]:
        for key in ("astronomical_tide_ft", "tide_range_ft", "tide_amplitude_ft"):
            frame[key] = clean(frame[key])
    payload["tide_water_cells"] = np.isfinite(ranges).tolist()
    payload["tide_harmonic_source"] = {
        "provider": "NOAA", "model": "STOFS-2D Global HTP",
        "run": args.run, "source_object": args.source_object,
        "source_sha256": sha256(args.grib), "datum": "MSL-like",
        "constituents": ["native HTP (not decomposed)"],
        "prediction_field": "astronomical_tide_ft",
        "range_definition": "max-min over complete native HTP horizon",
        "method": "native HTP regional GRIB reprojection; no harmonic fit; no CO-OPS interpolation",
        "offshore_independent": True,
    }
    payload.setdefault("quality", {})["co_tidal_source"] = "NOAA STOFS native HTP; CO-OPS observations are validation only"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
    print(json.dumps({"frames": len(payload["frames"]), "wet_cells": int(np.isfinite(ranges).sum()),
                      "range_min_ft": float(np.nanmin(ranges)), "range_max_ft": float(np.nanmax(ranges)),
                      "sha256": sha256(args.grib), "output": str(args.output)}, indent=2))

if __name__ == "__main__": main()
