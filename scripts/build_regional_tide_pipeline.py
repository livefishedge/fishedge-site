#!/usr/bin/env python3
"""Build and validate an independent regional tide candidate.

This is the promotion boundary for FishEdge tidal products. It deliberately
does not turn CO-OPS station predictions into an offshore model. A candidate
must carry explicit provenance and a serialized model field; promotion copies
only that candidate's fields and records the validation report.
"""

import argparse
import datetime as dt
import hashlib
import json
import math
import shutil
from pathlib import Path

import numpy as np

M2_HOURS = 12.4206
REQUIRED_SOURCE = {"provider", "model", "datum", "constituents"}


def epoch_ms(value):
    raw = str(value).replace("Z", "")
    return int(np.datetime64(raw).astype("datetime64[ms]").astype(int))


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def finite_values(grid):
    return [float(v) for row in (grid or []) for v in row if v is not None and math.isfinite(v)]


def validate_source(payload):
    source = payload.get("tide_harmonic_source") or payload.get("regional_tide_source")
    if not isinstance(source, dict) or not REQUIRED_SOURCE.issubset(source):
        raise ValueError("candidate lacks explicit provider/model/datum/constituents provenance")
    if str(source.get("model", "")).lower() in {"co-ops station harmonic prediction blend", "coops blend"}:
        raise ValueError("CO-OPS station blend cannot be promoted as an independent regional model")
    frames = payload.get("frames") or []
    if not frames or not payload.get("lats") or not payload.get("lons"):
        raise ValueError("candidate lacks frames or grid coordinates")
    key = source.get("prediction_field", "astronomical_tide_ft")
    values = [v for frame in frames for v in finite_values(frame.get(key))]
    if not values:
        raise ValueError(f"candidate has no finite {key} model field")
    if max(abs(v) for v in values) > 20.0:
        raise ValueError(f"candidate {key} exceeds physical USEC-MD bound: {max(abs(v) for v in values):.3f} ft")
    if not any(finite_values(frame.get("tide_range_ft")) for frame in frames):
        raise ValueError("candidate lacks finite tide_range_ft field")
    return source, key


def sample(grid, lats, lons, lat, lon):
    if not grid or not lats or not lons or not (lats[0] <= lat <= lats[-1] and lons[0] <= lon <= lons[-1]):
        return None
    xi = min(len(lons) - 1, max(0, min(range(len(lons)), key=lambda i: abs(lons[i] - lon))))
    yi = min(len(lats) - 1, max(0, min(range(len(lats)), key=lambda i: abs(lats[i] - lat))))
    value = grid[yi][xi]
    if value is not None and math.isfinite(value):
        return float(value)
    # Stations often sit on the shoreline while the raster cell is land.
    # Validate against the nearest finite wet cell, never against a land fill.
    candidates = []
    for radius in range(1, 5):
        for yj in range(max(0, yi-radius), min(len(lats), yi+radius+1)):
            for xj in range(max(0, xi-radius), min(len(lons), xi+radius+1)):
                candidate = grid[yj][xj]
                if candidate is not None and math.isfinite(candidate):
                    distance = ((float(lats[yj])-lat)**2 + (float(lons[xj])-lon)**2) ** 0.5
                    candidates.append((distance, float(candidate)))
        if candidates:
            return min(candidates)[1]
    return None


def metrics(payload, field):
    stations = (payload.get("tides") or {}).get("stations") or []
    observed = (payload.get("tides") or {}).get("observed") or {}
    frames = payload.get("frames") or []
    lats, lons = payload.get("lats") or [], payload.get("lons") or []
    rows, residuals = [], []
    for station in stations:
        obs = {int(p["t"]): float(p["v"]) for p in observed.get(station["id"], []) if p.get("v") not in (None, "")}
        pairs = []
        for frame in frames:
            t = epoch_ms(frame["time"])
            value = sample(frame.get(field), lats, lons, float(station["lat"]), float(station["lon"]))
            if value is not None and t in obs:
                pairs.append((value, obs[t]))
        if not pairs:
            rows.append({"id": station["id"], "name": station["name"], "samples": 0})
            continue
        model = np.asarray([p[0] for p in pairs]); meas = np.asarray([p[1] for p in pairs])
        diff = meas - model; residuals.extend(diff.tolist())
        rows.append({"id": station["id"], "name": station["name"], "samples": len(diff),
                     "bias_ft": round(float(diff.mean()), 4),
                     "mae_ft": round(float(np.abs(diff).mean()), 4),
                     "rmse_ft": round(float(np.sqrt(np.mean(diff ** 2))), 4)})
    if not residuals:
        raise ValueError("no overlapping model/measurement samples")
    residuals = np.asarray(residuals)
    return {"stations": rows, "samples": len(residuals),
            "median_bias_ft": round(float(np.median(residuals)), 4),
            "mean_bias_ft": round(float(residuals.mean()), 4),
            "rmse_ft": round(float(np.sqrt(np.mean(residuals ** 2))), 4),
            "stations_with_overlap": sum(row["samples"] > 0 for row in rows)}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("candidate", type=Path)
    ap.add_argument("--report", type=Path)
    ap.add_argument("--promote-to", type=Path)
    ap.add_argument("--min-stations", type=int, default=5)
    args = ap.parse_args()
    payload = json.loads(args.candidate.read_text())
    source, field = validate_source(payload)
    report = metrics(payload, field)
    report.update({"status": "pass" if report["stations_with_overlap"] >= args.min_stations else "fail",
                   "source": source, "prediction_field": field,
                   "candidate": str(args.candidate),
                   # This is intentionally the hash of the candidate before
                   # the validation report is embedded.  Calling it an
                   # artifact hash after embedding made the serialized
                   # provenance self-inconsistent.
                   "candidate_sha256": sha256(args.candidate),
                   "created_at": dt.datetime.now(dt.timezone.utc).isoformat()})
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2) + "\n")
    if args.promote_to:
        if report["status"] != "pass":
            raise SystemExit("refusing promotion: station-overlap gate failed")
        promoted = dict(payload)
        promoted["regional_tide_source"] = {**source, "candidate_sha256": report["candidate_sha256"], "validation": report}
        promoted["regional_tide_prediction_field"] = field
        args.promote_to.parent.mkdir(parents=True, exist_ok=True)
        args.promote_to.write_text(json.dumps(promoted, allow_nan=False, separators=(",", ":")))
    print(json.dumps(report, indent=2))
    if report["status"] != "pass":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
