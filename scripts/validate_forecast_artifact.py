#!/usr/bin/env python3
"""Fail closed when a forecast artifact is stale, incomplete, or malformed."""
import argparse
import datetime as dt
import json
from pathlib import Path


def load_frames(path: Path):
    payload = json.loads(path.read_text())
    manifest = payload.get("frames_manifest") or {}
    if manifest.get("chunks"):
        base = path.parent / str(manifest.get("dir", "frames"))
        frames = []
        for name in manifest["chunks"]:
            chunk = json.loads((base / str(name)).read_text())
            frames.extend(chunk.get("frames") or [])
        if len(frames) != int(manifest.get("frame_count", -1)):
            raise ValueError("forecast frame chunks do not match manifest")
        return payload, frames
    return payload, payload.get("frames") or []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    args = parser.parse_args()
    payload, frames = load_frames(args.path)
    region = payload.get("region")
    regions = {
        "usec_md": [-76.5, 35.5, -71.5, 40.5],
        "usec_south": [-81.0, 31.0, -73.0, 36.0],
    }
    if region not in regions:
        raise SystemExit(f"forecast has unsupported region: {region!r}")
    bbox = payload.get("bbox") or payload.get("display_bbox")
    if not isinstance(bbox, list) or len(bbox) != 4 or any(not isinstance(v, (int, float)) for v in bbox):
        raise SystemExit("forecast missing numeric bbox")
    expected = regions[region]
    if bbox[0] > expected[0] or bbox[1] > expected[1] or bbox[2] < expected[2] or bbox[3] < expected[3]:
        raise SystemExit(f"forecast bbox does not cover {region}: {bbox}")
    if not frames:
        raise SystemExit("forecast has no frames")
    times = []
    for frame in frames:
        value = str(frame.get("time", ""))
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        times.append(parsed.astimezone(dt.timezone.utc))
    now = dt.datetime.now(dt.timezone.utc)
    start, end = now - dt.timedelta(hours=24), now + dt.timedelta(hours=168)
    usable = [value for value in times if start <= value <= end]
    if not usable:
        raise SystemExit(f"forecast has no frames in rolling window: {min(times)}..{max(times)}")
    if not payload.get("generated_at"):
        raise SystemExit("forecast missing generated_at provenance")
    stations = (payload.get("tides") or {}).get("stations") or []
    if not stations:
        raise SystemExit("forecast missing regional tide stations")
    for station in stations:
        if not all(isinstance(station.get(k), (int, float)) for k in ("lat", "lon")):
            raise SystemExit(f"station has invalid coordinates: {station}")
        if not (expected[0] <= station["lon"] <= expected[2] and expected[1] <= station["lat"] <= expected[3]):
            raise SystemExit(f"station outside {region} bbox: {station}")
    sample = frames[0]
    for field in ("astronomical_tide_ft", "tide_range_ft"):
        grid = sample.get(field)
        if not isinstance(grid, list) or len(grid) != len(payload.get("lats", [])) or not grid or len(grid[0]) != len(payload.get("lons", [])):
            raise SystemExit(f"{region} frame missing aligned {field}")
    ranges = [v for row in sample["tide_range_ft"] for v in row if isinstance(v, (int, float))]
    if not ranges or max(ranges) > 30.0:
        raise SystemExit(f"{region} tide range is physically implausible: max={max(ranges, default=float('nan'))}")
    # A weather refresh must not silently drop the range field from later
    # frames. Validate every advertised frame, not only frame zero.
    expected_shape = (len(payload.get("lats", [])), len(payload.get("lons", [])))
    for frame in frames:
        grid = frame.get("tide_range_ft")
        if not isinstance(grid, list) or len(grid) != expected_shape[0] or any(
                not isinstance(row, list) or len(row) != expected_shape[1] for row in grid):
            raise SystemExit(f"{region} frame {frame.get('time')} missing aligned tide_range_ft")
        if not any(isinstance(value, (int, float)) for row in grid for value in row):
            raise SystemExit(f"{region} frame {frame.get('time')} tide_range_ft has no finite cells")
    tide_coverage = []
    for frame, timestamp in zip(frames, times):
        if timestamp not in usable:
            continue
        grid = frame.get("astronomical_tide_ft")
        finite = sum(1 for row in (grid or []) for value in (row or [])
                     if isinstance(value, (int, float)))
        if finite == 0:
            raise SystemExit(f"{region} tidal stage has no usable cells at {timestamp.isoformat()}")
        tide_coverage.append((timestamp, finite))
    mask = payload.get("tide_water_cells")
    if not isinstance(mask, list) or len(mask) != len(payload["lats"]) - 1 or len(mask[0]) != len(payload["lons"]) - 1:
        raise SystemExit(f"{region} tide_water_cells mask is not aligned to forecast grid")
    source = payload.get("tide_harmonic_source") or payload.get("regional_tide_source") or payload.get("ofs_tidal_forecast")
    if not source:
        raise SystemExit(f"{region} missing tidal source provenance")
    native = payload.get("native_mesh") or {}
    if not native.get("complete_native_mesh_processed"):
        raise SystemExit(f"{region} missing complete native mesh processing contract")
    if not isinstance(native.get("native_contours"), list) or not native["native_contours"]:
        raise SystemExit(f"{region} missing native tidal contours")
    phase = native.get("phase_tiles")
    if phase:
        if not isinstance(phase.get("frames"), int) or phase["frames"] <= 0:
            raise SystemExit(f"{region} invalid native phase-tile contract")
        phase_times = phase.get("frame_times")
        if not isinstance(phase_times, list) or len(phase_times) != phase["frames"]:
            raise SystemExit(f"{region} native phase frame_times do not match phase frame count")
        try:
            parsed_phase_times = [dt.datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(dt.timezone.utc) for value in phase_times]
        except ValueError as exc:
            raise SystemExit(f"{region} native phase has invalid timestamp: {exc}")
        if any(b <= a for a, b in zip(parsed_phase_times, parsed_phase_times[1:])):
            raise SystemExit(f"{region} native phase timestamps are not strictly increasing")
        if not phase.get("asset_version"):
            raise SystemExit(f"{region} native phase assets lack an immutable version")
        phase_start, phase_end = parsed_phase_times[0], parsed_phase_times[-1]
        # Compare native coverage with the actual advertised rolling forecast,
        # not merely the next 48 hours; a partial atlas must be visible in
        # health output even when the regional fallback keeps the layer valid.
        required_end = max(usable)
        if phase_start > now or phase_end < required_end:
            raise SystemExit(f"{region} native phase atlas does not cover advertised forecast: {phase_start.isoformat()}..{phase_end.isoformat()} vs {required_end.isoformat()}")
        phase_status = "complete"
    else:
        regional = payload.get("regional_tide_harmonics") or {}
        if not regional.get("fields") or not regional.get("reference_time"):
            raise SystemExit(f"{region} missing verified regional tide fallback")
        phase_status = "regional_grid_only"
    print({"path": str(args.path), "frames": len(frames), "window_frames": len(usable),
           "tidal_stage_coverage": {"first": tide_coverage[0][0].isoformat(),
                                    "last": tide_coverage[-1][0].isoformat(),
                                    "min_cells": min(v for _, v in tide_coverage)},
           "native_phase_status": phase_status,
           "first": min(times).isoformat(), "last": max(times).isoformat(),
           "generated_at": payload["generated_at"]})


if __name__ == "__main__":
    main()
