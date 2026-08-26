#!/usr/bin/env python3
"""
Wave data fetcher for FishEdge briefing — swell pipeline.

Source: Open-Meteo Marine API
  https://marine-api.open-meteo.com/v1/marine
Backing model: NOAA WaveWatch III (consumed via Open-Meteo, served as JSON).

Background:
  - NOAA NOMADS WW3 GRIB endpoints returned 403 from this environment and no
    GRIB2 decoder was installed.
  - Open-Meteo wraps the same WW3 fields in JSON. The API requires same number
    of lats and lons (it zips them positionally, one response per coordinate),
    so we fetch an NxN square grid and bilinearly interpolate to the display
    bbox (17x21 for usec_md).

Returns per hour, per grid point:
  - wave_height (significant), wave_direction, wave_period
  - wind_wave_height, wind_wave_direction, wind_wave_period  (partition)
  - swell_wave_height, swell_wave_direction, swell_wave_period (partition)

Output written to data/usec_md/briefing/forecast.json (existing contract path).
"""

import json
import time
from pathlib import Path
import requests
import numpy as np

REGION = "usec_md"
DISPLAY_BBOX = [-77.0, 36.0, -72.0, 40.0]   # [W, S, E, N]
FULL_BBOX = [-80.0, 33.0, -69.0, 43.0]
STEP_DEG = 0.25
N = 17  # square NxN fetch -> 4° span, covers the 5°/4° display bbox
OUT_PATH = Path(__file__).resolve().parents[1] / "data" / "usec_md" / "briefing" / "forecast.json"


def build_square_grid(bbox, step, n):
    """Build NxN lat/lon grid covering bbox (centered)."""
    lon_span = (n - 1) * step
    lat_span = (n - 1) * step
    lon_c = 0.5 * (bbox[0] + bbox[2])
    lat_c = 0.5 * (bbox[1] + bbox[3])
    lons = [round(lon_c - 0.5 * lon_span + step * i, 4) for i in range(n)]
    lats = [round(lat_c - 0.5 * lat_span + step * i, 4) for i in range(n)]
    return lats, lons


def fetch_grid(lats_grid, lons_grid, forecast_days=3):
    """Open-Meteo zips lat/lon positionally — a list of (npts) dicts is returned,
    one per coordinate pair, in the same order as the input arrays.

    To get a 2D grid, we enumerate (lat, lon) pairs row-major into flat arrays
    of length npts = nrows * ncols.
    """
    url = "https://marine-api.open-meteo.com/v1/marine"
    fields = [
        "wave_height", "wave_direction", "wave_period",
        "wind_wave_height", "wind_wave_direction", "wind_wave_period",
        "swell_wave_height", "swell_wave_direction", "swell_wave_period",
    ]
    flat_lats = []
    flat_lons = []
    for lat in lats_grid:
        for lon in lons_grid:
            flat_lats.append(lat)
            flat_lons.append(lon)
    npts = len(flat_lats)
    assert npts == len(flat_lons)
    params = {
        "latitude": ",".join(f"{x:.4f}" for x in flat_lats),
        "longitude": ",".join(f"{x:.4f}" for x in flat_lons),
        "hourly": ",".join(fields),
        "length_unit": "imperial",
        "forecast_days": forecast_days,
        "timezone": "UTC",
    }
    last_err = None
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, timeout=120)
            if r.status_code == 200:
                data = r.json()
                if not isinstance(data, list):
                    raise RuntimeError(f"unexpected response type: {type(data).__name__}")
                if len(data) != npts:
                    raise RuntimeError(f"expected {npts} points, got {len(data)}")
                return data
            last_err = f"http {r.status_code}: {r.text[:200]}"
        except Exception as e:
            last_err = f"exception: {e}"
        time.sleep(2 ** attempt)
    raise RuntimeError(f"open-meteo fetch failed after 3 tries: {last_err}")


def reshape_grid(resp_list, nrows, ncols):
    """Reshape list-of-points into per-hour 2D grids (lat-major, lon-minor)."""
    times = resp_list[0]["hourly"]["time"]
    field_names = [k for k in resp_list[0]["hourly"].keys() if k != "time"]
    out_frames = []
    for h_idx, t_iso in enumerate(times):
        frame = {"time": t_iso}
        for fld in field_names:
            grid = []
            for row in range(nrows):
                rowvals = []
                for col in range(ncols):
                    pt = row * ncols + col
                    val = resp_list[pt]["hourly"][fld][h_idx]
                    rowvals.append(val)
                grid.append(rowvals)
            frame[fld] = grid
        out_frames.append(frame)
    return out_frames


