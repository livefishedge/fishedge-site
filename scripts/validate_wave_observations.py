#!/usr/bin/env python3
"""Compare forecast wave fields with nearby public NDBC buoy observations.

This is a validation report, not a calibration step. It deliberately reports
the comparison without changing forecast values.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
payload = json.loads((ROOT / "data/usec_md/briefing/forecast.json").read_text())
stations = {
    "44009": (38.46, -74.70, "Delaware Bay offshore"),
    "44025": (39.09, -73.65, "Long Island offshore"),
}

def parse_time(row):
    return datetime.strptime(" ".join(row[:5]), "%Y %m %d %H %M").replace(tzinfo=timezone.utc)

def nearest_frame(dt):
    return min(payload["frames"], key=lambda f: abs(datetime.fromisoformat(f["time"].replace("Z", "+00:00")) - dt))

def nearest_grid(lat, lon):
    yi = min(range(len(payload["lats"])), key=lambda i: abs(payload["lats"][i] - lat))
    xi = min(range(len(payload["lons"])), key=lambda i: abs(payload["lons"][i] - lon))
    return yi, xi

report = []
for station, (lat, lon, label) in stations.items():
    text = requests.get(f"https://www.ndbc.noaa.gov/data/realtime2/{station}.txt", timeout=30).text
    lines = [line.split() for line in text.splitlines() if line and not line.startswith("#")]
    valid = [row for row in lines if len(row) >= 13 and row[8] != "MM" and row[9] != "MM"]
    if not valid:
        report.append({"station": station, "label": label, "status": "no_recent_wave_observation"})
        continue
    row = valid[0]
    observed_time = parse_time(row)
    frame = nearest_frame(observed_time)
    yi, xi = nearest_grid(lat, lon)
    obs_height_ft = float(row[8]) * 3.28084
    obs_period_s = float(row[9])
    forecast_height_ft = frame["wave_height_ft"][yi][xi]
    forecast_period_s = frame["wave_period_s"][yi][xi]
    report.append({
        "station": station, "label": label, "status": "comparison_only",
        "observation_time": observed_time.isoformat(), "forecast_time": frame["time"],
        "distance_to_nearest_display_grid_deg": round(max(abs(payload["lats"][yi] - lat), abs(payload["lons"][xi] - lon)), 4),
        "observed": {"significant_wave_height_ft": round(obs_height_ft, 2), "dominant_period_s": obs_period_s},
        "forecast": {"significant_wave_height_ft": forecast_height_ft, "wave_period_s": forecast_period_s},
    })
print(json.dumps({"source": "NOAA NDBC realtime2", "interpretation": "spot check only; buoy and coarse display grid are not collocated", "comparisons": report}, indent=2))
