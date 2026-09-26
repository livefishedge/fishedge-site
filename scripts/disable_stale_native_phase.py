#!/usr/bin/env python3
"""Remove a native phase-tile manifest when no matching refresh is published."""
import argparse
import datetime as dt
import json
from pathlib import Path

def forecast_times(payload, current_forecast):
    manifest = payload.get("frames_manifest") or {}
    directory = Path(manifest.get("dir", "frames"))
    root = current_forecast.parent / directory
    values = []
    for name in manifest.get("chunks", []):
        path = root / name
        if not path.is_file():
            return []
        chunk = json.loads(path.read_text())
        values.extend(str(frame.get("time")) for frame in chunk.get("frames", [])
                      if frame.get("time"))
    return values


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()
    for path in args.paths:
        payload = json.loads(path.read_text())
        native = payload.get("native_mesh") or {}
        phase = native.get("phase_tiles") or {}
        phase_times = [str(value) for value in phase.get("frame_times", [])]
        current_times = forecast_times(payload, path)
        def parse(value):
            try:
                return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(dt.timezone.utc)
            except ValueError:
                return None
        phase_dt = [parse(value) for value in phase_times]
        current_set = {parse(value) for value in current_times if parse(value) is not None}
        phase_set = {value for value in phase_dt if value is not None}
        now = dt.datetime.now(dt.timezone.utc)
        phase_end = max((value for value in phase_dt if value is not None), default=None)
        # Forecast refreshes slide in time. Preserve an atlas when its valid
        # UTC interval still overlaps the refreshed forecast; array position
        # and exact prefix are not identity. Rebuild can replace it later.
        valid = bool(phase_times and phase.get("frames") == len(phase_times)
                     and len(phase_dt) == len(phase_times)
                     and len(current_set.intersection(phase_set)) >= min(12, len(current_times))
                     and phase_end is not None and phase_end >= now - dt.timedelta(hours=1)
                     and phase.get("asset_version"))
        removed = None if valid else native.pop("phase_tiles", None)
        quality = payload.setdefault("quality", {}).setdefault("native_mesh", {})
        quality["phase_tiles"] = {
            "status": "pass" if valid else "disabled",
            "reason": ("native phase atlas timestamps match this forecast cycle"
                       if valid else "native phase atlas has no current UTC overlap; rebuild before removal")
        }
        path.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
        print({"path": str(path), "native_phase_manifest_removed": bool(removed)})

if __name__ == "__main__":
    main()
