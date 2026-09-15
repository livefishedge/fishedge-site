#!/usr/bin/env python3
"""Refresh CO-OPS station predictions/observations without rebuilding waves.

This deliberately replaces only ``forecast.tides``.  The existing wave
frames, shoreline mask contract, and tide model grids are left untouched so a
measurement refresh cannot silently change the forecast model.
"""
import argparse
import json
from pathlib import Path
import sys

from fetch_wave_openmeteo import fetch_all_tides


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()
    tides = fetch_all_tides()
    expected = {str(s["id"]) for s in tides.get("stations", [])}
    if set(tides.get("observed", {})) != expected:
        missing = sorted(expected - set(tides.get("observed", {})))
        raise SystemExit(f"refusing partial measurement refresh; missing: {missing}")
    for path in args.paths:
        payload = json.loads(path.read_text())
        payload["tides"] = tides
        path.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
        print(f"refreshed {len(expected)} CO-OPS measurement series: {path}")


if __name__ == "__main__":
    main()
