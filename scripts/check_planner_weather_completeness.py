#!/usr/bin/env python3
"""Validate that both public planner forecasts contain every required weather grid."""
from __future__ import annotations
import datetime as dt
import json
import urllib.request

REGIONS = ("usec_md", "usec_south")
REQUIRED = {
    "pressure_hpa", "temperature_f", "apparent_temperature_f", "dew_point_f",
    "relative_humidity_pct", "cloud_cover_pct", "visibility_mi",
    "precipitation_in", "precipitation_probability_pct", "rain_in",
    "showers_in", "snowfall_in", "uv_index", "weather_code",
}

def get(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": "fishedge-planner-health/1"})
    with urllib.request.urlopen(req, timeout=20) as response:
        return json.load(response)

def main() -> int:
    failures = []
    for region in REGIONS:
        base = f"https://app.fishedge.live/trip-planner/data/{region}/briefing/"
        try:
            manifest = get(base + "forecast.json?health=" + str(int(dt.datetime.now(dt.timezone.utc).timestamp())))
            chunks = manifest.get("frames_manifest", {}).get("chunks", [])
            if not chunks:
                raise ValueError("frames_manifest missing")
            frames = []
            for chunk in chunks:
                frames.extend(get(base + "frames/" + chunk + "?health=1").get("frames", []))
            if not frames:
                raise ValueError("no forecast frames")
            missing = sorted(REQUIRED - set(frames[0]))
            bad = [key for key in REQUIRED if any(not isinstance(frame.get(key), list) for frame in frames)]
            print(f"{region}: generated={manifest.get('generated_at')} frames={len(frames)} missing={missing} malformed={bad}")
            if missing or bad:
                failures.append(region)
        except Exception as exc:
            print(f"{region}: ERROR {exc}")
            failures.append(region)
    if failures:
        print("PLANNER_WEATHER_COMPLETENESS_FAILED:" + ",".join(failures))
        return 2
    print("PLANNER_WEATHER_COMPLETENESS_OK")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