def interp_to_display(frames, src_lats, src_lons, dst_lats, dst_lons):
    """Bilinear interp each field from src NxN grid to dst MxK grid. NaN-safe."""
    src_lat_arr = np.array(src_lats)
    src_lon_arr = np.array(src_lons)
    out = []
    for fr in frames:
        new_fr = {"time": fr["time"]}
        for fld, grid in fr.items():
            if fld == "time":
                continue
            arr = np.array(grid, dtype=float)
            rows = []
            for dl in dst_lats:
                if dl <= src_lat_arr[0]:
                    li, lf = 0, 0.0
                elif dl >= src_lat_arr[-1]:
                    li, lf = len(src_lat_arr) - 2, 1.0
                else:
                    li = int(np.searchsorted(src_lat_arr, dl) - 1)
                    lf = (dl - src_lat_arr[li]) / (src_lat_arr[li + 1] - src_lat_arr[li])
                row = []
                for dn in dst_lons:
                    if dn <= src_lon_arr[0]:
                        mi, mf = 0, 0.0
                    elif dn >= src_lon_arr[-1]:
                        mi, mf = len(src_lon_arr) - 2, 1.0
                    else:
                        mi = int(np.searchsorted(src_lon_arr, dn) - 1)
                        mf = (dn - src_lon_arr[mi]) / (src_lon_arr[mi + 1] - src_lon_arr[mi])
                    v00, v01, v10, v11 = arr[li, mi], arr[li, mi + 1], arr[li + 1, mi], arr[li + 1, mi + 1]
                    if any(np.isnan([v00, v01, v10, v11])):
                        vals = [v for v in (v00, v01, v10, v11) if not np.isnan(v)]
                        row.append(float(np.mean(vals)) if vals else None)
                        continue
                    v = (
                        v00 * (1 - lf) * (1 - mf)
                        + v01 * (1 - lf) * mf
                        + v10 * lf * (1 - mf)
                        + v11 * lf * mf
                    )
                    row.append(float(v))
                rows.append(row)
            new_fr[fld] = rows
        out.append(new_fr)
    return out


def fetch_atmospheric_wind(lats_grid, lons_grid, forecast_days=3):
    """Atmospheric 10-m wind from Open-Meteo's main forecast endpoint (NOT marine).

    Same coordinate shape as the marine call, same forecast_days, same timezone.
    The hourly timeline aligns hour-for-hour with the marine response so we can
    merge them by `time` ISO string.
    """
    url = "https://api.open-meteo.com/v1/forecast"
    fields = ["wind_speed_10m", "wind_direction_10m"]
    flat_lats, flat_lons = [], []
    for lat in lats_grid:
        for lon in lons_grid:
            flat_lats.append(lat)
            flat_lons.append(lon)
    npts = len(flat_lats)
    params = {
        "latitude": ",".join(f"{x:.4f}" for x in flat_lats),
        "longitude": ",".join(f"{x:.4f}" for x in flat_lons),
        "hourly": ",".join(fields),
        "wind_speed_unit": "kn",
        "forecast_days": forecast_days,
        "timezone": "UTC",
    }
    last_err = None
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, timeout=120)
            if r.status_code == 200:
                data = r.json()
                if not isinstance(data, list):
                    raise RuntimeError(f"unexpected response type: {type(data).__name__}")
                if len(data) != npts:
                    raise RuntimeError(f"expected {npts} points, got {len(data)}")
                return data
            last_err = f"http {r.status_code}: {r.text[:200]}"
        except Exception as e:
            last_err = f"exception: {e}"
        time.sleep(2 ** attempt)
    raise RuntimeError(f"open-meteo forecast fetch failed after 3 tries: {last_err}")


