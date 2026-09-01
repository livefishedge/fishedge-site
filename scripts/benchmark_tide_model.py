#!/usr/bin/env python3
"""Benchmark a gridded harmonic tide field against CO-OPS station curves.

The optional --apply-global-bias operation applies only the median station
residual (CO-OPS prediction minus model) to the model's astronomical tide
field.  It is intentionally refused unless the forecast explicitly declares
the requested atlas in ``tide_harmonic_source``.  This prevents a CO-OPS
station blend from being silently relabeled as a NASA/global model.
"""

import argparse
import json
import math
from pathlib import Path

import numpy as np


def sample(grid, lats, lons, lat, lon, radius=2):
    if not grid or len(lats) < 2 or len(lons) < 2:
        return None
    if not (lats[0] <= lat <= lats[-1] and lons[0] <= lon <= lons[-1]):
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
                dist2 = (xi - xf) ** 2 + (yi - yf) ** 2
                values.append((value, 1e9 if dist2 < 1e-12 else 1 / dist2))
    if not values:
        return None
    return sum(value * weight for value, weight in values) / sum(weight for _, weight in values)


def forecast_time(frame):
    return int(np.datetime64(str(frame["time"]).replace("Z", "")).astype("datetime64[ms]").astype(int))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("forecast", type=Path)
    ap.add_argument("--apply-global-bias", action="store_true")
    ap.add_argument("--output", type=Path)
    args = ap.parse_args()
    payload = json.loads(Path(args.forecast).read_text()) if str(args.forecast) != "-" else json.load(__import__("sys").stdin)
    source = payload.get("tide_harmonic_source") or {}
    model_name = source.get("model", "")
    stations = payload.get("tides", {}).get("stations", [])
    curves = payload.get("tides", {}).get("curves", {})
    frames = payload.get("frames", [])
    lats, lons = payload.get("lats", []), payload.get("lons", [])
    rows = []
    residuals = []
    for station in stations:
        model = []
        for frame in frames:
            value = sample(frame.get("astronomical_tide_ft"), lats, lons, station["lat"], station["lon"])
            if value is None:
                amplitude = sample(frame.get("tide_amplitude_ft"), lats, lons, station["lat"], station["lon"])
                phase = sample(frame.get("tide_phase_deg"), lats, lons, station["lat"], station["lon"])
                if amplitude is not None and phase is not None:
                    value = amplitude * math.cos(math.radians(phase))
            if value is not None:
                model.append((forecast_time(frame), value))
        observed = {int(point["t"]): float(point["v"]) for point in curves.get(station["id"], [])}
        pairs = [(m, observed[t]) for t, m in model if t in observed]
        if not pairs:
            rows.append({"id": station["id"], "name": station["name"], "samples": 0})
            continue
        diff = np.array([coops - model_value for model_value, coops in pairs])
        residuals.extend(diff.tolist())
        model_values = np.array([model_value for model_value, _ in pairs])
        coops_values = np.array([coops for _, coops in pairs])
        omega = 2.0 * math.pi / 12.4206
        times = np.array([t / 1000.0 / 3600.0 for t in sorted(observed) if t in {time for time, _ in model}])
        # Fit both series to the same M2 frequency. This distinguishes a
        # vertical datum bias from amplitude and phase disagreement.
        fit_times = np.array([t / 1000.0 / 3600.0 for t, _ in model if t in observed])
        design = np.column_stack((np.ones(len(fit_times)), np.cos(omega * fit_times), np.sin(omega * fit_times)))
        model_coeff, *_ = np.linalg.lstsq(design, model_values, rcond=None)
        coops_coeff, *_ = np.linalg.lstsq(design, coops_values, rcond=None)
        model_amp = float(np.hypot(model_coeff[1], model_coeff[2]))
        coops_amp = float(np.hypot(coops_coeff[1], coops_coeff[2]))
        phase_error = math.degrees(math.atan2(coops_coeff[2], coops_coeff[1]) - math.atan2(model_coeff[2], model_coeff[1]))
        phase_error = (phase_error + 180.0) % 360.0 - 180.0
        rows.append({
            "id": station["id"], "name": station["name"], "samples": len(diff),
            "bias_ft": round(float(np.mean(diff)), 4),
            "mae_ft": round(float(np.mean(np.abs(diff))), 4),
            "rmse_ft": round(float(np.sqrt(np.mean(diff ** 2))), 4),
            "model_m2_amplitude_ft": round(model_amp, 4),
            "coops_m2_amplitude_ft": round(coops_amp, 4),
            "amplitude_error_ft": round(coops_amp - model_amp, 4),
            "phase_error_deg": round(phase_error, 3),
        })
    if not residuals:
        raise SystemExit("no overlapping model/CO-OPS samples")
    residuals = np.asarray(residuals)
    bias = float(np.median(residuals))
    result = {
        "model": model_name or "UNDECLARED",
        "stations": rows,
        "global_median_bias_ft": round(bias, 4),
        "global_mean_bias_ft": round(float(np.mean(residuals)), 4),
        "global_rmse_ft": round(float(np.sqrt(np.mean(residuals ** 2))), 4),
        "samples": int(len(residuals)),
        "bias_applied": False,
    }
    if args.apply_global_bias:
        if model_name != "GOT4.10c":
            raise SystemExit("refusing to shift: forecast does not declare tide_harmonic_source.model=GOT4.10c")
        for frame in frames:
            grid = frame.get("astronomical_tide_ft")
            if grid:
                frame["astronomical_tide_ft"] = [[None if v is None else float(v + bias) for v in row] for row in grid]
        payload.setdefault("tide_harmonic_source", {})["global_bias_correction_ft"] = round(bias, 4)
        result["bias_applied"] = True
        output = args.output or args.forecast
        output.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
