#!/usr/bin/env python3
"""Recover a GOT4.10c-derived M2 field and calibrate its datum to CO-OPS.

The recovered historical artifact is a valid NASA-derived field but only the
published M2 amplitude/phase grids are available.  This script therefore
labels the resulting forecast as M2-only and refuses non-GOT model inputs.
"""

import argparse
import json
import math
from pathlib import Path
import subprocess

import numpy as np

M2_HOURS = 12.4206


def sample(grid, lats, lons, lat, lon, radius=2):
    if not grid or not lats or not lons or not (lats[0] <= lat <= lats[-1] and lons[0] <= lon <= lons[-1]):
        return None
    xf = (lon - lons[0]) / ((lons[-1] - lons[0]) / (len(lons) - 1))
    yf = (lat - lats[0]) / ((lats[-1] - lats[0]) / (len(lats) - 1))
    x0, y0 = max(0, min(len(lons) - 2, math.floor(xf))), max(0, min(len(lats) - 2, math.floor(yf)))
    tx, ty = xf - x0, yf - y0
    corners = [grid[y0][x0], grid[y0][x0 + 1], grid[y0 + 1][x0], grid[y0 + 1][x0 + 1]]
    if all(v is not None and math.isfinite(v) for v in corners):
        a, b, c, d = corners
        return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty
    values = []
    cx, cy = round(xf), round(yf)
    for yi in range(max(0, cy - radius), min(len(lats), cy + radius + 1)):
        for xi in range(max(0, cx - radius), min(len(lons), cx + radius + 1)):
            value = grid[yi][xi]
            if value is not None and math.isfinite(value):
                d2 = (xi - xf) ** 2 + (yi - yf) ** 2
                values.append((value, 1e9 if d2 < 1e-12 else 1 / d2))
    return sum(v * w for v, w in values) / sum(w for _, w in values) if values else None


