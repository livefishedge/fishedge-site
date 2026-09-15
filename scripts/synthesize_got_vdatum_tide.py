#!/usr/bin/env python3
"""Synthesize UTC astronomical tide frames from a normalized harmonic blend.

The input format is the output of ``build_got_vdatum_blend.py``: amplitudes
and phase lags are in feet and degrees on a WGS84 grid.  This implements the
standard harmonic summation with explicit equilibrium arguments and nodal
factors.  MSL is the default output datum; ``--datum MLLW`` adds the supplied
VDatum MSL-to-MLLW field.  No station data are used to create the field.
"""
import argparse
import datetime as dt
import json
from pathlib import Path

import numpy as np

PERIOD_HOURS = {"M2": 12.4206012, "S2": 12.0, "N2": 12.6583475,
                "K2": 11.967236, "K1": 23.934472, "O1": 25.819338,
                "P1": 24.06589, "Q1": 26.86835}


def jd2000(t):
    return (t - dt.datetime(2000, 1, 1, 12, tzinfo=dt.timezone.utc)).total_seconds() / 86400.0


def astro(t):
    """Return approximate equilibrium arguments in degrees.

    These are the conventional low-order astronomical arguments; all values
    are reduced to [0, 360). Constituent phase conventions must be declared by
    the source adapter and are not silently changed here.
    """
    T = jd2000(t) / 36525.0
    s = 218.3164477 + 481267.88123421*T - .0015786*T*T
    h = 280.46645 + 36000.7697489*T + .0003032*T*T
    p = 83.3532465 + 4069.0137287*T - .0103200*T*T
    N = 125.044555 - 1934.1361849*T + .0020762*T*T
    return {"s": s % 360.0, "h": h % 360.0, "p": p % 360.0, "N": N % 360.0}


def nodal(name, N):
    n = np.deg2rad(N)
    c1, c2 = np.cos(n), np.cos(2*n)
    s1, s2 = np.sin(n), np.sin(2*n)
    if name in ("M2", "N2"):
        return 1 - .03731*c1 + .00052*c2, -2.14*s1 + .20*s2
    if name == "K2":
        return 1 + .285*c1 + .0324*c2, -2.14*s1 + .20*s2
    if name == "O1":
        return 1 + .189*c1 - .0058*c2, 10.8*s1 - 1.3*s2
    if name == "K1":
        return 1 + .1158*c1 - .0029*c2, -8.9*s1 + .3*s2
    return 1.0, 0.0


def equilibrium(name, a):
    # Doodson-style equilibrium arguments for the supported principal waves.
    # The source phase lag is retained in the final ``... - phi`` term.
    s, h, p = a["s"], a["h"], a["p"]
    return {"M2": 2*s - 2*h, "S2": 2*h, "N2": 2*s - 2*h - p,
            "K2": 2*h + 2*s*0, "K1": s + h - 90,
            "O1": s - 2*h + 90, "P1": h - 90,
            "Q1": s - 3*h + p + 90}[name] % 360.0


def safe_grid(item, key, shape):
    values = np.asarray(item[key], dtype=float)
    if values.shape != shape:
        raise SystemExit(f"{key} shape {values.shape} != {shape}")
    return values


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("source", type=Path)
    ap.add_argument("--start", required=True, help="UTC ISO timestamp, e.g. 2026-09-01T00:00:00Z")
    ap.add_argument("--hours", type=int, default=181)
    ap.add_argument("--step-hours", type=float, default=1.0)
    ap.add_argument("--datum", choices=("MSL", "MLLW"), default="MSL")
    ap.add_argument("--output", required=True, type=Path)
    args = ap.parse_args()
    source = json.loads(args.source.read_text())
    lats, lons = source.get("lats"), source.get("lons")
    if not lats or not lons:
        raise SystemExit("source lacks lats/lons")
    shape = (len(lats), len(lons))
    names = [n for n in PERIOD_HOURS if n in source.get("constituents", {})]
    if len(names) < 4:
        raise SystemExit("need at least four constituents")
    constituents = {}
    for name in names:
        item = source["constituents"][name]
        amp = safe_grid(item, "amplitude_ft", shape)
        phase = safe_grid(item, "phase_deg", shape)
        constituents[name] = (amp, phase)
    datum = np.zeros(shape, dtype=float)
    if args.datum == "MLLW":
        datum = np.asarray(source.get("vdatum_msl_to_mllw_ft"), dtype=float)
        if datum.shape != shape:
            raise SystemExit("MLLW requested but source lacks a matching VDatum offset grid")
    start = dt.datetime.fromisoformat(args.start.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
    frames = []
    for index in range(args.hours):
        timestamp = start + dt.timedelta(hours=index * args.step_hours)
        hours = (timestamp - start).total_seconds() / 3600.0
        arguments = astro(timestamp)
        tide = np.zeros(shape, dtype=float)
        for name in names:
            amp, phase = constituents[name]
            f, u = nodal(name, arguments["N"])
            theta = np.deg2rad(360.0 * hours / PERIOD_HOURS[name] + equilibrium(name, arguments) + u - phase)
            tide += f * amp * np.cos(theta)
        tide += datum
        wet = np.isfinite(tide)
        frames.append({"time": timestamp.isoformat().replace("+00:00", "Z"),
                       "astronomical_tide_ft": np.where(wet, tide, None).tolist()})
    stack = np.asarray([[[np.nan if v is None else v for v in row]
                         for row in frame["astronomical_tide_ft"]] for frame in frames], dtype=float)
    ranges = np.nanmax(stack, axis=0) - np.nanmin(stack, axis=0)
    for frame in frames:
        frame["tide_range_ft"] = np.where(np.isfinite(ranges), ranges, None).tolist()
        frame["tide_amplitude_ft"] = np.where(np.isfinite(ranges), ranges / 2.0, None).tolist()
    if not np.isfinite(stack).any():
        raise SystemExit("no finite synthesized tide values")
    output = {"source": source.get("source"), "provider": source.get("provider"),
              "model": source.get("model"), "datum": args.datum,
              "lats": lats, "lons": lons, "frames": frames,
              "constituents": names, "range_definition": f"max-min over {args.hours} frames",
              "provenance": source.get("provenance", {}),
              "prediction_contract": "UTC nodal harmonic summation; CO-OPS not used in field"}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, allow_nan=False, separators=(",", ":")) + "\n")
    print(json.dumps({"output": str(args.output), "frames": len(frames), "datum": args.datum,
                      "constituents": names, "range_ft": [float(np.nanmin(ranges)), float(np.nanmax(ranges))]}, indent=2))


if __name__ == "__main__":
    main()
