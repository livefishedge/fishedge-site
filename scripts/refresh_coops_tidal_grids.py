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
from shapely.geometry import Point, box

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
    payload["tide_water_cells"] = water_cell_mask(lats, lons)
    payload["tides"] = tides
    add_tide_grids(payload["frames"], tides, lats, lons, preserve_ofs=True, land_mask=land)
    add_tidal_range_field(payload["frames"])
    add_harmonic_phase_amplitude(payload["frames"], tides=tides, lats=lats, lons=lons, land_mask=land)
    for frame in payload["frames"]:
        if "tide_height_ft" in frame and not frame.get("tide_model_source"):
            frame["tide_model_source"] = ["coops_station_blend"]
            frame["tide_model_datum"] = "MLLW"
    # Preserve gridded harmonic fields when this refresh runs after the
    # STOFS HTP merge. CO-OPS fills only missing total-height frames; it must
    # never erase the local-stage / Tidal Range fields already in the artifact.
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


def add_tidal_range_field(frames):
    """Derive one full high-to-low range field from the displayed tide curves."""
    if not frames: return
    source = [frame.get("tide_height_ft") for frame in frames]
    sample = next((grid for grid in source if grid), None)
    if not sample: return
    ny, nx = len(sample), len(sample[0])
    ranges = []
    for yi in range(ny):
        row = []
        for xi in range(nx):
            values = [grid[yi][xi] for grid in source if grid and grid[yi][xi] is not None]
            row.append(float(max(values) - min(values)) if values else None)
        ranges.append(row)
    for frame in frames: frame["tide_range_ft"] = ranges


def water_cell_mask(lats, lons):
    """Return cells that do not intersect Natural Earth land.

    A point mask leaves narrow peninsulas/islands between four water corner
    points looking like ocean.  The contour renderer works cell-by-cell, so it
    needs a conservative polygon-intersection mask as well.
    """
    reader = shapereader.natural_earth(resolution="10m", category="physical", name="land")
    geometries = list(shapereader.Reader(reader).geometries())
    cells = []
    for yi in range(len(lats) - 1):
        row = []
        for xi in range(len(lons) - 1):
            cell = box(lons[xi], lats[yi], lons[xi + 1], lats[yi + 1])
            row.append(not any(geometry.intersects(cell) for geometry in geometries))
        cells.append(row)
    return cells


def add_harmonic_phase_amplitude(frames, tides=None, lats=None, lons=None, land_mask=None):
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

    # Interpolate the complex M2 coefficients (cosine/sine terms), rather
    # than interpolating heights and fitting afterward.  Complex interpolation
    # preserves phase propagation between stations into the offshore cells.
    station_coeffs = []
    if tides:
        frame0 = times[0].replace(tzinfo=dt.timezone.utc)
        for station in tides.get("stations") or []:
            curve = tides.get("curves", {}).get(station["id"]) or []
            if len(curve) < 12:
                continue
            ct = np.array([(float(point["t"]) / 1000.0 - frame0.timestamp()) / 3600.0 for point in curve])
            values = np.array([point["v"] for point in curve], dtype=float)
            valid = np.isfinite(ct) & np.isfinite(values)
            if valid.sum() < 12:
                continue
            cdesign = np.column_stack((np.ones(valid.sum()), np.cos(omega * ct[valid]), np.sin(omega * ct[valid])))
            coeff, *_ = np.linalg.lstsq(cdesign, values[valid], rcond=None)
            station_coeffs.append((station, coeff))
    if station_coeffs and lats is not None and lons is not None:
        for yi, lat in enumerate(lats):
            for xi, lon in enumerate(lons):
                if land_mask and land_mask[yi][xi]:
                    continue
                weighted = []
                for station, coeff in station_coeffs:
                    dlat = lat - station["lat"]
                    dlon = (lon - station["lon"]) * np.cos(np.deg2rad(lat))
                    d2 = dlat * dlat + dlon * dlon
                    weighted.append((1e12 if d2 < 1e-10 else 1.0 / d2, coeff))
                total = sum(weight for weight, _ in weighted)
                coeff = sum((weight / total) * value for weight, value in weighted)
                amplitude = float(np.hypot(coeff[1], coeff[2]))
                if np.isfinite(amplitude):
                    amp[yi, xi] = amplitude
                    high_phase = np.arctan2(coeff[2], coeff[1])
                    phase[:, yi, xi] = (np.rad2deg(omega * t - high_phase) % 360.0)
    else:
        # Backward-compatible fallback for callers that only provide frames.
        for yi in range(ny):
            for xi in range(nx):
                values = np.array([frame.get("tide_height_ft", [])[yi][xi] for frame in frames], dtype=float)
                valid = np.isfinite(values)
                if valid.sum() < 12:
                    continue
                coeff, *_ = np.linalg.lstsq(design[valid], values[valid], rcond=None)
                amp[yi, xi] = float(np.hypot(coeff[1], coeff[2]))
                high_phase = np.arctan2(coeff[2], coeff[1])
                phase[:, yi, xi] = (np.rad2deg(omega * t - high_phase) % 360.0)
    amp_json = np.where(np.isfinite(amp), amp, None).tolist()
    for index, frame in enumerate(frames):
        frame["tide_amplitude_ft"] = amp_json
        frame["tide_phase_deg"] = np.where(np.isfinite(phase[index]), phase[index], None).tolist()
        astro = np.where(
            np.isfinite(amp) & np.isfinite(phase[index]),
            amp * np.cos(np.deg2rad(phase[index])),
            np.nan,
        )
        frame["astronomical_tide_ft"] = [[None if not np.isfinite(v) else float(v) for v in row] for row in astro]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours", type=int, default=168)
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
