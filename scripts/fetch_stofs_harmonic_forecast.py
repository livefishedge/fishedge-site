#!/usr/bin/env python3
"""Fetch a regional NOAA STOFS HTP field lazily and build co-tidal data.

STOFS HTP is the astronomical-tide-only product.  This job prefers the
regional Eastern-CONUS GRIB2 object, which can be window-read through GDAL's
``/vsicurl/`` driver, so a multi-gigabyte global unstructured NetCDF file is
never downloaded.  It fits the M2 constituent on the regional grid and merges
the resulting amplitude/phase fields into the briefing artifact.

The job fails closed when the regional HTP object is absent.  It must not
fall back to CO-OPS station interpolation for co-tidal/co-range fields.
"""

import argparse
import datetime as dt
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import requests
from osgeo import gdal

S3 = "https://noaa-gestofs-pds.s3.amazonaws.com"
REGION = "usec_md"
BBOX = [-77.0, 36.0, -72.0, 40.0]
STEP = 0.25
M2_HOURS = 12.4206


def list_keys(prefix):
    r = requests.get(f"{S3}/", params={"list-type": "2", "prefix": prefix, "max-keys": 1000}, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    return [e.text for e in root.findall("{*}Contents/{*}Key") if e.text]


def find_regional_htp(date, cycle="00"):
    """Find the published regional HTP GRIB2 object for a run."""
    day = dt.datetime.strptime(date, "%Y%m%d")
    for offset in range(0, 3):
        run_day = (day - dt.timedelta(days=offset)).strftime("%Y%m%d")
        # NOAA publishes the pre-gridded HTP products at the date root. The
        # cycle/rerun tree contains the native tide NetCDF files instead.
        for base in (f"stofs_2d_glo.{run_day}/", f"stofs_2d_glo.{run_day}/{cycle}/", f"stofs_2d_glo.{run_day}/{cycle}/rerun/"):
            keys = list_keys(base)
            matches = [k for k in keys if re.search(r"conus\.east.*htp.*\.grib2$", k, re.I)]
            if matches:
                return run_day, sorted(matches)[0]
    raise RuntimeError("NOAA STOFS regional Eastern-CONUS HTP GRIB2 was not published for the requested runs")


def read_window(key, local_file=None):
    """Read/reproject the USEC-MD window from the regional GRIB2 object.

    The CONUS HTP GRIB is Lambert/projected (metres), not a lon/lat raster.
    Treating its geotransform as degrees silently selected the wrong pixels
    and produced a nearly constant, physically impossible tide field.
    """
    path = str(local_file) if local_file else f"/vsicurl/{S3}/{key}"
    ds = gdal.Open(path)
    if ds is None:
        raise RuntimeError(f"GDAL could not open regional HTP object: {key}")
    bands = min(ds.RasterCount, 181)
    warped = gdal.Warp(
        "", ds, format="MEM", dstSRS="EPSG:4326", outputBounds=BBOX,
        width=21, height=17, resampleAlg="bilinear", srcNodata=9999,
        dstNodata=np.nan, multithread=True,
    )
    if warped is None:
        raise RuntimeError("GDAL could not reproject regional HTP window")
    values = np.stack([warped.GetRasterBand(i).ReadAsArray().astype(float) for i in range(1, bands + 1)])
    # NOAA GRIB uses +9999 as the missing-value sentinel for land/masked
    # cells (not the negative fill value used by some NetCDF products).
    values[(values < -9000) | (values >= 9990)] = np.nan
    # HTP is a tide-only sea-surface field.  The regional GRIB also carries
    # positive land elevations that are not marked as nodata; exclude them
    # before fitting so terrain cannot become a tidal amplitude.
    # USEC-MD astronomical sea-surface elevations are well inside +/-5 m;
    # lower bounds still admit coastal terrain pixels from the GRIB warp.
    values[np.abs(values) >= 5.0] = np.nan
    lons = np.linspace(BBOX[0], BBOX[2], 21).tolist()
    lats = np.linspace(BBOX[3], BBOX[1], 17).tolist()
    return values, lats, lons


def fit_m2(values, hours):
    """Fit M2 amplitude and high-water phase independently at each pixel."""
    omega = 2 * np.pi / M2_HOURS
    t = np.asarray(hours, dtype=float)
    design = np.column_stack((np.ones(len(t)), np.cos(omega * t), np.sin(omega * t)))
    ny, nx = values.shape[1:]
    amp = np.full((ny, nx), np.nan)
    high_phase = np.full((ny, nx), np.nan)
    for yi in range(ny):
        for xi in range(nx):
            v = values[:, yi, xi]
            valid = np.isfinite(v)
            if valid.sum() < 12:
                continue
            coeff, *_ = np.linalg.lstsq(design[valid], v[valid], rcond=None)
            amp[yi, xi] = np.hypot(coeff[1], coeff[2])
            high_phase[yi, xi] = np.rad2deg(np.arctan2(coeff[2], coeff[1])) % 360.0
    return amp, high_phase


def merge(path, amp, phase, source, run_date, lats, lons, datum_shift_ft=0.0):
    payload = json.loads(Path(path).read_text())
    # Resample the regional field to the viewer grid by nearest-neighbour.
    dst_lats = payload["lats"]; dst_lons = payload["lons"]
    src_lats = np.asarray(lats); src_lons = np.asarray(lons)
    amp_grid = [[float(amp[int(np.abs(src_lats-lat).argmin()), int(np.abs(src_lons-lon).argmin())] * 3.280839895) for lon in dst_lons] for lat in dst_lats]
    high_grid = [[float(phase[int(np.abs(src_lats-lat).argmin()), int(np.abs(src_lons-lon).argmin())]) for lon in dst_lons] for lat in dst_lats]
    amp_grid = [[None if not np.isfinite(v) else v for v in row] for row in amp_grid]
    high_grid = [[None if not np.isfinite(v) else v for v in row] for row in high_grid]
    first = dt.datetime.strptime(payload["frames"][0]["time"].replace("Z", ""), "%Y-%m-%dT%H:%M")
    for frame in payload["frames"]:
        current = dt.datetime.strptime(frame["time"].replace("Z", ""), "%Y-%m-%dT%H:%M")
        hours = (current - first).total_seconds() / 3600.0
        frame["tide_amplitude_ft"] = amp_grid
        frame["tide_phase_deg"] = [[None if value is None else float((360.0 * hours / M2_HOURS - value) % 360.0) for value in row] for row in high_grid]
        # Materialize the actual tide-only model field consumed by the
        # viewer.  fit_m2 returns a high-water phase for the convention
        # value = amplitude*cos(omega*t - phase).
        frame["astronomical_tide_ft"] = [[
            None if amp_grid[yi][xi] is None or high_grid[yi][xi] is None else
            float(amp_grid[yi][xi] * np.cos(2.0 * np.pi * hours / M2_HOURS - np.deg2rad(high_grid[yi][xi])) + datum_shift_ft)
            for xi in range(len(dst_lons))
        ] for yi in range(len(dst_lats))]
        frame["tide_range_ft"] = [[None if v is None else float(2.0 * v) for v in row] for row in amp_grid]
    payload["tide_harmonic_source"] = {
        "provider": "NOAA",
        "model": "STOFS-2D Global HTP",
        "run": run_date,
        "object": source,
        "datum": "CO-OPS MLLW (STOFS HTP MSL-like field + validated regional datum shift)",
        "vertical_datum_shift_ft": float(datum_shift_ft),
        "constituents": ["M2"],
        "constituent": "M2",
        "units": "ft amplitude; degrees phase",
        "prediction_field": "astronomical_tide_ft",
    }
    Path(path).write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d"))
    ap.add_argument("--cycle", default="00")
    ap.add_argument("--datum-shift-ft", type=float, default=0.0,
                    help="validated uniform MSL-like to MLLW offset")
    ap.add_argument("--local-grib", type=Path,
                    help="local cached HTP GRIB; avoids repeated remote GDAL range reads")
    ap.add_argument("paths", nargs="+")
    args = ap.parse_args()
    run_date, key = find_regional_htp(args.date, args.cycle)
    values, lats, lons = read_window(key, args.local_grib)
    amp, phase = fit_m2(values, np.arange(values.shape[0]))
    for path in args.paths:
        merge(path, amp, phase, key, run_date, lats, lons, args.datum_shift_ft)
        print(f"merged STOFS HTP M2 phase/amplitude: {path}")


if __name__ == "__main__":
    main()
