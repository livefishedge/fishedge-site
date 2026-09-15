#!/usr/bin/env python3
"""Refresh current CO-OPS predictions/observations and the display tide grid."""

import argparse
import json
from pathlib import Path
import subprocess
import sys

from fetch_wave_openmeteo import DISPLAY_BBOX, STEP_DEG, add_tide_grids, fetch_all_tides


def grid():
    lats = [round(DISPLAY_BBOX[1] + i * STEP_DEG, 4)
            for i in range(round((DISPLAY_BBOX[3] - DISPLAY_BBOX[1]) / STEP_DEG) + 1)]
    lons = [round(DISPLAY_BBOX[0] + i * STEP_DEG, 4)
            for i in range(round((DISPLAY_BBOX[2] - DISPLAY_BBOX[0]) / STEP_DEG) + 1)]
    return lats, lons


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    payload = json.loads(args.path.read_text())
    tides = fetch_all_tides()
    lats, lons = grid()
    payload["tides"] = tides
    # Replace the previous station-blend frames with current predictions.
    add_tide_grids(payload["frames"], tides, lats, lons, preserve_ofs=True)
    args.path.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
    subprocess.run([sys.executable, "scripts/restore_phase_aligned_tide_baseline.py", str(args.path)], check=True)


if __name__ == "__main__":
    main()
