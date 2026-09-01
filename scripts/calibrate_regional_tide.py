#!/usr/bin/env python3
"""Calibrate an independent harmonic atlas without fitting station heights.

Input is a normalized harmonic JSON artifact with ``constituents`` mapping
constituent names to ``amplitude_ft`` and ``phase_deg`` grids, plus the FishEdge
CO-OPS station observations.  The calibration is performed in complex cosine /
sine space.  It never interpolates phase degrees and never uses CO-OPS
predictions as the regional field.

The command writes a synthesized candidate only when both gates pass:
leave-one-station-out validation and a chronological time-held-out split.
"""

import argparse
import datetime as dt
import json
import math
from pathlib import Path

import numpy as np

PERIOD_HOURS = {
    "M2": 12.4206012, "S2": 12.0, "N2": 12.6583475, "K2": 11.967236,
    "K1": 23.934472, "O1": 25.819338, "P1": 24.06589, "Q1": 26.86835,
}


def epoch_ms(value):
    if isinstance(value, (int, float, np.integer, np.floating)):
        return int(value)
    return int(np.datetime64(str(value).replace("Z", "")).astype("datetime64[ms]").astype(int))


def finite_grid(grid):
    return np.asarray(grid, dtype=float)


def wrap_phase(value):
    return (value + 180.0) % 360.0 - 180.0


def fit_constituents(points, names, reference_ms):
    """Return intercept and complex coefficients for a station curve."""
    valid = [(epoch_ms(p["t"] if "t" in p else p["time"]), float(p["v"]))
             for p in points if p.get("v") not in (None, "")]
    if len(valid) < max(2 * len(names) + 2, 12):
        return None
    times = np.asarray([(t - reference_ms) / 3600000.0 for t, _ in valid])
    values = np.asarray([v for _, v in valid])
    columns = [np.ones(len(times))]
    for name in names:
        omega = 2.0 * np.pi / PERIOD_HOURS[name]
        columns.extend((np.cos(omega * times), np.sin(omega * times)))
    coeff, *_ = np.linalg.lstsq(np.column_stack(columns), values, rcond=None)
    return coeff


def source_coefficients(source, names):
    """Convert amplitude/phase grids to cosine/sine coefficient grids."""
    result = {}
    for name in names:
        item = source["constituents"][name]
        amp = finite_grid(item["amplitude_ft"])
        phase = np.deg2rad(finite_grid(item["phase_deg"]))
        result[name] = (amp * np.cos(phase), amp * np.sin(phase))
    return result


def station_residuals(payload, source, names, train_ids, reference_ms, start_ms=None, end_ms=None):
    stations = {str(s["id"]): s for s in payload.get("tides", {}).get("stations", [])}
    curves = payload.get("tides", {}).get("observed", {}) or payload.get("tides", {}).get("curves", {})
    coeffs = {}
    for station_id in train_ids:
        points = []
        for p in curves.get(station_id, []):
            t = epoch_ms(p["t"] if "t" in p else p["time"])
            if (start_ms is None or t >= start_ms) and (end_ms is None or t < end_ms):
                points.append(p)
        fitted = fit_constituents(points, names, reference_ms)
        if fitted is not None:
            coeffs[station_id] = fitted
    return stations, coeffs


def station_model_coeff(source_coeff, lats, lons, station, names):
    yi = int(np.abs(np.asarray(lats) - float(station["lat"])).argmin())
    xi = int(np.abs(np.asarray(lons) - float(station["lon"])).argmin())
    return {name: (float(source_coeff[name][0][yi, xi]), float(source_coeff[name][1][yi, xi])) for name in names}


