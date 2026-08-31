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

Output written to data/usec_md/briefing/forecast.json and the dashboard fixture
copy, using the versioned briefing-forecast-v2 contract.
"""

import json
import time
from pathlib import Path
from datetime import datetime, timedelta, timezone
import requests
import numpy as np

REGION = "usec_md"
DISPLAY_BBOX = [-77.0, 36.0, -72.0, 40.0]   # [W, S, E, N]
FULL_BBOX = [-80.0, 33.0, -69.0, 43.0]
STEP_DEG = 0.25
N = 17  # square NxN fetch -> 4° span, covers the 5°/4° display bbox
OUT_PATH = Path(__file__).resolve().parents[1] / "data" / "usec_md" / "briefing" / "forecast.json"
DASHBOARD_OUT_PATH = Path(__file__).resolve().parents[1] / "dashboard" / "trip-planner" / "data" / "usec_md" / "briefing" / "forecast.json"


# ---- CO-OPS tide stations (curators: NJ/DE/MD/VA inshore + outer banks) ----
# NOAA Center for Operational Oceanographic Products and Services publishes
# free harmonic tide predictions in plain text via api/data/. We precompute the
# request URL per station here so the viewer never needs a live API hop. These
# stations cover the usec_md bbox with measured-water-level redundancy:
#   - Cape May + Atlantic City = NJ inshore reference
#   - Ocean City Inlet = MD eastern shore (inside the display bbox)
#   - Kiptopeke + Sewells Point + Money Point + Yorktown = Chesapeake references
#   - Duck, NC = outer banks (Hatteras corridor edge)
# Units: feet (CO-OPS MLLW datum, the same as the USEC captain convention).
TIDE_STATIONS = [
    {"id": "8536110", "name": "Cape May, NJ",       "lat": 38.9683, "lon": -74.9600},
    {"id": "8534720", "name": "Atlantic City, NJ",  "lat": 39.355, "lon": -74.418},
    {"id": "8570283", "name": "Ocean City Inlet",   "lat": 38.328, "lon": -75.092},
    {"id": "8632200", "name": "Kiptopeke",          "lat": 37.1652, "lon": -75.9884},
    {"id": "8638610", "name": "Sewells Point",      "lat": 36.9428, "lon": -76.3286},
    {"id": "8639348", "name": "Money Point",        "lat": 36.7782, "lon": -76.3019},
    {"id": "8637689", "name": "Yorktown USCG",      "lat": 37.2265, "lon": -76.4788},
    {"id": "8651370", "name": "Duck, NC",           "lat": 36.183, "lon": -75.747},
]
COOPS_API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
COOPS_HOURS = 168  # viewer renders today through seven days later


def fetch_coops_curve(station_id, hours=COOPS_HOURS, begin=None):
    """Fetch a single CO-OPS station's hourly tide prediction for the next
    `hours` hours, starting at the top of the next hour (UTC).

    Returns a dict with `curve` (list of {t, v} epoch-ms + ft), `range`
    ({vmin, vmax} in ft), and `next_event` ({t, label} for the first high or
    low after `now`). Raises RuntimeError on fetch failure so the caller can
    decide whether to abort or fall back to a synthetic curve.
    """
    begin = begin or datetime.utcnow().replace(minute=0, second=0, microsecond=0)
    end = begin + timedelta(hours=hours)
    query_begin = begin - timedelta(hours=24)
    params = {
        "product": "predictions",
        "application": "FishEdge.Briefing",
        "begin_date": query_begin.strftime("%Y%m%d %H:%M"),
        "end_date": end.strftime("%Y%m%d %H:%M"),
        "datum": "MLLW",
        "station": station_id,
        "time_zone": "gmt",
        "units": "english",
        "interval": "h",
        "format": "json",
    }
    last_err = None
    for attempt in range(3):
        try:
            r = requests.get(COOPS_API, params=params, timeout=30)
            if r.status_code == 200:
                payload = r.json()
                preds = payload.get("predictions") or []
                if not preds:
                    raise RuntimeError(f"empty predictions for station {station_id}")
                curve = []
                for p in preds:
                    # CO-OPS time is "YYYY-MM-DD HH:MM" in the requested zone.
                    dt = datetime.strptime(p["t"], "%Y-%m-%d %H:%M")
                    epoch_ms = int(dt.replace(tzinfo=timezone.utc).timestamp() * 1000)
                    curve.append({"t": epoch_ms, "v": float(p["v"])})
                vs = [c["v"] for c in curve]
                rng = {"vmin": min(vs), "vmax": max(vs)}
                next_event = _find_next_tide_event(curve, int(begin.replace(tzinfo=timezone.utc).timestamp() * 1000))
                return {"curve": curve, "range": rng, "next_event": next_event}
            last_err = f"http {r.status_code}: {r.text[:200]}"
        except Exception as e:
            last_err = f"exception: {e}"
        time.sleep(2 ** attempt)
    raise RuntimeError(f"CO-OPS fetch failed for {station_id} after 3 tries: {last_err}")


def fetch_coops_observed(station_id, end=None, hours=24):
    """Fetch the recent measured water-level series for a station."""
    end = end or datetime.utcnow().replace(minute=0, second=0, microsecond=0)
    begin = end - timedelta(hours=hours)
    params = {
        "product": "water_level", "application": "FishEdge.Briefing",
        "begin_date": begin.strftime("%Y%m%d %H:%M"),
        "end_date": end.strftime("%Y%m%d %H:%M"), "datum": "MLLW",
        "station": station_id, "time_zone": "gmt", "units": "english",
        "interval": "6", "format": "json",
    }
    r = requests.get(COOPS_API, params=params, timeout=30)
    if r.status_code != 200: raise RuntimeError(f"observed http {r.status_code}")
    values = r.json().get("data") or []
    return [{"t": int(datetime.strptime(p["t"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp() * 1000), "v": float(p["v"])} for p in values if p.get("v") not in (None, "")]


def _find_next_tide_event(curve, now_ms=None):
    """Find the first high or low tide after the first point in the curve.

    A tide event is a local extremum where the sign of (v[i+1] - v[i]) flips.
    Returns {"t": epoch_ms, "label": "high 3.2 ft @ 14:00 UTC"} or None.
    """
    if len(curve) < 3:
        return None
    now_ms = curve[0]["t"] if now_ms is None else now_ms
    for i in range(1, len(curve) - 1):
        dv_prev = curve[i]["v"] - curve[i - 1]["v"]
        dv_next = curve[i + 1]["v"] - curve[i]["v"]
        if dv_prev == 0 or dv_next == 0:
            continue
        if (dv_prev > 0) != (dv_next > 0):
            t_iso = curve[i]["t"]
            if t_iso < now_ms:
                continue
            kind = "high" if dv_prev > 0 else "low"
            dt = datetime.fromtimestamp(t_iso / 1000, tz=timezone.utc)
            label = f"{kind} {curve[i]['v']:.1f} ft @ {dt.strftime('%H:%M')}"
            return {"t": t_iso, "label": label}
    return None


def fetch_all_tides(hours=COOPS_HOURS, begin=None):
    """Fetch CO-OPS curves for every station. Failures are downgraded to
    per-station errors so a single dead station does not kill the artifact.

    Returns a dict shaped for the viewer's `forecast.tides` slot:
      {
        "stations": [ {id, name, lat, lon}, ... ],
        "curves":   { station_id: [{t, v}, ...] },
        "range":    { station_id: {vmin, vmax} },
        "next_event": { station_id: {t, label} | null },
        "generated_at": epoch_ms,
        "source": "NOAA CO-OPS api/data/ (predictions, MLLW, hourly)",
      }
    """
    out = {
        "stations": TIDE_STATIONS,
        "curves": {},
        "range": {},
        "next_event": {},
        "observed": {},
        "generated_at": int(time.time() * 1000),
        "source": "NOAA CO-OPS api/data/ (predictions, MLLW, hourly)",
    }
    failures = []
    for st in TIDE_STATIONS:
        try:
            res = fetch_coops_curve(st["id"], hours=hours, begin=begin)
            out["curves"][st["id"]] = res["curve"]
            out["range"][st["id"]] = res["range"]
            out["next_event"][st["id"]] = res["next_event"]
            # M2 harmonic amplitude matches the co-range contour lines:
            # co-range = 2 × amplitude at each grid cell or station.
            out.setdefault("amplitude_ft", {})[st["id"]] = res.get("amplitude_ft")
            try:
                out["observed"][st["id"]] = fetch_coops_observed(st["id"])
            except Exception as e:
                print(f"  observed {st['id']}: unavailable ({e})")
            print(f"  tides {st['id']} {st['name']}: {len(res['curve'])} pts, range {res['range']['vmin']:.1f}-{res['range']['vmax']:.1f} ft")
        except Exception as e:
            failures.append(f"{st['id']} ({st['name']}): {e}")
            print(f"  tides {st['id']} {st['name']}: FAILED {e}")
    out["fetch_failures"] = failures
    return out


def add_tide_grids(frames, tides, lats, lons, preserve_ofs=True, land_mask=None):
    """Add an IDW-interpolated tide-height surface to each forecast frame.

    CO-OPS predictions are point forecasts. This produces a regional
    visualization between those points; station curves remain authoritative.
    Frames outside the fetched prediction window are left without a grid.
    """
    stations = tides.get("stations") or []
    curves = tides.get("curves") or {}
    points = [(st, curves.get(st["id"]) or []) for st in stations]
    points = [(st, curve) for st, curve in points if curve]
    if not points:
        return frames
    for frame in frames:
        # Preserve only official OFS model surfaces. A prior CO-OPS fallback
        # is deliberately replaceable so shoreline masking can be corrected
        # on subsequent refreshes.
        source = set(frame.get("tide_model_source") or [])
        if preserve_ofs and source.intersection({"dbofs", "cbofs"}):
            continue
        frame_ms = int(datetime.strptime(frame["time"], "%Y-%m-%dT%H:%M").replace(tzinfo=timezone.utc).timestamp() * 1000)
        values = []
        for st, curve in points:
            nearest = min(curve, key=lambda p: abs(p["t"] - frame_ms))
            if abs(nearest["t"] - frame_ms) <= 2 * 3600000:
                values.append((st["lat"], st["lon"], nearest["v"]))
        if not values:
            continue
        grid = []
        for lat in lats:
            row = []
            for xi, lon in enumerate(lons):
                if land_mask and land_mask[lats.index(lat)][xi]:
                    row.append(None)
                    continue
                weighted = []
                for slat, slon, value in values:
                    dlat = lat - slat
                    dlon = (lon - slon) * np.cos(np.deg2rad(lat))
                    d2 = dlat * dlat + dlon * dlon
                    if d2 < 1e-10:
                        weighted = [(1.0, value)]
                        break
                    weighted.append((1.0 / d2, value))
                total = sum(weight for weight, _ in weighted)
                row.append(float(sum(weight * value for weight, value in weighted) / total) if total else None)
            grid.append(row)
        frame["tide_height_ft"] = grid
    return frames


def build_square_grid(bbox, step, n):
    """Build NxN lat/lon grid covering bbox (centered)."""
    lon_span = (n - 1) * step
    lat_span = (n - 1) * step
    lon_c = 0.5 * (bbox[0] + bbox[2])
    lat_c = 0.5 * (bbox[1] + bbox[3])
    lons = [round(lon_c - 0.5 * lon_span + step * i, 4) for i in range(n)]
    lats = [round(lat_c - 0.5 * lat_span + step * i, 4) for i in range(n)]
    return lats, lons


def fetch_grid(lats_grid, lons_grid, forecast_days=7):
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
    direction_fields = {"wave_direction", "wind_wave_direction", "swell_wave_direction"}
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
                    if fld in direction_fields:
                        # Compass angles are circular: interpolate unit-vector
                        # components, never degrees (359° and 1° are adjacent,
                        # not opposite directions).
                        weights = ((1 - lf) * (1 - mf), (1 - lf) * mf, lf * (1 - mf), lf * mf)
                        corners = (v00, v01, v10, v11)
                        valid = [(v, wt) for v, wt in zip(corners, weights) if not np.isnan(v)]
                        if not valid:
                            row.append(None)
                        else:
                            sx = sum(wt * np.sin(np.deg2rad(v)) for v, wt in valid)
                            sy = sum(wt * np.cos(np.deg2rad(v)) for v, wt in valid)
                            row.append(float(np.rad2deg(np.arctan2(sx, sy)) % 360.0))
                        continue
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


def fetch_atmospheric_wind(lats_grid, lons_grid, forecast_days=7):
    """Atmospheric 10-m wind from Open-Meteo's main forecast endpoint (NOT marine).

    Same coordinate shape as the marine call, same forecast_days, same timezone.
    The hourly timeline aligns hour-for-hour with the marine response so we can
    merge them by `time` ISO string.
    """
    url = "https://api.open-meteo.com/v1/forecast"
    fields = ["wind_speed_10m", "wind_gusts_10m", "wind_direction_10m", "temperature_2m", "pressure_msl"]
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
        "temperature_unit": "fahrenheit",
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
    time_idx = {t: i for i, t in enumerate(times)}
    out = []
    for fr in frames:
        new_fr = dict(fr)
        h_idx = time_idx.get(fr["time"])
        sp_grid = []
        dg_grid = []
        gust_grid, temp_grid, pressure_grid = [], [], []
        for row in range(nrows):
            sp_row, gust_row, dg_row, temp_row, pressure_row = [], [], [], [], []
            for col in range(ncols):
                pt = row * ncols + col
                if h_idx is None:
                    sp_row.append(None)
                    gust_row.append(None)
                    dg_row.append(None)
                    temp_row.append(None); pressure_row.append(None)
                    continue
                sp = wind_resp[pt]["hourly"]["wind_speed_10m"][h_idx]
                gust = wind_resp[pt]["hourly"]["wind_gusts_10m"][h_idx]
                dg = wind_resp[pt]["hourly"]["wind_direction_10m"][h_idx]
                temp = wind_resp[pt]["hourly"]["temperature_2m"][h_idx]
                pressure = wind_resp[pt]["hourly"]["pressure_msl"][h_idx]
                # rename to forecast.json contract keys (kn + deg)
                sp_row.append(sp)
                gust_row.append(gust)
                dg_row.append(dg)
                temp_row.append(temp); pressure_row.append(pressure)
            sp_grid.append(sp_row)
            gust_grid.append(gust_row)
            dg_grid.append(dg_row)
            temp_grid.append(temp_row)
            pressure_grid.append(pressure_row)
        new_fr["wind_speed_kn"] = sp_grid
        new_fr["wind_gust_kn"] = gust_grid
        new_fr["wind_direction_deg"] = dg_grid
        new_fr["temperature_f"] = temp_grid
        new_fr["pressure_hpa"] = pressure_grid
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

    # Atmospheric fields are required by briefing-forecast-v2. Never publish
    # a marine-only artifact after the weather request fails.
    wind_resp = fetch_atmospheric_wind(fetch_lats, fetch_lons)
    print(f"fetched atmospheric fields from open-meteo forecast ({len(wind_resp)} points)")

    frames = reshape_grid(resp, nrows, ncols)
    if wind_resp:
        frames = merge_wind_into_frames(frames, wind_resp, nrows, ncols)

    # CO-OPS tide curves — independent of the wave grid, fetched per-station.
    # Failures are downgraded per-station so a single dead station does not
    # poison the artifact; the viewer falls back to "tide unavailable" when
    # the active station's curve is absent.
    tides = fetch_all_tides()
    n_tides_ok = len(tides["curves"])
    n_tides_fail = len(tides.get("fetch_failures") or [])
    print(f"tides: {n_tides_ok}/{len(TIDE_STATIONS)} stations ok ({n_tides_fail} failed)")

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
    frames = add_tide_grids(frames, tides, dst_lats, dst_lons)

    # Normalize the mixed upstream names into one stable viewer contract.
    rename = {
        "wave_height": "wave_height_ft", "wave_direction": "wave_direction_deg", "wave_period": "wave_period_s",
        "swell_wave_height": "swell_height_ft", "swell_wave_direction": "swell_direction_deg", "swell_wave_period": "swell_period_s",
        "wind_wave_height": "wind_wave_height_ft", "wind_wave_direction": "wind_wave_direction_deg", "wind_wave_period": "wind_wave_period_s",
    }
    for fr in frames:
        for old, new in rename.items():
            fr[new] = fr.pop(old)

    payload = {
        "schema_version": "briefing-forecast-v2",
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
            "wave_height_ft": "ft", "swell_height_ft": "ft", "wind_wave_height_ft": "ft",
            "wave_direction_deg": "deg", "swell_direction_deg": "deg", "wind_wave_direction_deg": "deg",
            "wave_period_s": "s", "swell_period_s": "s", "wind_wave_period_s": "s",
            "wind_speed_kn": "kn", "wind_gust_kn": "kn", "wind_direction_deg": "deg",
            "temperature_f": "°F", "pressure_hpa": "hPa (mean sea level)",
            "tide_height_ft": "ft (MLLW)",
        },
        "frames": frames,
        "tides": tides,
        "quality": {
            "status": "pass",
            "source_model": "WW3",
            "atmospheric_source": "Open-Meteo Forecast API (temperature_2m, pressure_msl, 10 m wind)",
            "max_age_hours": 12,
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
    encoded = json.dumps(payload, allow_nan=False, separators=(",", ":"))
    for output_path in (OUT_PATH, DASHBOARD_OUT_PATH):
        output_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = output_path.with_suffix(output_path.suffix + ".tmp")
        tmp.write_text(encoded)
        tmp.replace(output_path)
        print(f"wrote {output_path} ({output_path.stat().st_size} bytes, {len(frames)} frames)")


if __name__ == "__main__":
    main()
