#!/usr/bin/env python3
"""Fail closed when a published thermal-front source is stale or malformed."""
from __future__ import annotations

import datetime as dt
import json
import sys
import urllib.request

MAX_AGE_HOURS = 6
REGIONS = ("usec_md", "usec_south")

def main() -> int:
    now = dt.datetime.now(dt.timezone.utc)
    failures = []
    for region in REGIONS:
        url = f"https://app.fishedge.live/dashboard/index-{region}.json?health={int(now.timestamp())}"
        try:
            request = urllib.request.Request(url, headers={"User-Agent": "fishedge-thermal-health/1"})
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.load(response)
            frames = payload.get("frames", {}).get("sst_front", [])
            times = [dt.datetime.fromisoformat(f["time_iso"].replace("Z", "+00:00")) for f in frames if f.get("time_iso")]
            latest = max(times) if times else None
            age = None if latest is None else (now - latest).total_seconds() / 3600
            print(f"{region}: latest={latest.isoformat() if latest else 'NONE'} age_hours={age if age is not None else 'NA'}")
            if latest is None or age > MAX_AGE_HOURS:
                failures.append(region)
        except Exception as exc:
            print(f"{region}: ERROR {exc}")
            failures.append(region)
    if failures:
        print("THERMAL_FRONT_FRESHNESS_FAILED:" + ",".join(failures))
        return 2
    print("THERMAL_FRONT_FRESHNESS_OK")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
