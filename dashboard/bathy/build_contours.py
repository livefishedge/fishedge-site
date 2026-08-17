#!/usr/bin/env python3
"""
build_contours.py — Generate FishEdge bathy LOD GeoJSON from GEBCO data.

Pivoted v1 (no tippecanoe because no-root apt blocks libsqlite3-dev):
ships flat GeoJSON for medium (25 m) and fine (10 m) tiers. v2 will
swap these for tippecanoe-built PBF tiles once NOAA BlueTopo + NCEI
multibeam data are sourced (see lod-manifest.json).

Usage:
  python3 build_contours.py --tier medium --out ../medium.json
  python3 build_contours.py --tier fine   --out ../fine.json --bbox "-74.85,38.05,-73.65,38.55"
"""
import argparse
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from shapely.geometry import LineString, mapping


def load_gebco(path):
    with open(path) as f:
        d = json.load(f)
    x = np.array(d["xAxis"])
    y = np.array(d["yAxis"])
    z = np.array(d["depth"], dtype=float)
    return x, y, z


def contour_levels_for_tier(tier):
    if tier == "medium":
        return [25, 50, 100, 200, 500, 1000, 2000, 5000]
    if tier == "fine":
        return [10, 20, 30, 40, 50, 75, 100, 150, 200, 300, 500, 1000, 2000]
    raise ValueError(f"Unknown tier: {tier}")


def extract_contours(x, y, z, levels, simplify_tol_deg=0.0):
    X, Y = np.meshgrid(x, y)
    fig, ax = plt.subplots()
    cs = ax.contour(X, Y, z, levels=levels)
    out = []
    for i, level in enumerate(cs.levels):
        for poly in cs.allsegs[i]:
            if len(poly) < 2:
                continue
            coords = [(float(p[0]), float(p[1])) for p in poly]
            geom = LineString(coords)
            if simplify_tol_deg > 0:
                geom = geom.simplify(simplify_tol_deg, preserve_topology=False)
            if not geom.is_empty and len(geom.coords) >= 2:
                out.append((float(level), geom))
    plt.close(fig)
    return out


def filter_bbox(features, bbox):
    if not bbox:
        return features
    w, s, e, n = bbox
    kept = []
    for depth, geom in features:
        c = geom.representative_point()
        if w <= c.x <= e and s <= c.y <= n:
            kept.append((depth, geom))
    return kept


def to_geojson(features):
    return {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "properties": {"depth": depth}, "geometry": mapping(geom)}
            for depth, geom in features
        ],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tier", choices=["medium", "fine"], required=True)
    ap.add_argument("--src", default="gebco_bathy.json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--bbox", default=None,
                    help="w,s,e,n to clip (default: full usec_md extent)")
    ap.add_argument("--simplify-deg", type=float, default=0.0,
                    help="Douglas-Peucker tolerance in degrees (e.g. 0.0003 ≈ 26 m at 38°N)")
    args = ap.parse_args()

    print(f"[{args.tier}] loading {args.src}...", flush=True)
    x, y, z = load_gebco(args.src)
    print(f"  shape={z.shape}  x_step={(x[1]-x[0]):.5f}°  y_step={(y[1]-y[0]):.5f}°", flush=True)

    levels = contour_levels_for_tier(args.tier)
    print(f"  levels (m): {levels}", flush=True)

    print(f"[{args.tier}] extracting contours (simplify_tol={args.simplify_deg}°)...", flush=True)
    feats = extract_contours(x, y, z, levels, simplify_tol_deg=args.simplify_deg)
    print(f"  raw: {len(feats)}", flush=True)

    if args.bbox:
        bbox = [float(v) for v in args.bbox.split(",")]
        feats = filter_bbox(feats, bbox)
        print(f"  after bbox {bbox}: {len(feats)}", flush=True)

    gj = to_geojson(feats)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w") as f:
        json.dump(gj, f, separators=(",", ":"))
    size_kb = out.stat().st_size / 1024
    print(f"[{args.tier}] wrote {out} — {len(feats)} features, {size_kb:.1f} KB", flush=True)


if __name__ == "__main__":
    main()