def calibrated_coefficients(source_coeff, lats, lons, stations, station_fit, names, decay_deg):
    """Apply residuals with coast-safe distance decay in complex space."""
    out = {name: (grid[0].copy(), grid[1].copy()) for name, grid in source_coeff.items()}
    for yi, lat in enumerate(lats):
        for xi, lon in enumerate(lons):
            weighted = []
            for station_id, fitted in station_fit.items():
                station = stations[station_id]
                dlat = float(lat) - float(station["lat"])
                dlon = (float(lon) - float(station["lon"])) * math.cos(math.radians(float(lat)))
                distance = math.hypot(dlat, dlon)
                weight = math.exp(-distance / max(decay_deg, 1e-6))
                weighted.append((weight, station, fitted))
            if not weighted:
                continue
            total = sum(item[0] for item in weighted)
            for ci, name in enumerate(names):
                residual_c = 0.0; residual_s = 0.0
                for weight, station, fitted in weighted:
                    base = station_model_coeff(source_coeff, lats, lons, station, names)[name]
                    residual_c += weight * (fitted[1 + 2 * ci] - base[0]) / total
                    residual_s += weight * (fitted[2 + 2 * ci] - base[1]) / total
                out[name][0][yi, xi] += residual_c
                out[name][1][yi, xi] += residual_s
    return out


def synthesize(coeff, names, times_h):
    values = np.zeros((len(times_h), *next(iter(coeff.values()))[0].shape))
    for name in names:
        omega = 2 * np.pi / PERIOD_HOURS[name]
        values += np.cos(omega * np.asarray(times_h))[:, None, None] * coeff[name][0]
        values += np.sin(omega * np.asarray(times_h))[:, None, None] * coeff[name][1]
    return values


def evaluate(payload, coeff, names, reference_ms, station_ids, start_ms, end_ms):
    stations = {str(s["id"]): s for s in payload.get("tides", {}).get("stations", [])}
    curves = payload.get("tides", {}).get("observed", {}) or payload.get("tides", {}).get("curves", {})
    rows = []; errors = []
    for station_id in station_ids:
        points = [p for p in curves.get(station_id, []) if start_ms <= epoch_ms(p["t"] if "t" in p else p["time"]) < end_ms]
        station = stations[station_id]
        yi = int(np.abs(np.asarray(payload["lats"]) - float(station["lat"])).argmin())
        xi = int(np.abs(np.asarray(payload["lons"]) - float(station["lon"])).argmin())
        pairs = []
        for p in points:
            t = epoch_ms(p["t"] if "t" in p else p["time"]); h = (t - reference_ms) / 3600000.0
            value = float(synthesize({name: (np.array([[coeff[name][0][yi, xi]]]), np.array([[coeff[name][1][yi, xi]]])) for name in names}, names, [h])[0, 0, 0])
            pairs.append((value, float(p["v"])))
        if not pairs:
            rows.append({"id": station_id, "samples": 0}); continue
        diff = np.asarray([observed - predicted for predicted, observed in pairs]); errors.extend(diff.tolist())
        rows.append({"id": station_id, "name": station["name"], "samples": len(diff),
                     "bias_ft": round(float(diff.mean()), 4), "rmse_ft": round(float(np.sqrt(np.mean(diff ** 2))), 4)})
    if not errors:
        return {"stations": rows, "samples": 0, "status": "fail"}
    errors = np.asarray(errors)
    return {"stations": rows, "samples": len(errors), "rmse_ft": round(float(np.sqrt(np.mean(errors ** 2))), 4),
            "mean_bias_ft": round(float(errors.mean()), 4), "stations_with_overlap": sum(r["samples"] > 0 for r in rows),
            "status": "pass"}


