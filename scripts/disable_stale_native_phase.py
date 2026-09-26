#!/usr/bin/env python3
"""Remove a native phase-tile manifest when no matching refresh is published."""
import argparse
import json
from pathlib import Path

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()
    for path in args.paths:
        payload = json.loads(path.read_text())
        native = payload.get("native_mesh") or {}
        removed = native.pop("phase_tiles", None)
        quality = payload.setdefault("quality", {}).setdefault("native_mesh", {})
        quality["phase_tiles"] = {"status": "disabled", "reason": "native phase atlas is not refreshed with this forecast cycle; use verified regional tide grid"}
        path.write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))
        print({"path": str(path), "native_phase_manifest_removed": bool(removed)})

if __name__ == "__main__":
    main()
