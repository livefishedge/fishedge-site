#!/usr/bin/env python3
"""Extend the FishEdge tide layer with a labeled CO-OPS estimate.

The regional OFS artifact is authoritative where CBOFS/DBOFS has coverage.
This small refresh job fills the rest of the existing forecast horizon from
72-hour CO-OPS harmonic station predictions using the same IDW method as the
legacy layer. It never overwrites an OFS frame, and marks fallback frames as
``coops_station_blend`` so the viewer can distinguish them.
"""

import argparse
import datetime as dt
import json
from pathlib import Path
import numpy as np
from cartopy.io import shapereader
from shapely.geometry import Point

from fetch_wave_openmeteo import (
    DISPLAY_BBOX,
    STEP_DEG,
    add_tide_grids,
    fetch_all_tides,
)


def grid():
    lats = []
    lat = DISPLAY_BBOX[1]
    while lat <= DISPLAY_BBOX[3] + 1e-9:
        lats.append(round(lat, 4))
        lat += STEP_DEG
    lons = []
    lon = DISPLAY_BBOX[0]
    while lon <= DISPLAY_BBOX[2] + 1e-9:
        lons.append(round(lon, 4))
        lon += STEP_DEG
    return lats, lons


def refresh(path, tides):
    payload = json.loads(Path(path).read_text())
    lats, lons = grid()
    land = land_mask(lats, lons)
    add_tide_grids(payload["frames"], tides, lats, lons, preserve_ofs=True, land_mask=land)
    for frame in payload["frames"]:
        if "tide_height_ft" in frame and not frame.get("tide_model_source"):
            frame["tide_model_source"] = ["coops_station_blend"]
            frame["tide_model_datum"] = "MLLW"
    add_harmonic_phase_amplitude(payload["frames"])
    payload.setdefault("quality", {})["coops_tidal_fallback"] = (
        "CO-OPS harmonic station blend; estimated between stations; "
        "OFS frames take precedence"
    )
    tmp = Path(path).with_suffix(Path(path).suffix + ".tmp")
    tmp.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
    tmp.replace(path)
    print(f"refreshed {path}")


def land_mask(lats, lons):
    """Return a display-grid land mask from Natural Earth 10m polygons."""
    reader = shapereader.natural_earth(resolution="10m", category="physical", name="land")
    geometries = list(shapereader.Reader(reader).geometries())
    return [[any(geometry.contains(Point(lon, lat)) for geometry in geometries) for lon in lons] for lat in lats]


def add_harmonic_phase_amplitude(frames):
    """Fit the dominant M2 constituent for co-tidal/co-range map overlays.

    This is intentionally labeled an estimate: the 72-hour window is not a
    substitute for a full NOAA harmonic atlas, and OFS zeta can include surge.
    Phase convention is 0° at fitted high water, 90° falling, 180° low water,
    and 270° rising.
    """
    if not frames:
        return
    times = []
    for frame in frames:
        raw = str(frame.get("time", "")).replace("Z", "")
        times.append(dt.datetime.strptime(raw, "%Y-%m-%dT%H:%M"))
    t = np.array([(value - times[0]).total_seconds() / 3600.0 for value in times])
    omega = 2.0 * np.pi / 12.4206  # lunar M2 period, hours
    design = np.column_stack((np.ones(len(t)), np.cos(omega * t), np.sin(omega * t)))
    ny = len(frames[0].get("tide_height_ft") or [])
    nx = len((frames[0].get("tide_height_ft") or [[]])[0]) if ny else 0
    amp = np.full((ny, nx), np.nan)
    phase = np.full((len(frames), ny, nx), np.nan)
    for yi in range(ny):
        for xi in range(nx):
            values = np.array([
                frame.get("tide_height_ft", [[None] * nx for _ in range(ny)])[yi][xi]
                for frame in frames
            ], dtype=float)
            valid = np.isfinite(values)
            if valid.sum() < 12:
                continue
            coeff, *_ = np.linalg.lstsq(design[valid], values[valid], rcond=None)
            amplitude = float(np.hypot(coeff[1], coeff[2]))
            if not np.isfinite(amplitude):
                continue
            amp[yi, xi] = amplitude
            high_phase = np.arctan2(coeff[2], coeff[1])
            phase[:, yi, xi] = (np.rad2deg(omega * t - high_phase) % 360.0)
    amp_json = np.where(np.isfinite(amp), amp, None).tolist()
    for index, frame in enumerate(frames):
        frame["tide_amplitude_ft"] = amp_json
        frame["tide_phase_deg"] = np.where(np.isfinite(phase[index]), phase[index], None).tolist()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours", type=int, default=72)
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()
    first_time = json.loads(args.paths[0].read_text())["frames"][0]["time"]
    begin = dt.datetime.strptime(first_time, "%Y-%m-%dT%H:%M").replace(tzinfo=None)
    tides = fetch_all_tides(hours=args.hours, begin=begin)
    print(f"CO-OPS stations: {len(tides['curves'])}/{len(tides['stations'])}")
    for path in args.paths:
        refresh(path, tides)


if __name__ == "__main__":
    main()