def benchmark_source(payload, source_coeff, source, names, reference_ms, station_ids, start_ms, end_ms):
    """Benchmark the untouched atlas using the same held-out window."""
    return evaluate(payload, source_coeff, names, reference_ms, station_ids, start_ms, end_ms)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", type=Path, help="normalized independent harmonic source JSON")
    ap.add_argument("payload", type=Path, help="forecast JSON containing stations/observations")
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--decay-deg", type=float, default=1.5)
    ap.add_argument("--min-stations", type=int, default=5)
    args = ap.parse_args()
    source = json.loads(args.source.read_text()); payload = json.loads(args.payload.read_text())
    names = [n for n in PERIOD_HOURS if n in source.get("constituents", {})]
    if len(names) < 4:
        raise SystemExit("need at least four independent constituents; refusing M2-only calibration")
    required = {"lats", "lons", "constituents"}
    if not required.issubset(source): raise SystemExit("source lacks normalized lats/lons/constituents contract")
    reference_ms = epoch_ms(payload["frames"][0]["time"])
    if list(map(float, source["lats"])) != list(map(float, payload["lats"])) or list(map(float, source["lons"])) != list(map(float, payload["lons"])):
        raise SystemExit("source and forecast grids differ; remap explicitly before calibration")
    obs = payload.get("tides", {}).get("observed", {}) or payload.get("tides", {}).get("curves", {})
    station_ids = [str(s["id"]) for s in payload.get("tides", {}).get("stations", []) if len(obs.get(str(s["id"]), [])) >= 12]
    if len(station_ids) < args.min_stations: raise SystemExit("insufficient station coverage")
    all_times = [epoch_ms(p["t"] if "t" in p else p["time"]) for sid in station_ids for p in obs.get(sid, [])]
    split_ms = int(np.median(all_times))
    source_coeff = source_coefficients(source, names)
    stations = {str(s["id"]): s for s in payload["tides"]["stations"]}
    loo_rows = []
    baseline = benchmark_source(payload, source_coeff, source, names, reference_ms,
                                station_ids, split_ms, max(all_times) + 1)
    for held_out in station_ids:
        train = [sid for sid in station_ids if sid != held_out]
        _, fits = station_residuals(payload, source, names, train, reference_ms, end_ms=split_ms)
        calibrated = calibrated_coefficients(source_coeff, source["lats"], source["lons"], stations, fits, names, args.decay_deg)
        result = evaluate(payload, calibrated, names, reference_ms, [held_out], split_ms, max(all_times) + 1)
        loo_rows.append({"held_out_station": held_out, **result})
    _, time_fits = station_residuals(payload, source, names, station_ids, reference_ms, end_ms=split_ms)
    calibrated = calibrated_coefficients(source_coeff, source["lats"], source["lons"], stations, time_fits, names, args.decay_deg)
    time_result = evaluate(payload, calibrated, names, reference_ms, station_ids, split_ms, max(all_times) + 1)
    loo_valid = [r for r in loo_rows if r.get("status") == "pass"]
    # Promotion is a no-regression decision, not merely a successful fit.
    # Every station must have a held-out result, and the aggregate calibrated
    # error must improve on the untouched atlas over the same time window.
    gate = (len(loo_valid) == len(station_ids) and len(station_ids) >= args.min_stations
            and time_result.get("status") == "pass"
            and time_result.get("rmse_ft", float("inf")) <= baseline.get("rmse_ft", float("inf")))
    report = {"status": "pass" if gate else "fail", "method": "complex constituent residual calibration",
              "constituents": names, "unmodified_baseline": baseline,
              "leave_one_station_out": loo_rows,
              "time_held_out": time_result, "held_out_stations": len(loo_valid),
              "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
              "source_model": source.get("model"), "offshore_independent": True,
              "promotion_gate": "all stations held out; chronological holdout; calibrated RMSE <= untouched baseline"}
    if not gate:
        print(json.dumps(report, indent=2)); raise SystemExit("refusing promotion: held-out gate failed")
    frames = []
    for frame in payload["frames"]:
        h = (epoch_ms(frame["time"]) - reference_ms) / 3600000.0
        grid = synthesize(calibrated, names, [h])[0]
        frame = dict(frame); frame["astronomical_tide_ft"] = grid.tolist()
        frames.append(frame)
    stack = np.asarray([f["astronomical_tide_ft"] for f in frames], dtype=float)
    tide_range = np.nanmax(stack, axis=0) - np.nanmin(stack, axis=0)
    range_json = np.where(np.isfinite(tide_range), tide_range, None).tolist()
    for frame in frames:
        frame["tide_range_ft"] = range_json
        frame["tide_amplitude_ft"] = np.where(np.isfinite(tide_range), tide_range / 2.0, np.nan).tolist()
        frame["tide_phase_deg"] = [[None for _ in payload["lons"]] for _ in payload["lats"]]
    out = dict(payload); out["frames"] = frames
    out["regional_tide_source"] = {"provider": source.get("provider"), "model": source.get("model"),
        "constituents": names, "method": report["method"], "validation": report,
        "offshore_independent": True}
    if source.get("wet_mask") is not None:
        out["tide_water_cells"] = source["wet_mask"]
    out.setdefault("quality", {})["co_tidal_source"] = f"{source.get('provider', 'independent')} {source.get('model', 'harmonic field')}; calibrated in complex constituent space"
    args.output.write_text(json.dumps(out, allow_nan=False, separators=(",", ":")))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
