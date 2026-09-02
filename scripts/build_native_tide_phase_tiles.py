#!/usr/bin/env python3
"""Render native STOFS HTP tidal phase tiles for the browser overlay.

The tiles are derived from the same native nodes/elements and complete HTP
horizon used for co-range.  They are Web-Mercator images so the browser can
place them exactly over the OpenLayers map without shipping a million-node
mesh to the client.
"""
import argparse, json
from pathlib import Path
import numpy as np
from scipy.io import netcdf_file
import matplotlib.pyplot as plt
import matplotlib.tri as mtri
from matplotlib.colors import ListedColormap, Normalize
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
    args = ap.parse_args()

    mesh = dict(np.load(args.mesh_cache, allow_pickle=False))
    x = np.asarray(mesh['x'], float); y = np.asarray(mesh['y'], float)
    tri = np.asarray(mesh['elements'], np.int32)
    ds = LocalClassicNetCDF(args.source)
    try:
        count = int(ds.ds.variables['zeta'].data.shape[0])
        node_ids = np.asarray(mesh['node_ids'], np.int64)
        z = read_zeta(ds, node_ids, np.arange(count, dtype=int)) * 3.280839895
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
    # The phase map represents the combined HTP waveform, not M2. There is no
    # unique harmonic phase for a multi-constituent signal, and a Hilbert
    # transform creates severe edge artifacts at the first/last forecast
    # frame. Use the total signal value plus its edge-safe time derivative:
    # high(0) -> falling(.25) -> low(.5) -> rising(.75). The M2 period below
    # is only a dimensionless slope normalization; all constituents remain in
    # z and determine the actual direction.
    phase = np.full_like(z, np.nan)
    derivative = np.empty_like(z)
    derivative[1:-1] = (z[2:] - z[:-2]) / 2.0
    derivative[0] = z[1] - z[0]
    derivative[-1] = z[-1] - z[-2]
    omega_ref = 2 * np.pi / 12.42
    for k in range(count):
        centered = z[k] - (hi + lo) / 2
        phase[k] = (np.arctan2(-derivative[k], centered * omega_ref) / (2*np.pi)) % 1.0
        phase[k, ~valid] = np.nan

    mx, my = mercator(x, y)
    # TIDE palette: high red, falling/yellow-green, low blue, rising back red.
    cmap = ListedColormap(['#d73027','#fc8d59','#fee08b','#91cf60','#4575b4','#91cf60','#fee08b','#fc8d59','#d73027'])
    norm = Normalize(0, 1)
    tri_valid = np.isfinite(phase[0])[tri].all(axis=1)
    tri_obj = mtri.Triangulation(mx, my, tri[tri_valid])
    xmin, xmax = float(mx.min()), float(mx.max()); ymin, ymax = float(my.min()), float(my.max())
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for k in range(count):
        fig = plt.figure(figsize=(args.width/100, args.height/100), dpi=100, frameon=False)
        ax = fig.add_axes([0, 0, 1, 1]); ax.set_axis_off(); ax.set_xlim(xmin, xmax); ax.set_ylim(ymin, ymax)
        ax.tripcolor(tri_obj, phase[k], cmap=cmap, norm=norm, shading='flat')
        out = args.out_dir / f'frame-{k:03d}.png'
        fig.savefig(out, dpi=100, transparent=True, bbox_inches=None, pad_inches=0)
        plt.close(fig)
        # Re-save optimized RGBA PNG; no axes/background pixels are shipped.
        Image.open(out).convert('RGBA').save(out, optimize=True)
    payload = json.loads(args.forecast.read_text())
    payload.setdefault('native_mesh', {})['phase_tiles'] = {
        'pattern': 'native_phase/frame-{frame:03d}.png', 'frames': count,
        'width': args.width, 'height': args.height, 'projection': 'EPSG:3857',
        'bbox_mercator': [xmin, ymin, xmax, ymax],
        'definition': 'combined-signal stage from total HTP value and edge-safe time derivative; high/falling/low/rising; same native triangles as co-range'
    }
    args.forecast.write_text(json.dumps(payload, allow_nan=False, separators=(',', ':')))
    print(json.dumps({'frames': count, 'nodes': int(len(x)), 'triangles': int(tri_valid.sum()), 'out_dir': str(args.out_dir)}))

if __name__ == '__main__': main()
