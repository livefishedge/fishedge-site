#!/usr/bin/env python3
"""Extend the FishEdge tide layer with a labeled CO-OPS estimate.

The regional OFS artifact is authoritative where CBOFS/DBOFS has coverage.
This small refresh job fills the rest of the existing forecast horizon from
72-hour CO-OPS harmonic station predictions using the same IDW method as the
legacy layer. It never overwrites an OFS frame, and marks fallback frames as
``coops_station_blend`` so the viewer can distinguish them.
"""

import argparse
import json
from pathlib import Path

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
    add_tide_grids(payload["frames"], tides, lats, lons, preserve_ofs=True)
    for frame in payload["frames"]:
        if "tide_height_ft" in frame and not frame.get("tide_model_source"):
            frame["tide_model_source"] = ["coops_station_blend"]
            frame["tide_model_datum"] = "MLLW"
    payload.setdefault("quality", {})["coops_tidal_fallback"] = (
        "CO-OPS harmonic station blend; estimated between stations; "
        "OFS frames take precedence"
    )
    tmp = Path(path).with_suffix(Path(path).suffix + ".tmp")
    tmp.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
    tmp.replace(path)
    print(f"refreshed {path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hours", type=int, default=72)
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()
    tides = fetch_all_tides(hours=args.hours)
    print(f"CO-OPS stations: {len(tides['curves'])}/{len(tides['stations'])}")
    for path in args.paths:
        refresh(path, tides)


if __name__ == "__main__":
    main()
