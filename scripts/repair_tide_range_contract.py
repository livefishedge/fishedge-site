#!/usr/bin/env python3
"""Repair and validate the viewer's static co-range contract.

The range is the full forecast-horizon max-min of the serialized astronomical
tide field.  A cell is drawable only when all four corner points are finite for
every frame; no missing corner is interpolated across land.
"""
import argparse
import json
import statistics
from pathlib import Path


def finite(value):
    return isinstance(value, (int, float)) and value == value


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", type=Path)
    ap.add_argument("output", type=Path)
    args = ap.parse_args()
    payload = json.loads(args.input.read_text())
    frames = payload.get("frames") or []
    grids = [f.get("astronomical_tide_ft") for f in frames]
    if not grids or any(not g for g in grids):
        raise SystemExit("missing astronomical_tide_ft frames")
    ny = len(grids[0])
    nx = len(grids[0][0]) if ny else 0
    if ny < 2 or nx < 2 or any(len(g) != ny or any(len(row) != nx for row in g) for g in grids):
        raise SystemExit("inconsistent tide grid dimensions")

    ranges = []
    wet_cells = []
    for yi in range(ny - 1):
        range_row = []
        mask_row = []
        for xi in range(nx - 1):
            corners = [g[y][x] for g in grids for y, x in ((yi, xi), (yi, xi + 1), (yi + 1, xi), (yi + 1, xi + 1))]
            ok = all(finite(v) for v in corners)
            mask_row.append(ok)
            range_row.append(max(corners) - min(corners) if ok else None)
        ranges.append(range_row)
        wet_cells.append(mask_row)

    # Reject isolated range spikes.  A single 8+ ft cell surrounded by ~4 ft
    # cells is a remapping/calibration artifact, not a resolved tidal front.
    # Keep this conservative: only reject a cell with at least four finite
    # neighbors and a >1.5 ft / >45% departure from their median.
    rejected = []
    for yi in range(ny - 1):
        for xi in range(nx - 1):
            value = ranges[yi][xi]
            if value is None:
                continue
            neighbors = []
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    if not dx and not dy:
                        continue
                    yy, xx = yi + dy, xi + dx
                    if 0 <= yy < ny - 1 and 0 <= xx < nx - 1 and ranges[yy][xx] is not None:
                        neighbors.append(ranges[yy][xx])
            if len(neighbors) < 4:
                continue
            median = statistics.median(neighbors)
            if abs(value - median) > max(1.5, 0.45 * median):
                ranges[yi][xi] = None
                wet_cells[yi][xi] = False
                rejected.append({"cell": [yi, xi], "range_ft": round(value, 4), "neighbor_median_ft": round(median, 4)})

    # Store the static range on every frame for backward-compatible viewers;
    # all copies are identical by construction.
    for frame in frames:
        frame["tide_range_ft"] = ranges
        frame.pop("tide_amplitude_ft", None)
    payload["tide_water_cells"] = wet_cells
    payload["tide_range_definition"] = "full forecast-horizon max-min of astronomical_tide_ft (ft)"
    payload["tide_range_field"] = "tide_range_ft"
    payload["tide_range_contract"] = {
        "kind": "static_cell_field",
        "mask": "tide_water_cells; all four corners finite across the complete horizon",
        "missing_policy": "null; never interpolate land or missing corners",
        "frame_copy_invariant": True,
        "spatial_outlier_qc": {"method": "8-neighbor median", "rejected_cells": rejected},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
