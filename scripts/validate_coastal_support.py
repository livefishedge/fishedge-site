#!/usr/bin/env python3
"""Validate generic coastal support invariants for a forecast artifact."""
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD = ROOT / "data/usec_md/briefing/forecast.json"
MASK = ROOT / "dashboard/trip-planner/data/usec_md/briefing/native_wave_mask.png"

payload = json.loads(PAYLOAD.read_text())
mask = np.asarray(Image.open(MASK).convert("L")) >= 128
source = payload["marine_source_grid"]
open_cells = np.asarray(payload["wave_open_water_cells"], dtype=bool)
coverage = np.asarray(payload["wave_water_coverage"], dtype=float)

assert source["returned_latitude"] and source["returned_longitude"]
assert np.isfinite(source["max_displacement_km"])
assert open_cells.shape == (len(payload["lats"]) - 1, len(payload["lons"]) - 1)
assert coverage.shape == open_cells.shape
assert np.all((coverage >= 0) & (coverage <= 1))

# Discover generic barrier evidence: a land run with water on both sides in a
# raster row. This does not name or special-case a bay/island.
barrier_runs = []
for y in range(mask.shape[0]):
    row = mask[y]
    transitions = np.flatnonzero(row[1:] != row[:-1]) + 1
    for left, right in zip(transitions[::2], transitions[1::2]):
        if left > 0 and right < len(row) and right - left <= 160 and row[left - 1] and row[right]:
            barrier_runs.append((int(y), int(left), int(right)))

partial_cells = int(np.count_nonzero((coverage > 0) & (coverage < 0.999)))
closed_cells = int(np.count_nonzero((coverage >= 0.75) & ~open_cells))
report = {
    "source_max_displacement_km": source["max_displacement_km"],
    "source_mean_displacement_km": source["mean_displacement_km"],
    "mask_size": list(mask.shape[::-1]),
    "barrier_runs_discovered": len(barrier_runs),
    "partial_coastal_cells": partial_cells,
    "closed_or_unresolved_cells": closed_cells,
    "open_water_cells": int(open_cells.sum()),
    "fixtures": {
        "exposed_coast": [-74.0, 38.0],
        "barrier_coast": [-75.1, 38.2],
        "enclosed_water_candidate": [-76.0, 38.5],
        "narrow_entrance_candidate": [-75.9, 37.2],
    },
}
assert report["barrier_runs_discovered"] > 0, "mask contains no discoverable water-land-water barriers"
print(json.dumps(report, indent=2))
