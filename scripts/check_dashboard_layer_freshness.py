#!/usr/bin/env python3
"""Fail closed when any operational dashboard layer is stale or absent."""
from __future__ import annotations
import datetime as dt
import json
import urllib.request

REGIONS = ("usec_md", "usec_south")
# SLA/UV are daily CMEMS products; satellite SST/fronts are hourly-ish.
MAX_AGE_HOURS = {"sst": 6, "sst_front": 6, "uv": 36, "sla": 36, "chl": 72, "chl_front": 72}

def main() -> int:
    now = dt.datetime.now(dt.timezone.utc)
    failures = []
    for region in REGIONS:
        url = f"https://app.fishedge.live/dashboard/index-{region}.json?health={int(now.timestamp())}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "fishedge-layer-health/1"})
            with urllib.request.urlopen(req, timeout=20) as response:
                payload = json.load(response)
        except Exception as exc:
            print(f"{region}: INDEX_ERROR {exc}")
            failures.append(f"{region}:index")
            continue
        for layer, limit in MAX_AGE_HOURS.items():
            frames = payload.get("frames", {}).get(layer, [])
            times = []
            for frame in frames:
                stamp = frame.get("time_iso")
                if stamp:
                    try: times.append(dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")))
                    except ValueError: pass
            latest = max(times) if times else None
            age = None if latest is None else (now - latest).total_seconds() / 3600
            print(f"{region} {layer}: latest={latest.isoformat() if latest else 'NONE'} age_hours={age if age is not None else 'NA'} limit={limit}")
            if latest is None or age > limit:
                failures.append(f"{region}:{layer}")
    if failures:
        print("DASHBOARD_LAYER_FRESHNESS_FAILED:" + ",".join(failures))
        return 2
    print("DASHBOARD_LAYER_FRESHNESS_OK")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
