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
from scipy.io import netcdf_file

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_stofs_global_harmonics import RemoteClassicNetCDF, read_zeta, S3

BBOX = (-77.2, 35.8, -71.8, 40.2)

def find_key(date, cycle):
    return f"stofs_2d_glo.{date}/{cycle}/rerun/stofs_2d_glo_tide.63.nc"

class LocalClassicNetCDF:
    """The same reader contract as RemoteClassicNetCDF for a verified copy."""
    def __init__(self, path):
        self.path = str(path)
        self.ds = netcdf_file(self.path, mmap=True)
        self._base_ptr = np.frombuffer(self.ds._mm_buf, dtype=np.uint8).__array_interface__["data"][0]
    def variable_bytes(self, name):
        v = self.ds.variables[name].data
        return self.range(self.offset(name), int(np.prod(v.shape)) * v.dtype.itemsize)
    def offset(self, name):
        return int(self.ds.variables[name].data.__array_interface__["data"][0] - self._base_ptr)
    def range(self, start, length):
        with open(self.path, "rb") as f:
            f.seek(start); data = f.read(length)
        if len(data) != length: raise RuntimeError("short local NetCDF read")
        return data
    def close(self): self.ds.close()

def build_complete_region_mesh(remote, cache_path):
    """Select every native ADCIRC face intersecting USEC-MD.

    The old cache was built from nearest neighbours of a 17x21 raster.  That
    is not a regional mesh.  Read the mesh topology once, select by face
    bounding-box intersection (including faces crossing the boundary), and
    remap only the referenced global nodes into a compact local cache.
    """
    x = np.frombuffer(remote.variable_bytes("x"), dtype=remote.ds.variables["x"].data.dtype).astype(float, copy=True)
    y = np.frombuffer(remote.variable_bytes("y"), dtype=remote.ds.variables["y"].data.dtype).astype(float, copy=True)
    elements = np.frombuffer(remote.variable_bytes("element"), dtype=remote.ds.variables["element"].data.dtype).astype(np.int64, copy=True).reshape((-1, 3)) - 1
    lo_x, lo_y, hi_x, hi_y = BBOX
    # A face intersects the region when its bounding box intersects it. This
    # includes shoreline faces whose vertices straddle the regional boundary.
    ex = x[elements]
    ey = y[elements]
    # Reject longitude-wrap faces first.  ADCIRC stores longitudes in the
    # [-180,180] convention; a face spanning the dateline can otherwise have
    # a bounding box that falsely intersects the Mid-Atlantic.
    lon_span = ex.max(axis=1) - ex.min(axis=1)
    selected = ((lon_span < 5.0) &
                (ex.max(axis=1) >= lo_x) & (ex.min(axis=1) <= hi_x) &
                (ey.max(axis=1) >= lo_y) & (ey.min(axis=1) <= hi_y))
    regional_elements = elements[selected]
    if not len(regional_elements):
        raise SystemExit("native mesh has no faces intersecting USEC-MD")
    node_ids = np.unique(regional_elements.ravel())
    local = np.full(len(x), -1, dtype=np.int64)
    local[node_ids] = np.arange(len(node_ids))
    local_elements = local[regional_elements].astype(np.int32)
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache_path, x=x[node_ids], y=y[node_ids],
                        node_ids=node_ids, elements=local_elements,
                        selection=np.array(["face_bbox_intersection_v2"]))
    return {"x": x[node_ids], "y": y[node_ids], "node_ids": node_ids,
            "elements": local_elements}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', default='20260901')
    ap.add_argument('--cycle', default='00')
    ap.add_argument('--mesh-cache', type=Path, required=True)
    ap.add_argument('--forecast', type=Path, required=True)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--local-source', type=Path,
                    help='verified local copy of the immutable STOFS HTP NetCDF')
    ap.add_argument('--rebuild-mesh', action='store_true',
                    help='discard the legacy nearest-grid cache and select all regional faces')
    args = ap.parse_args()
    source_url = f"{S3}/{find_key(args.date, args.cycle)}"
    remote = LocalClassicNetCDF(args.local_source) if args.local_source else RemoteClassicNetCDF(source_url)
    try:
        has_complete_cache = args.mesh_cache.exists() and 'selection' in np.load(args.mesh_cache, allow_pickle=False).files
        if args.rebuild_mesh or not has_complete_cache:
            m = build_complete_region_mesh(remote, args.mesh_cache)
        else:
            m = dict(np.load(args.mesh_cache, allow_pickle=False))
        count = int(remote.ds.variables['zeta'].data.shape[0])
        # The range must use every published HTP band; sampling every third
        # hour changes extrema and is not a full-horizon range.
        hours = np.arange(count, dtype=int)
        node_ids_for_read = np.asarray(m['node_ids'], dtype=np.int64)
        zeta_m = read_zeta(remote, node_ids_for_read, hours)
        depth_var = remote.ds.variables.get('depth')
        if depth_var is None:
            raise SystemExit('native source lacks depth/wet-dry variable')
        # Depth is a node variable. Read the selected nodes using bounded
        # contiguous windows rather than materializing the global array again.
        starts = []
        start = previous = int(node_ids_for_read[0])
        for value in node_ids_for_read[1:]:
            value = int(value)
            if value != previous + 1:
                starts.append((start, previous + 1)); start = value
            previous = value
        starts.append((start, previous + 1))
        depth_m = np.full(len(node_ids_for_read), np.nan)
        begin = remote.offset('depth'); itemsize = depth_var.data.dtype.itemsize
        for lo, hi in starts:
            raw = remote.range(begin + lo * itemsize, (hi - lo) * itemsize)
            vals = np.frombuffer(raw, dtype=depth_var.data.dtype).astype(float)
            left = int(np.searchsorted(node_ids_for_read, lo, side='left'))
            right = int(np.searchsorted(node_ids_for_read, hi, side='left'))
            depth_m[left:right] = vals[node_ids_for_read[left:right] - lo]
    finally:
        remote.close()
    # The cache is already compact: `elements` are local indices and
    # `node_ids` are the corresponding sorted global IDs used for zeta reads.
    # Do not reinterpret local triangle indices as global IDs (the prior build
    # did exactly that and silently discarded almost every face).
    node_ids = np.asarray(m['node_ids'], dtype=np.int64)
    x, y = np.asarray(m['x'], float), np.asarray(m['y'], float)
    tris = np.asarray(m['elements'], dtype=np.int32)
    if len(tris) == 0 or tris.min() < 0 or tris.max() >= len(node_ids):
        raise SystemExit('native mesh local triangle indices are invalid')
    valid = np.isfinite(zeta_m) & (depth_m[None, :] > 0.0)
    zeta_ft = zeta_m * 3.280839895
    ranges = np.full(zeta_ft.shape[1], np.nan)
    good = valid.any(axis=0)
    ranges[good] = np.nanmax(zeta_ft[:, good], axis=0) - np.nanmin(zeta_ft[:, good], axis=0)
    finite = np.isfinite(ranges)
    if not finite.any(): raise SystemExit('native mesh contains no finite range values')
    payload = json.loads(args.forecast.read_text())
    source_sha256 = None if not args.local_source else __import__('hashlib').sha256(args.local_source.read_bytes()).hexdigest()
    payload['native_mesh'] = {
        'coordinates': 'WGS84 lon/lat',
        'nodes': [[float(lon), float(lat)] for lon, lat in zip(x, y)],
        'triangles': tris.tolist(),
        'range_ft': [None if not np.isfinite(v) else float(v) for v in ranges],
        'node_count': int(len(x)), 'triangle_count': int(len(tris)),
        'source': {'provider': 'NOAA', 'model': 'STOFS-2D Global HTP',
                   'object': find_key(args.date, args.cycle),
                   'sha256': source_sha256,
                   'datum': 'MSL-like',
                   'range_definition': 'max-min over complete native HTP horizon',
                   'method': 'complete ADCIRC face-bbox intersection; full native HTP horizon; native depth mask; no regular-grid reprojection; no CO-OPS interpolation'},
    }
    payload.setdefault('quality', {})['native_mesh'] = {
        'status': 'pass', 'node_count': int(len(x)), 'triangle_count': int(len(tris)),
        'finite_range_nodes': int(finite.sum()),
        'range_min_ft': float(np.nanmin(ranges)), 'range_max_ft': float(np.nanmax(ranges)),
        'native_source_object': find_key(args.date, args.cycle),
        'native_source_sha256': (None if not args.local_source else __import__('hashlib').sha256(args.local_source.read_bytes()).hexdigest()),
        'mesh_selection': 'all faces whose native lon/lat bbox intersects USEC-MD',
        'htp_hours': int(len(hours)),
        'wet_nodes': int(np.sum(depth_m > 0.0)),
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
