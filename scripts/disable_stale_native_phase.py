#!/usr/bin/env python3
"""Remove a native phase-tile manifest when no matching refresh is published."""
import argparse
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
        valid = bool(phase_times and phase.get("frames") == len(phase_times)
                     and len(current_times) >= len(phase_times)
                     and current_times[:len(phase_times)] == phase_times
                     and phase.get("asset_version"))
        removed = None if valid else native.pop("phase_tiles", None)
        quality = payload.setdefault("quality", {}).setdefault("native_mesh", {})
        quality["phase_tiles"] = {
            "status": "pass" if valid else "disabled",
            "reason": ("native phase atlas timestamps match this forecast cycle"
                       if valid else "native phase atlas is not refreshed with this forecast cycle; use verified regional tide grid")
        }
        path.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
        print({"path": str(path), "native_phase_manifest_removed": bool(removed)})

if __name__ == "__main__":
    main()
