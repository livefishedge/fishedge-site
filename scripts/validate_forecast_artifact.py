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
    print({"path": str(args.path), "frames": len(frames), "window_frames": len(usable),
           "first": min(times).isoformat(), "last": max(times).isoformat(),
           "generated_at": payload["generated_at"]})


if __name__ == "__main__":
    main()
