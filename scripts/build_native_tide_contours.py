#!/usr/bin/env python3
"""Precompute native-mesh co-range contours for the browser."""
import argparse, json
from pathlib import Path
import numpy as np
import matplotlib.tri as mtri

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--forecast', type=Path, required=True); ap.add_argument('--step', type=float, default=.2)
    args = ap.parse_args()
    p = json.loads(args.forecast.read_text()); m = p.get('native_mesh') or {}
    nodes = np.asarray(m.get('nodes'), dtype=float); tri = np.asarray(m.get('triangles'), dtype=np.int32)
    values = np.asarray([np.nan if v is None else float(v) for v in m.get('range_ft', [])])
    if len(nodes) == 0 or len(tri) == 0: raise SystemExit('native mesh missing')
    valid = np.isfinite(values)[tri].all(axis=1)
    tri = tri[valid]
    if len(tri) == 0: raise SystemExit('native mesh has no drawable triangles')
    levels = np.arange(np.floor(np.nanmin(values) / args.step) * args.step + args.step,
                       np.ceil(np.nanmax(values) / args.step) * args.step + args.step / 2, args.step)
    cs = mtri.Triangulation(nodes[:, 0], nodes[:, 1], tri)
    # matplotlib's public tricontour path is more stable across versions.
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(); coll = ax.tricontour(cs, values, levels=levels)
    lines = []
    for level, path in zip(coll.levels, coll.get_paths()):
        v = path.vertices; codes = path.codes
        starts = [0] if codes is None else [i for i, code in enumerate(codes) if code == 1]
        ends = starts[1:] + [len(v)]
        for start, end in zip(starts, ends):
            segment = v[start:end]
            if len(segment) >= 2:
                lines.append({'level_ft': float(level), 'coordinates': segment.tolist()})
    plt.close(fig)
    m['native_contours'] = lines
    m['contour_step_ft'] = args.step
    m['contour_triangle_count'] = int(len(tri))
    p['native_mesh'] = m
    p.setdefault('quality', {}).setdefault('native_mesh', {})['precomputed_contours'] = len(lines)
    args.forecast.write_text(json.dumps(p, allow_nan=False, separators=(',', ':')))
    print(json.dumps({'drawable_triangles': int(len(tri)), 'levels': len(levels), 'segments': len(lines)}))
if __name__ == '__main__': main()
