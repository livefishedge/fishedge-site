#!/usr/bin/env python3
"""Restore the phase-aligned stored tide series for the briefing viewer.

The stored ``tide_height_ft`` series is the CO-OPS harmonic station blend used
by the original working viewer.  This command makes it the single displayed
prediction field and derives the co-range field from the same serialized
series.  It deliberately does not call this field NASA GOT4.10c.
"""

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()
    for path in args.paths:
        payload = json.loads(path.read_text())
        frames = payload.get("frames") or []
        source = [frame.get("tide_height_ft") for frame in frames]
        sample = next((grid for grid in source if grid), None)
        if not sample:
            raise SystemExit(f"{path}: no stored tide_height_ft series")
        ny, nx = len(sample), len(sample[0])
        ranges = []
        for yi in range(ny):
            row = []
            for xi in range(nx):
                values = [grid[yi][xi] for grid in source
                          if grid and grid[yi][xi] is not None]
                row.append(float(max(values) - min(values)) if values else None)
            ranges.append(row)
        for frame in frames:
            frame["astronomical_tide_ft"] = frame.get("tide_height_ft")
            frame["tide_range_ft"] = ranges
        payload["tide_harmonic_source"] = {
            "provider": "NOAA CO-OPS",
            "model": "CO-OPS station harmonic prediction blend",
            "method": "stored station predictions interpolated across the regional grid",
            "prediction_field": "tide_height_ft",
            "co_range_field": "tide_range_ft derived from the same stored series",
            "nasa_got4_comparison": "not used for the displayed prediction",
        }
        quality = payload.setdefault("quality", {})
        quality["co_tidal_source"] = (
            "NOAA CO-OPS harmonic station blend; popup and co-range use the "
            "same stored tide_height_ft series; observations are validation"
        )
        quality.pop("tide_benchmark", None)
        path.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
        print(f"restored phase-aligned stored tide series: {path}")


if __name__ == "__main__":
    main()
