#!/usr/bin/env python3
"""Repair and validate the viewer's static co-range contract.

The range is the full forecast-horizon max-min of the serialized astronomical
tide field.  A cell is drawable only when all four corner points are finite for
every frame; no missing corner is interpolated across land.
"""
import argparse
import json
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
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
