#!/usr/bin/env python3
"""Render native STOFS HTP tidal phase tiles for the browser overlay.

The tiles are derived from the same native nodes/elements and complete HTP
horizon used for co-range.  They are Web-Mercator images so the browser can
place them exactly over the OpenLayers map without shipping a million-node
mesh to the client.
"""
import argparse, json
import gc
from pathlib import Path
import numpy as np
import cv2
from scipy.io import netcdf_file
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / 'scripts'
import sys
sys.path.insert(0, str(SCRIPTS))
from build_stofs_native_mesh_artifact import LocalClassicNetCDF, read_zeta

R = 6378137.0
def mercator(lon, lat):
    x = R * np.deg2rad(lon)
    y = R * np.log(np.tan(np.pi / 4 + np.deg2rad(np.clip(lat, -85, 85)) / 2))
    return x, y

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', type=Path, required=True)
    ap.add_argument('--mesh-cache', type=Path, required=True)
    ap.add_argument('--forecast', type=Path, required=True)
    ap.add_argument('--out-dir', type=Path, required=True)
    ap.add_argument('--width', type=int, default=900)
    ap.add_argument('--height', type=int, default=650)
    ap.add_argument('--frames', type=int, default=0,
                    help='number of phase frames to publish; 0 uses source horizon')
    args = ap.parse_args()

    mesh = dict(np.load(args.mesh_cache, allow_pickle=False))
    x = np.asarray(mesh['x'], float); y = np.asarray(mesh['y'], float)
    tri = np.asarray(mesh['elements'], np.int32)
    ds = LocalClassicNetCDF(args.source)
    try:
        source_count = int(ds.ds.variables['zeta'].data.shape[0])
        node_ids = np.asarray(mesh['node_ids'], np.int64)
        z = (read_zeta(ds, node_ids, np.arange(source_count, dtype=int)) * 3.280839895).astype(np.float32)
        depth_var = ds.ds.variables.get('depth')
        if depth_var is None: raise SystemExit('native source lacks depth')
        depth = np.asarray(depth_var.data[node_ids], float)
    finally:
        ds.close()

    finite = np.isfinite(z)
    lo = np.full(z.shape[1], np.nan); hi = np.full(z.shape[1], np.nan)
    good = finite.any(axis=0) & (depth > 0)
    lo[good] = np.nanmin(np.where(finite[:, good], z[:, good], np.nan), axis=0)
    hi[good] = np.nanmax(np.where(finite[:, good], z[:, good], np.nan), axis=0)
    half = (hi - lo) / 2
    valid = good & np.isfinite(half) & (half > 1e-4) & finite.all(axis=0)
    target_count = max(source_count, int(args.frames or source_count))
    extension_hours = max(0, target_count - source_count)
    synth = None
    if extension_hours:
        # The source HTP horizon is shorter than the seven-day display. Extend
        # the native field by fitting the complete available tide signal to the
        # eight known astronomical frequencies, then synthesizing only the
        # missing tail. This preserves native spatial resolution and all
        # constituents without silently falling back to the 17x21 raster.
        periods = np.array([12.4206, 12.0, 12.6583, 11.9672,
                            23.9345, 25.8193, 24.0659, 26.8684], dtype=np.float32)
        t = np.arange(source_count, dtype=np.float32)
        cols = [np.ones(source_count, dtype=np.float32)]
        for period in periods:
            w = 2 * np.pi / period
            cols.extend((np.cos(w * t), np.sin(w * t)))
        design = np.column_stack(cols).astype(np.float32)
        pinv = np.linalg.pinv(design).astype(np.float32)
        coeff = pinv @ np.nan_to_num(z, nan=0.0)
        # Keep the source horizon in memory and synthesize only the requested
        # frame. Materializing target_count x node_count here exhausted RAM on
        # the complete native mesh.
        def synth(hour):
            row = [1.0]
            for period in periods:
                w = 2 * np.pi / period
                row.extend((np.cos(w * hour), np.sin(w * hour)))
            return np.asarray(row, dtype=np.float32) @ coeff
        count = target_count
    else:
        count = source_count

    # The phase map represents the combined HTP waveform, not M2. There is no
    # unique harmonic phase for a multi-constituent signal, and a Hilbert
    # transform creates severe edge artifacts at the first/last forecast
    # frame. Use the total signal value plus its edge-safe time derivative:
    # high(0) -> falling(.25) -> low(.5) -> rising(.75). The M2 period below
    # is only a dimensionless slope normalization; all constituents remain in
    # z and determine the actual direction.
    phase = np.full((count, z.shape[1]), np.nan, dtype=np.float32)
    omega_ref = 2 * np.pi / 12.42
    for k in range(count):
        value = z[k] if k < source_count else synth(k)
        if k == 0:
            nxt = z[1] if source_count > 1 else synth(1)
            derivative = nxt - value
        elif k == count - 1:
            prv = z[k - 1] if k - 1 < source_count else synth(k - 1)
            derivative = value - prv
        else:
            prv = z[k - 1] if k - 1 < source_count else synth(k - 1)
            nxt = z[k + 1] if k + 1 < source_count else synth(k + 1)
            derivative = (nxt - prv) / 2.0
        centered = value - (hi + lo) / 2
        phase[k] = (np.arctan2(-derivative, centered * omega_ref) / (2*np.pi)) % 1.0
        phase[k, ~valid] = np.nan

    mx, my = mercator(x, y)
    # TIDE palette in B,G,R,A order for OpenCV. Rendering one fillPoly call
    # per palette bucket is orders of magnitude cheaper and more bounded than
    # asking Matplotlib to retain a half-million native paths per frame.
    # Must match the viewer's TIDE scale exactly, in B,G,R,A order. Falling
    # colors are darker than rising colors by design.
    palette = np.array([
        [39,48,215,255], [50,106,214,255], [63,181,212,255],
        [69,159,95,255], [180,117,69,255], [106,214,155,255],
        [138,240,255,255], [114,173,255,255], [39,48,215,255]
    ], dtype=np.uint8)
    tri_valid = np.isfinite(phase[0])[tri].all(axis=1)
    tri_indices = tri[tri_valid]
    xmin, xmax = float(mx.min()), float(mx.max()); ymin, ymax = float(my.min()), float(my.max())
    px = np.rint((mx - xmin) / (xmax - xmin) * (args.width - 1)).astype(np.int32)
    py = np.rint((ymax - my) / (ymax - ymin) * (args.height - 1)).astype(np.int32)
    pixel_triangles = np.stack((px[tri_indices], py[tri_indices]), axis=2)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for k in range(count):
        # Phase is circular. Never interpolate scalar phase values across the
        # 0/1 seam (0.99 and 0.01 are neighbours, not opposites). Reduce each
        # native triangle in unit-vector space and paint one face value. This
        # removes the false bands caused by linear interpolation through 0.5.
        values = phase[k][tri_indices]
        face_phase = np.mod(np.arctan2(np.sin(values * 2*np.pi).sum(axis=1),
                                       np.cos(values * 2*np.pi).sum(axis=1)) / (2*np.pi), 1.0)
        canvas = np.zeros((args.height, args.width, 4), dtype=np.uint8)
        buckets = np.minimum(8, (face_phase * 9).astype(np.int32))
        for bucket in range(9):
            selected = pixel_triangles[buckets == bucket]
            if len(selected):
                cv2.fillPoly(canvas, selected, tuple(int(v) for v in palette[bucket]))
        out = args.out_dir / f'frame-{k:03d}.png'
        # Save optimized RGBA PNG; no axes/background pixels are shipped.
        Image.fromarray(canvas, mode='RGBA').save(out, optimize=True)
        if k % 4 == 3:
            gc.collect()
    payload = json.loads(args.forecast.read_text())
    payload.setdefault('native_mesh', {})['phase_tiles'] = {
        'pattern': 'native_phase/frame-{frame:03d}.png', 'frames': count,
        'width': args.width, 'height': args.height, 'projection': 'EPSG:3857',
        'bbox_mercator': [xmin, ymin, xmax, ymax],
        'definition': 'combined-signal stage from total HTP value and edge-safe time derivative; circular native-triangle phase averaging; high/falling/low/rising; same native triangles as co-range',
        'source_frames': source_count, 'extended_frames': extension_hours,
        'extension_method': ('eight-constituent least-squares continuation of native HTP'
                             if extension_hours else 'none')
    }
    args.forecast.write_text(json.dumps(payload, allow_nan=False, separators=(',', ':')))
    print(json.dumps({'frames': count, 'nodes': int(len(x)), 'triangles': int(tri_valid.sum()), 'out_dir': str(args.out_dir)}))

if __name__ == '__main__': main()
