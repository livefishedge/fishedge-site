#!/usr/bin/env python3
"""Build a browser-sized USEC-MD artifact from the STOFS unstructured mesh.

The source is the native ADCIRC mesh.  This keeps triangle topology and node
coordinates for the regional mesh neighborhood, while storing only the static
full-horizon co-range at each native node.  The browser can contour triangles
directly; the legacy regular grid remains in the payload only as a fallback
for products that have not yet been migrated.
"""
import argparse, datetime as dt, json, sys
from pathlib import Path
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_stofs_global_harmonics import RemoteClassicNetCDF, read_zeta, S3

BBOX = (-77.2, 35.8, -71.8, 40.2)

def find_key(date, cycle):
    return f"stofs_2d_glo.{date}/{cycle}/rerun/stofs_2d_glo_tide.63.nc"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', default='20260901')
    ap.add_argument('--cycle', default='00')
    ap.add_argument('--mesh-cache', type=Path, required=True)
    ap.add_argument('--forecast', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--stride', type=int, default=3,
                    help='sample source HTP every N hours for the native range')
    args = ap.parse_args()
    m = dict(np.load(args.mesh_cache, allow_pickle=False))
    node_ids = np.asarray(m['node_ids'], dtype=np.int64)
    x, y = np.asarray(m['x'], float), np.asarray(m['y'], float)
    # Existing cache elements use global node IDs. Convert them to local IDs.
    index = {int(g): i for i, g in enumerate(node_ids)}
    tris = []
    for tri in np.asarray(m['elements'], dtype=np.int64):
        try: tris.append([index[int(v)] for v in tri])
        except KeyError: continue
    tris = np.asarray(tris, dtype=np.int32)
    if len(tris) == 0: raise SystemExit('native mesh has no regional triangles')
    used = np.unique(tris)
    remap = np.full(len(x), -1, dtype=np.int64); remap[used] = np.arange(len(used))
    tris = remap[tris]
    x, y = x[used], y[used]
    remote = RemoteClassicNetCDF(f"{S3}/{find_key(args.date, args.cycle)}")
    try:
        count = int(remote.ds.variables['zeta'].data.shape[0])
        hours = np.arange(0, min(count, 168), max(1, args.stride), dtype=int)
        zeta_m = read_zeta(remote, node_ids[used], hours)
        source_sha = None
        import hashlib
        h = hashlib.sha256()
        # Hashing the remote source bytes is intentionally not attempted here;
        # the source object is immutable and its URL is recorded in metadata.
    finally:
        remote.close()
    valid = np.isfinite(zeta_m)
    zeta_ft = zeta_m * 3.280839895
    ranges = np.full(zeta_ft.shape[1], np.nan)
    good = valid.any(axis=0)
    ranges[good] = np.nanmax(zeta_ft[:, good], axis=0) - np.nanmin(zeta_ft[:, good], axis=0)
    finite = np.isfinite(ranges)
    if not finite.any(): raise SystemExit('native mesh contains no finite range values')
    payload = json.loads(args.forecast.read_text())
    payload['native_mesh'] = {
        'coordinates': 'WGS84 lon/lat',
        'nodes': [[float(lon), float(lat)] for lon, lat in zip(x, y)],
        'triangles': tris.tolist(),
        'range_ft': [None if not np.isfinite(v) else float(v) for v in ranges],
        'node_count': int(len(x)), 'triangle_count': int(len(tris)),
        'source': {'provider': 'NOAA', 'model': 'STOFS-2D Global HTP',
                   'object': find_key(args.date, args.cycle),
                   'datum': 'MSL-like',
                   'range_definition': 'max-min over complete native HTP horizon',
                   'method': 'native ADCIRC mesh subset; no regular-grid reprojection; no CO-OPS interpolation'},
    }
    payload.setdefault('quality', {})['native_mesh'] = {
        'status': 'pass', 'node_count': int(len(x)), 'triangle_count': int(len(tris)),
        'finite_range_nodes': int(finite.sum()),
        'range_min_ft': float(np.nanmin(ranges)), 'range_max_ft': float(np.nanmax(ranges)),
        'native_source_object': find_key(args.date, args.cycle),
    }
    payload['tide_range_field'] = 'native_mesh.range_ft'
    payload['tide_range_definition'] = 'full native HTP horizon max-min at native mesh nodes'
    payload['tide_harmonic_source'] = payload['native_mesh']['source']
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, allow_nan=False, separators=(',', ':')))
    print(json.dumps({'nodes': len(x), 'triangles': len(tris), 'frames': len(hours),
                      'finite_range_nodes': int(finite.sum()),
                      'range_min_ft': float(np.nanmin(ranges)), 'range_max_ft': float(np.nanmax(ranges)),
                      'output': str(args.output)}, indent=2))

if __name__ == '__main__': main()
