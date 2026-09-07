#!/usr/bin/env python3
"""Regenerate the wave coastline mask from the signed STOFS depth field."""
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image
import cartopy.io.shapereader as shpreader
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
# Keep the coastline raster substantially finer than the forecast grid. A
# 400x subdivision is ~100–150 m over this regional bbox, enough to retain
# narrow barrier islands without pretending the forecast has that resolution.
scale = 400; width, height = (len(lons)-1)*scale, (len(lats)-1)*scale
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

# The native mesh is the authoritative wet-data footprint, but its coastal
# triangles are not guaranteed to resolve narrow barrier islands and sand bars.
# Burn the 10 m Natural Earth land polygons into the same projected raster so
# a crest cannot visually bridge a thin land feature simply because the model
# mesh skipped it. This is a display boundary only; it does not invent wave
# values or imply shallow-water refraction/breaking physics.
land_canvas = np.zeros_like(canvas)
land_path = shpreader.natural_earth(resolution='10m', category='physical', name='land')
for geom in shpreader.Reader(land_path).geometries():
    geoms = list(getattr(geom, 'geoms', (geom,)))
    for part in geoms:
        rings = [part.exterior, *part.interiors]
        for ring_index, ring in enumerate(rings):
            coords = np.asarray(ring.coords, dtype=float)
            if len(coords) < 3:
                continue
            valid = np.isfinite(coords[:, 0]) & np.isfinite(coords[:, 1])
            coords = coords[valid]
            if len(coords) < 3:
                continue
            px_ring = (coords[:, 0] - lons[0]) / (lons[-1] - lons[0]) * width
            py_ring = (merc_north - merc(coords[:, 1])) / (merc_north - merc_south) * height
            poly = np.rint(np.stack((px_ring, py_ring), axis=1)).astype(np.int32)
            cv2.fillPoly(land_canvas, [poly], 1 if ring_index == 0 else 0)
canvas[land_canvas > 0] = 0
coverage = canvas.reshape(len(lats)-1, scale, len(lons)-1, scale).mean(axis=(1, 3))
mask = (coverage >= 0.75).tolist()
# Classify wet pixels connected to the raster boundary as open-water support.
# This is a geometry gate, not a wave-propagation model: it prevents a coarse
# offshore swell value from being presented as local lagoon water while still
# allowing wind-wave anchors in partial coastal cells.
wet_pixels = (canvas > 0).astype(np.uint8)
components, labels = cv2.connectedComponents(wet_pixels, connectivity=8)
edge_labels = set(labels[0, :].tolist() + labels[-1, :].tolist() +
                  labels[:, 0].tolist() + labels[:, -1].tolist()) - {0}
open_pixels = np.isin(labels, list(edge_labels)).astype(np.uint8)
open_coverage = open_pixels.reshape(len(lats)-1, scale, len(lons)-1, scale).mean(axis=(1, 3))
open_mask = (open_coverage >= 0.75).tolist()
mask_path.parent.mkdir(parents=True, exist_ok=True)
Image.fromarray(canvas * 255, mode='L').save(mask_path, optimize=True)
payload['wave_water_cells'] = mask
payload['wave_water_coverage'] = np.round(coverage, 4).tolist()
payload['wave_open_water_cells'] = open_mask
payload['wave_water_mask_contract'] = {'kind': 'native_mesh_cell_footprint', 'source': 'native mesh triangles whose three STOFS depth values are finite and positive, intersected with detailed land geometry', 'purpose': 'wave, swell, wind-wave and significant-wave-height overlays', 'cell_rule': 'partial wet cells may supply local wind-wave anchors; full open-water support is required for regional swell animation', 'open_water_rule': 'wet pixels connected to the raster boundary through water; this is a conservative geometry support gate, not a shallow-water propagation model', 'projection': 'normalized EPSG:3857 rows', 'tidal_mask_separate': True}
encoded = json.dumps(payload, allow_nan=False, separators=(',', ':'))
for path in payload_paths: path.write_text(encoded)
print(json.dumps({'wet_nodes': int(wet.sum()), 'wet_triangles': int(len(triangles)), 'wave_cells': int(sum(map(sum, mask))), 'open_water_cells': int(sum(map(sum, open_mask))), 'mask': str(mask_path)}))