def epoch_ms(value):
    return int(np.datetime64(str(value).replace("Z", "")).astype("datetime64[ms]").astype(int))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_artifact", type=Path)
    ap.add_argument("forecast", type=Path)
    ap.add_argument("--output", type=Path)
    ap.add_argument("--report-only", action="store_true")
    ap.add_argument("--no-global-shift", action="store_true",
                    help="restore the GOT4.10c field without applying a datum correction")
    args = ap.parse_args()
    model_ref = str(args.model_artifact)
    if model_ref.startswith("git:"):
        ref, path = model_ref[4:].split(":", 1)
        model = json.loads(subprocess.check_output(["git", "show", f"{ref}:{path}"]))
    else:
        model = json.loads(args.model_artifact.read_text())
    payload = json.loads(args.forecast.read_text())
    source = model.get("tide_harmonic_source") or {}
    if source.get("model") != "GOT4.10c":
        raise SystemExit("model artifact is not explicitly GOT4.10c")
    mf = model["frames"][0]
    amp_grid, phase_grid = mf.get("tide_amplitude_ft"), mf.get("tide_phase_deg")
    if not amp_grid or not phase_grid:
        raise SystemExit("GOT4.10c artifact lacks M2 amplitude/phase grids")
    lats, lons = model["lats"], model["lons"]
    model_start = epoch_ms(model["frames"][0]["time"])
    omega = 2 * math.pi / M2_HOURS
    residuals, station_metrics = [], []
    for station in payload.get("tides", {}).get("stations", []):
        curve = payload.get("tides", {}).get("curves", {}).get(station["id"], [])
        pairs = []
        amp = sample(amp_grid, lats, lons, station["lat"], station["lon"])
        phase = sample(phase_grid, lats, lons, station["lat"], station["lon"])
        if amp is None or phase is None:
            station_metrics.append({"id": station["id"], "name": station["name"], "samples": 0})
            continue
        for point in curve:
            t = int(point["t"])
            model_value = amp * math.cos(math.radians(phase) + omega * ((t - model_start) / 3600000))
            pairs.append((model_value, float(point["v"])))
        if not pairs:
            station_metrics.append({"id": station["id"], "name": station["name"], "samples": 0})
            continue
        diff = np.array([observed - predicted for predicted, observed in pairs])
        residuals.extend(diff.tolist())
        times = np.array([point["t"] / 1000 / 3600 for point in curve], dtype=float)
        design = np.column_stack((np.ones(len(times)), np.cos(2 * math.pi / M2_HOURS * times), np.sin(2 * math.pi / M2_HOURS * times)))
        coops_values = np.array([float(point["v"]) for point in curve])
        coops_coeff, *_ = np.linalg.lstsq(design, coops_values, rcond=None)
        coops_amp = float(np.hypot(coops_coeff[1], coops_coeff[2]))
        model_phase = math.radians(phase) - 2 * math.pi / M2_HOURS * model_start / 3600000
        coops_phase = math.atan2(coops_coeff[2], coops_coeff[1])
        phase_error = math.degrees(coops_phase - model_phase)
        phase_error = (phase_error + 180.0) % 360.0 - 180.0
        station_metrics.append({
            "id": station["id"], "name": station["name"], "samples": len(diff),
            "bias_ft": round(float(np.mean(diff)), 4),
            "rmse_ft": round(float(np.sqrt(np.mean(diff ** 2))), 4),
            "mae_ft": round(float(np.mean(np.abs(diff))), 4),
            "model_m2_amplitude_ft": round(float(amp), 4),
            "coops_m2_amplitude_ft": round(coops_amp, 4),
            "amplitude_error_ft": round(coops_amp - float(amp), 4),
            "phase_error_deg": round(phase_error, 3),
        })
    if not residuals:
        raise SystemExit("no current CO-OPS station samples could be benchmarked")
    residuals = np.asarray(residuals)
    bias = 0.0 if args.no_global_shift else float(np.median(residuals))
    corrected = residuals - bias
    report = {
        "model": "GOT4.10c",
        "stations": station_metrics,
        "samples": int(len(residuals)),
        "global_median_bias_ft": round(bias, 4),
        "global_mean_bias_ft": round(float(np.mean(residuals)), 4),
        "pre_correction_rmse_ft": round(float(np.sqrt(np.mean(residuals ** 2))), 4),
        "post_correction_rmse_ft": round(float(np.sqrt(np.mean(corrected ** 2))), 4),
        "post_correction_mean_bias_ft": round(float(np.mean(corrected)), 4),
        "correction": ("none (raw GOT4.10c field)" if args.no_global_shift
                       else "global median CO-OPS prediction minus GOT4.10c M2 model"),
    }
    for frame in payload["frames"]:
        hours = (epoch_ms(frame["time"]) - model_start) / 3600000
        phase = [[None if v is None else float((v + 360 * hours / M2_HOURS) % 360) for v in row] for row in phase_grid]
        frame["tide_amplitude_ft"] = amp_grid
        frame["tide_phase_deg"] = phase
        # Keep the serialized co-range field synchronized with the harmonic
        # coefficient used by the viewer. Never preserve a stale CO-OPS or
        # prior-generation range grid during a GOT4.10c restore.
        frame["tide_range_ft"] = [[
            None if value is None else float(value * 2)
            for value in row
        ] for row in amp_grid]
        frame["astronomical_tide_ft"] = [[
            None if amp_grid[yi][xi] is None or phase[yi][xi] is None else
            float(amp_grid[yi][xi] * math.cos(math.radians(phase[yi][xi])) + bias)
            for xi in range(len(amp_grid[yi]))
        ] for yi in range(len(amp_grid))]
    payload["tide_harmonic_source"] = {
        **source,
        "available_constituents": ["M2"],
        "field_recovered_from": "Git commit 27172aa8",
        "global_bias_correction_ft": round(bias, 4),
        "calibration_applied": not args.no_global_shift,
        "calibration_reference": "current eight CO-OPS station prediction curves",
    }
    quality = payload.setdefault("quality", {})
    quality.pop("coops_tidal_fallback", None)
    quality["co_tidal_source"] = ("NASA GSFC GOT4.10c M2 harmonic field; no global shift applied; "
                                   "CO-OPS observations are validation only"
                                   if args.no_global_shift else
                                   "NASA GSFC GOT4.10c M2 harmonic field with station-calibrated datum offset; CO-OPS observations are validation only")
    quality["tide_benchmark"] = report
    if args.report_only and args.output:
        refreshed = json.loads(args.forecast.read_text())
        refreshed.setdefault("quality", {})["tide_benchmark"] = report
        args.output.write_text(json.dumps(refreshed, allow_nan=False, separators=(",", ":")))
    elif not args.report_only:
        output = args.output or args.forecast
        output.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