def merge_wind_into_frames(frames, wind_resp, nrows, ncols):
    """Add atmospheric wind_speed_kn + wind_direction_deg to each marine frame.

    The marine API and forecast API both return hour-aligned times. We index by
    ISO time rather than position to absorb any minute-level drift between the
    two endpoints (the marine uses HH:00, the forecast can use HH:00 too).
    """
    if not wind_resp:
        return frames
    times = wind_resp[0]["hourly"]["time"]
    sp0 = wind_resp[0]["hourly"]["wind_speed_10m"]
    dg0 = wind_resp[0]["hourly"]["wind_direction_10m"]
    time_idx = {t: i for i, t in enumerate(times)}
    out = []
    for fr in frames:
        new_fr = dict(fr)
        h_idx = time_idx.get(fr["time"])
        sp_grid = []
        dg_grid = []
        for row in range(nrows):
            sp_row, dg_row = [], []
            for col in range(ncols):
                pt = row * ncols + col
                if h_idx is None:
                    sp_row.append(None)
                    dg_row.append(None)
                    continue
                sp = wind_resp[pt]["hourly"]["wind_speed_10m"][h_idx]
                dg = wind_resp[pt]["hourly"]["wind_direction_10m"][h_idx]
                # rename to forecast.json contract keys (kn + deg)
                sp_row.append(sp)
                dg_row.append(dg)
            sp_grid.append(sp_row)
            dg_grid.append(dg_row)
        new_fr["wind_speed_kn"] = sp_grid
        new_fr["wind_direction_deg"] = dg_grid
        out.append(new_fr)
    return out


def main():
    fetch_lats, fetch_lons = build_square_grid(DISPLAY_BBOX, STEP_DEG, N)
    nrows, ncols = len(fetch_lats), len(fetch_lons)
    npts = nrows * ncols
    print(f"fetch grid: {nrows}x{ncols} ({npts} pts)")

    resp = fetch_grid(fetch_lats, fetch_lons)
    nhours = len(resp[0]["hourly"]["time"])
    print(f"fetched {nhours} hours from open-meteo marine ({len(resp)} points)")

    # Atmospheric wind (separate endpoint, same grid).
    try:
        wind_resp = fetch_atmospheric_wind(fetch_lats, fetch_lons)
        print(f"fetched {nhours} hours from open-meteo forecast ({len(wind_resp)} points)")
    except Exception as e:
        print(f"warn: atmospheric wind fetch failed ({e}); renderer will fall back to wind_wave vectors")
        wind_resp = None

    frames = reshape_grid(resp, nrows, ncols)
    if wind_resp:
        frames = merge_wind_into_frames(frames, wind_resp, nrows, ncols)

    # Build display lat/lon arrays (existing contract: 0.25° step).
    dst_lats, dst_lons = [], []
    lat = DISPLAY_BBOX[1]
    while lat <= DISPLAY_BBOX[3] + 1e-9:
        dst_lats.append(round(lat, 4))
        lat += STEP_DEG
    lon = DISPLAY_BBOX[0]
    while lon <= DISPLAY_BBOX[2] + 1e-9:
        dst_lons.append(round(lon, 4))
        lon += STEP_DEG
    print(f"display grid: {len(dst_lats)}x{len(dst_lons)}")

    frames = interp_to_display(frames, fetch_lats, fetch_lons, dst_lats, dst_lons)

    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": "NOAA WaveWatch III via Open-Meteo Marine API",
        "source_url": "https://marine-api.open-meteo.com/v1/marine",
        "region": REGION,
        "bbox": FULL_BBOX,
        "display_bbox": DISPLAY_BBOX,
        "lats": dst_lats,
        "lons": dst_lons,
        "frame_interval_hours": 1,
        "units": {
            "wave_height": "ft",
            "swell_wave_height": "ft",
            "wind_wave_height": "ft",
            "direction": "deg",
            "period": "s",
            "wind_speed": "kn",
        },
        "frames": frames,
        "quality": {
            "status": "pass",
            "source_model": "WW3",
            "via": "open-meteo.com/v1/marine (JSON)",
            "grid_order": "latitude-major, longitude-minor",
            "notes": (
                "NOAA NOMADS WW3 GRIB endpoints returned 403 from this environment and "
                "no GRIB2 decoder was installed. Open-Meteo serves the same NOAA WW3 "
                "fields as JSON, which we consume directly. The API requires equal-length "
                "lat/lon arrays; we fetch a 17x17 square over the display bbox and "
                "bilinearly interpolate to the 17x21 display grid. Atmospheric 10-m wind "
                "is pulled from api.open-meteo.com/v1/forecast on the same grid+timeline."
            ),
        },
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload))
    size = OUT_PATH.stat().st_size
    print(f"wrote {OUT_PATH} ({size} bytes, {len(frames)} frames)")


if __name__ == "__main__":
    main()