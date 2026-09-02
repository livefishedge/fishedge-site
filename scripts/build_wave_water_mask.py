#!/usr/bin/env python3
"""Add a wave/ocean footprint independent of the tidal co-range mask."""
import argparse, json
from pathlib import Path
import cv2
import numpy as np
from scipy.io import netcdf_file

def build_mask(payload, mesh_path, depth_path, scale=100):
    lats = np.asarray(payload['lats'], float); lons = np.asarray(payload['lons'], float)
    mesh = np.load(mesh_path, allow_pickle=False)
    nodes = np.column_stack((mesh['x'], mesh['y'])).astype(float)
    triangles = np.asarray(mesh['elements'], np.int32)
    ds = netcdf_file(str(depth_path), mmap=True)
    ranges = np.asarray(ds.variables['depth'].data[mesh['node_ids']], float)
    ds.close()
    if nodes.ndim != 2 or nodes.shape[1] != 2 or triangles.ndim != 2 or triangles.shape[1] != 3:
        raise SystemExit('forecast has no usable native mesh geometry')
    if len(ranges) != len(nodes): raise SystemExit('native mesh range/node dimensions differ')
    wet = np.array([v is not None and np.isfinite(float(v)) for v in ranges], bool)
    triangles = triangles[np.all(wet[triangles], axis=1)]
    if not len(triangles): raise SystemExit('native mesh has no wet triangles')
    width, height = (len(lons)-1)*scale, (len(lats)-1)*scale
    canvas = np.zeros((height, width), np.uint8)
    px = (nodes[:,0]-lons[0])/(lons[-1]-lons[0])*width
    py = (lats[-1]-nodes[:,1])/(lats[-1]-lats[0])*height
    for chunk in np.array_split(triangles, max(1, len(triangles)//20000)):
        poly = np.rint(np.stack((px[chunk], py[chunk]), axis=2)).astype(np.int32)
        cv2.fillPoly(canvas, poly, 1)
    # Require at least half of the cell to be native wet area.  “Any
    # intersection” admits tiny offshore/shoreline slivers and visibly paints
    # wave colors across land at this coarse grid spacing.
    coverage = canvas.reshape(len(lats)-1, scale, len(lons)-1, scale).mean(axis=(1,3))
    return (coverage >= 0.5).tolist()

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('input', type=Path); ap.add_argument('outputs', nargs='+', type=Path)
    ap.add_argument('--mesh', type=Path, required=True); ap.add_argument('--depth-source', type=Path, required=True)
    args = ap.parse_args(); payload = json.loads(args.input.read_text()); mask = build_mask(payload, args.mesh, args.depth_source)
    payload['wave_water_cells'] = mask
    payload['wave_water_mask_contract'] = {'kind':'native_mesh_cell_footprint', 'source':'native mesh wet triangles (positive native depth)', 'purpose':'wave, swell, wind-wave and significant-wave-height overlays', 'cell_rule':'cell is drawable when native wet coverage is at least 50 percent', 'tidal_mask_separate':True}
    encoded = json.dumps(payload, allow_nan=False, separators=(',', ':'))
    for output in args.outputs: output.parent.mkdir(parents=True, exist_ok=True); output.write_text(encoded)
    print(json.dumps({'wave_water_cells':sum(map(sum, mask)), 'outputs':[str(p) for p in args.outputs]}))
if __name__ == '__main__': main()
