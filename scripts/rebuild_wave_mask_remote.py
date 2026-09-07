#!/usr/bin/env python3
"""Regenerate the wave coastline mask from the signed STOFS depth field."""
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
from fetch_stofs_global_harmonics import RemoteClassicNetCDF, S3

ROOT = Path(__file__).resolve().parents[1]
payload_paths = [ROOT / 'data/usec_md/briefing/forecast.json', ROOT / 'dashboard/trip-planner/data/usec_md/briefing/forecast.json']
mask_path = ROOT / 'dashboard/trip-planner/data/usec_md/briefing/native_wave_mask.png'
url = f'{S3}/stofs_2d_glo.20260901/00/rerun/stofs_2d_glo_tide.63.nc'
payload = json.loads(payload_paths[0].read_text())
lats = np.asarray(payload['lats'], float); lons = np.asarray(payload['lons'], float)
mesh = np.load(ROOT / 'data/usec_md/briefing/.stofs_mesh_cache.npz', allow_pickle=False)
nodes = np.column_stack((mesh['x'], mesh['y'])).astype(float)
triangles = np.asarray(mesh['elements'], np.int32)
node_ids = np.asarray(mesh['node_ids'], np.int64)
# The checked-in legacy cache stores global ADCIRC IDs in `elements`; remap
# them through the sorted regional node-id list before indexing depth.
if triangles.size and (triangles.max() >= len(node_ids) or triangles.min() < 0):
    pos = np.searchsorted(node_ids, triangles.astype(np.int64))
    if np.any(pos >= len(node_ids)) or np.any(node_ids[pos] != triangles):
        raise SystemExit('mesh elements are not valid global IDs for this cache')
    triangles = pos.astype(np.int32)
remote = RemoteClassicNetCDF(url)
try:
    var = remote.ds.variables['depth']; dtype = var.data.dtype; base = remote.offset('depth')
    depth = np.full(len(node_ids), np.nan)
    # Coalesce sparse IDs into bounded windows. One request per mesh gap can
    # mean thousands of round trips against the 13-GB public object.
    starts = []
    lo = int(node_ids[0]); prev = lo
    for value in node_ids[1:]:
        value = int(value)
        if value - lo >= 100000:
            starts.append((lo, prev + 1)); lo = value
        prev = value
    starts.append((lo, prev + 1))
    for lo, hi in starts:
        raw = remote.range(base + lo * dtype.itemsize, (hi - lo) * dtype.itemsize)
        vals = np.frombuffer(raw, dtype=dtype).astype(float)
        left = int(np.searchsorted(node_ids, lo, side='left')); right = int(np.searchsorted(node_ids, hi, side='left'))
        depth[left:right] = vals[node_ids[left:right] - lo]
finally:
    remote.close()

# Positive signed STOFS depth is water. Finite land elevations are not wet.
wet = np.isfinite(depth) & (depth > 0.0)
triangles = triangles[np.all(wet[triangles], axis=1)]
if not len(triangles): raise SystemExit('no wet triangles after signed-depth filter')
scale = 100; width, height = (len(lons)-1)*scale, (len(lats)-1)*scale
canvas = np.zeros((height, width), np.uint8)
# The viewer samples rows in normalized Web Mercator (EPSG:3857), not linear
# latitude. Build the raster in the same coordinate system so Chesapeake
# shorelines and barrier islands do not shift with latitude.
merc = lambda values: np.log(np.tan(np.pi / 4.0 + np.asarray(values) * np.pi / 360.0))
merc_south, merc_north = merc(lats[0]), merc(lats[-1])
px = (nodes[:, 0] - lons[0]) / (lons[-1] - lons[0]) * width
py = (merc_north - merc(nodes[:, 1])) / (merc_north - merc_south) * height
for chunk in np.array_split(triangles, max(1, len(triangles)//20000)):
    poly = np.rint(np.stack((px[chunk], py[chunk]), axis=2)).astype(np.int32)
    cv2.fillPoly(canvas, poly, 1)
coverage = canvas.reshape(len(lats)-1, scale, len(lons)-1, scale).mean(axis=(1, 3))
mask = (coverage >= 0.75).tolist()
mask_path.parent.mkdir(parents=True, exist_ok=True)
Image.fromarray(canvas * 255, mode='L').save(mask_path, optimize=True)
payload['wave_water_cells'] = mask
payload['wave_water_mask_contract'] = {'kind': 'native_mesh_cell_footprint', 'source': 'native mesh triangles whose three STOFS depth values are finite and positive', 'purpose': 'wave, swell, wind-wave and significant-wave-height overlays', 'cell_rule': 'cell is drawable when native wet coverage is at least 75 percent', 'projection': 'normalized EPSG:3857 rows', 'tidal_mask_separate': True}
encoded = json.dumps(payload, allow_nan=False, separators=(',', ':'))
for path in payload_paths: path.write_text(encoded)
print(json.dumps({'wet_nodes': int(wet.sum()), 'wet_triangles': int(len(triangles)), 'wave_cells': int(sum(map(sum, mask))), 'mask': str(mask_path)}))
