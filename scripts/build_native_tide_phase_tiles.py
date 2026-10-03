#!/usr/bin/env python3
"""Render native STOFS HTP tidal phase tiles for the browser overlay.

The tiles are derived from the same native nodes/elements and complete HTP
horizon used for co-range.  They are Web-Mercator images so the browser can
place them exactly over the OpenLayers map without shipping a million-node
mesh to the client.
"""
import argparse, json
import gc
import hashlib
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
from fetch_stofs_global_harmonics import RemoteClassicNetCDF

R = 6378137.0
def mercator(lon, lat):
    x = R * np.deg2rad(lon)
    y = R * np.log(np.tan(np.pi / 4 + np.deg2rad(np.clip(lat, -85, 85)) / 2))
    return x, y

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', type=Path)
    ap.add_argument('--source-url', help='verified NOAA HTP URL; reads only regional byte ranges')
    ap.add_argument('--mesh-cache', type=Path, required=True)
    ap.add_argument('--forecast', type=Path, required=True)
    ap.add_argument('--out-dir', type=Path, required=True)
    ap.add_argument('--checkpoint-dir', type=Path,
                    help='reuse resumable per-hour zeta slices from native extraction')
    ap.add_argument('--width', type=int, default=900)
    ap.add_argument('--height', type=int, default=650)
    ap.add_argument('--frames', type=int, default=0,
                    help='number of phase frames to publish; 0 uses source horizon')
    ap.add_argument('--tile-zoom', type=int, default=8,
                    help='Web-Mercator tile zoom for the browser asset pyramid')
    ap.add_argument('--tile-size', type=int, default=512,
                    help='pixel size of each native stage tile')
    ap.add_argument('--hotspot-bbox', type=float, nargs=4, metavar=('WEST','SOUTH','EAST','NORTH'),
                    help='optional WGS84 bbox for a selective high-resolution patch')
    ap.add_argument('--asset-version', help='immutable phase-asset version; defaults to a source/checkpoint checksum')
    ap.add_argument('--source-object', help='immutable NOAA source object key for provenance')
    ap.add_argument('--source-etag', help='NOAA source ETag/transport identity when remote range-reading')
    args = ap.parse_args()

    mesh = dict(np.load(args.mesh_cache, allow_pickle=False))
    x = np.asarray(mesh['x'], float); y = np.asarray(mesh['y'], float)
    tri = np.asarray(mesh['elements'], np.int32)
    if args.source and args.source_url:
        raise SystemExit('choose --source or --source-url, not both')
    if not args.source and not args.source_url and not args.checkpoint_dir:
        raise SystemExit('one of --source, --source-url, or --checkpoint-dir is required')
    if args.checkpoint_dir:
        files = sorted(args.checkpoint_dir.glob('hour-*.npy'))
        if not files: raise SystemExit('native checkpoint has no hourly slices')
        z = np.stack([np.load(path, allow_pickle=False) for path in files]).astype(np.float32)
        source_count = z.shape[0]
        depth = None
    else:
        ds = RemoteClassicNetCDF(args.source_url) if args.source_url else LocalClassicNetCDF(args.source)
        try:
            source_count = int(ds.ds.variables['zeta'].data.shape[0])
            node_ids = np.asarray(mesh['node_ids'], np.int64)
            z = (read_zeta(ds, node_ids, np.arange(source_count, dtype=int)) * 3.280839895).astype(np.float32)
            depth_var = ds.ds.variables.get('depth')
            if depth_var is None: raise SystemExit('native source lacks depth')
            depth = (None if args.source_url else np.asarray(depth_var.data[node_ids], float))
        finally:
            ds.close()

    # Co-range uses the same native wet-node rule as this source-derived
    # range: a node is drawable when it has any finite HTP value and positive
    # native depth. Do not add a stricter all-frames/threshold test here; it
    # would create a different coastal footprint from co-range.

    finite = np.isfinite(z)
    lo = np.full(z.shape[1], np.nan); hi = np.full(z.shape[1], np.nan)
    if depth is None:
        source_forecast = json.loads(args.forecast.read_text())
        native_range = np.asarray([(np.nan if v is None else float(v)) for v in (source_forecast.get('native_mesh') or {}).get('range_ft', [])])
        # Pages packages omit raw node ranges to stay below the payload limit;
        # the checkpointed native zeta series is then the authoritative
        # validity source.
        good = finite.any(axis=0)
        if native_range.size == good.size:
            good &= np.isfinite(native_range)
    else:
        good = finite.any(axis=0) & (depth > 0)
    lo[good] = np.nanmin(np.where(finite[:, good], z[:, good], np.nan), axis=0)
    hi[good] = np.nanmax(np.where(finite[:, good], z[:, good], np.nan), axis=0)
    half = (hi - lo) / 2
    valid = good
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
    # Must match the viewer's TIDE scale exactly, in RGBA order. The canvas is
    # an RGBA NumPy array passed to Pillow; using OpenCV's BGR convention here
    # swaps red/blue in the shipped PNG and makes the map disagree with the
    # colorbar. Falling colors are darker than rising colors by design.
    palette = np.array([
        [215,48,39,255], [214,106,50,255], [212,181,63,255],
        [95,159,69,255], [69,117,180,255], [155,214,106,255],
        [255,240,138,255], [255,173,114,255], [215,48,39,255]
    ], dtype=np.uint8)
    # A coastal face may straddle wet/dry native nodes. Do not paint an entire
    # face from partial validity: that colors dry embankments and inlets. A
    # face is eligible only when all three native nodes have a valid complete
    # horizon. Missing/indeterminate faces remain transparent.
    tri_valid = valid[tri].all(axis=1)
    tri_indices = tri[tri_valid]
    # Anchor the raster to the same valid native wet-face envelope used by
    # the contour product. The full mesh cache includes a narrow outer frame
    # of boundary/land nodes; using it as the image extent subtly shifts the
    # apparent shoreline relative to native co-range contours.
    forecast_payload = json.loads(args.forecast.read_text())
    valid_nodes = np.unique(tri_indices)
    xmin, xmax = float(mx[valid_nodes].min()), float(mx[valid_nodes].max())
    ymin, ymax = float(my[valid_nodes].min()), float(my[valid_nodes].max())
    # The image must cover the authoritative configured region. A contour
    # envelope is not a coverage envelope: it can omit the outer shelf and
    # coastal areas where no contour level happens to occur.
    region_bbox = forecast_payload.get('bbox')
    if not (isinstance(region_bbox, list) and len(region_bbox) == 4):
        region_bbox = [float(v) for v in (args.hotspot_bbox or [])]
    if len(region_bbox) != 4:
        raise SystemExit('forecast lacks authoritative regional bbox')
    xmin, ymin = mercator(float(region_bbox[0]), float(region_bbox[1]))
    xmax, ymax = mercator(float(region_bbox[2]), float(region_bbox[3]))
    if args.hotspot_bbox:
        west, south, east, north = args.hotspot_bbox
        xmin, ymin = mercator(west, south)
        xmax, ymax = mercator(east, north)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    world = 2 * np.pi * R
    tile_n = 2 ** args.tile_zoom
    tile_world = world / tile_n
    tx0 = max(0, int(np.floor((xmin + world / 2) / tile_world)))
    tx1 = min(tile_n - 1, int(np.floor((xmax + world / 2) / tile_world)))
    ty0 = max(0, int(np.floor((world / 2 - ymax) / tile_world)))
    ty1 = min(tile_n - 1, int(np.floor((world / 2 - ymin) / tile_world)))
    tile_indices = [{'x': tx, 'y': ty} for tx in range(tx0, tx1 + 1)
                    for ty in range(ty0, ty1 + 1)]
    # Write exactly beneath the manifest directory. The previous implicit
    # "_tiles" suffix produced native_phase_tiles_tiles while the manifest
    # and uploader referenced native_phase_tiles.
    tile_root = args.out_dir / f'z{args.tile_zoom}'
    # Project vertices directly into the global XYZ tile pixel coordinate
    # system.  The previous implementation rasterized into a cropped bbox,
    # then resized/cropped that image into tiles; that made the valid-face
    # shoreline subtly disagree with the vector co-range geometry at tile
    # boundaries.  Direct tile-pixel projection has one authoritative
    # Web-Mercator transform on both the generator and the browser.
    gx = (mx + world / 2) / tile_world * args.tile_size
    gy = (world / 2 - my) / tile_world * args.tile_size
    global_triangles = np.stack((gx[tri_indices], gy[tri_indices]), axis=2)
    tri_x0 = global_triangles[:, :, 0].min(axis=1)
    tri_x1 = global_triangles[:, :, 0].max(axis=1)
    tri_y0 = global_triangles[:, :, 1].min(axis=1)
    tri_y1 = global_triangles[:, :, 1].max(axis=1)
    for k in range(count):
        # Phase is circular. Never interpolate scalar phase values across the
        # 0/1 seam (0.99 and 0.01 are neighbours, not opposites). Reduce each
        # native triangle in unit-vector space and paint one face value. This
        # removes the false bands caused by linear interpolation through 0.5.
        values = phase[k][tri_indices]
        finite_values = np.isfinite(values).all(axis=1)
        face_phase = np.full(len(values), np.nan, dtype=np.float32)
        if finite_values.any():
            face_phase[finite_values] = np.mod(
                np.arctan2(np.sum(np.sin(values[finite_values] * 2*np.pi), axis=1),
                           np.sum(np.cos(values[finite_values] * 2*np.pi), axis=1))
                / (2*np.pi), 1.0)
        buckets = np.full(len(face_phase), -1, dtype=np.int32)
        finite_faces = np.isfinite(face_phase)
        buckets[finite_faces] = np.minimum(8, (face_phase[finite_faces] * 9).astype(np.int32))
        for tile in tile_indices:
            tx, ty = tile['x'], tile['y']
            tile_img = np.zeros((args.tile_size, args.tile_size, 4), dtype=np.uint8)
            # Only submit faces whose projected bounds intersect this tile;
            # this keeps the direct-projection path bounded on the large mesh.
            xlo, xhi = tx * args.tile_size, (tx + 1) * args.tile_size
            ylo, yhi = ty * args.tile_size, (ty + 1) * args.tile_size
            intersects = ((tri_x1 >= xlo) & (tri_x0 <= xhi) &
                          (tri_y1 >= ylo) & (tri_y0 <= yhi))
            for bucket in range(9):
                selected = global_triangles[intersects & (buckets == bucket)].copy()
                if len(selected):
                    selected[:, :, 0] -= xlo
                    selected[:, :, 1] -= ylo
                    cv2.fillPoly(tile_img, selected.astype(np.int32),
                                 tuple(int(v) for v in palette[bucket]))
            tile_img = Image.fromarray(tile_img, mode='RGBA')
            tile_out = tile_root / str(tx) / str(ty) / f'frame-{k:03d}.png'
            tile_out.parent.mkdir(parents=True, exist_ok=True)
            # Land/invalid triangles retain alpha=0 all the way into the
            # browser; no regular-grid or bbox resampling is involved.
            tile_img.save(tile_out, optimize=True)
        if k % 4 == 3:
            gc.collect()
    payload = forecast_payload
    frame_times = []
    frame_manifest = payload.get('frames_manifest') or {}
    chunks_dir = args.forecast.parent / str(frame_manifest.get('dir', 'frames/'))
    for chunk in frame_manifest.get('chunks', []):
        chunk_path = chunks_dir / chunk
        if not chunk_path.is_file():
            continue
        chunk_payload = json.loads(chunk_path.read_text())
        frame_times.extend(str(item.get('time')) for item in chunk_payload.get('frames', [])
                           if item.get('time'))
    phase_manifest = {
        'pattern': f'native_phase_tiles/z{args.tile_zoom}/{{x}}/{{y}}/frame-{{frame:03d}}.png',
        'frames': count, 'tile_zoom': args.tile_zoom, 'tile_size': args.tile_size,
        'tile_indices': tile_indices, 'width': args.width, 'height': args.height,
        'projection': 'EPSG:3857',
        'bbox_mercator': [xmin, ymin, xmax, ymax],
        'definition': 'combined-signal stage from total HTP value and edge-safe time derivative; circular native-triangle phase averaging; high/falling/low/rising; same native triangles as co-range',
        'coverage_contract': 'native_mesh_co_range_wet_faces',
        'native_node_count': int(len(x)),
        'native_wet_node_count': int(valid.sum()),
        'native_triangle_count': int(tri_valid.sum()),
        'source_frames': source_count, 'extended_frames': extension_hours,
        'frame_times': frame_times[:count],
        'extension_method': ('eight-constituent least-squares continuation of native HTP'
                             if extension_hours else 'none')
    }
    source_meta = (forecast_payload.get('native_mesh') or {}).get('source') or {}
    if args.source_object or source_meta.get('object'):
        phase_manifest['source_object'] = args.source_object or source_meta['object']
    if args.source_etag:
        phase_manifest['source_etag'] = args.source_etag
    elif source_meta.get('sha256'):
        phase_manifest['source_sha256'] = source_meta['sha256']
    if args.asset_version:
        phase_manifest['asset_version'] = str(args.asset_version)
    elif args.checkpoint_dir:
        phase_manifest['asset_version'] = hashlib.sha256(
            ('|'.join(str(p.stat().st_size) + ':' + str(p.stat().st_mtime_ns)
                      for p in sorted(args.checkpoint_dir.glob('hour-*.npy')))).encode()
        ).hexdigest()[:20]
    else:
        # The path is stable across hourly source cycles; hashing it leaves
        # browsers reusing old phase PNGs after a new NOAA cycle is published.
        # Use the immutable source content identity for cache invalidation.
        digest = hashlib.sha256()
        with args.source.open('rb') as source_file:
            for block in iter(lambda: source_file.read(8 * 1024 * 1024), b''):
                digest.update(block)
        phase_manifest['asset_version'] = digest.hexdigest()[:20]
    native_payload = payload.setdefault('native_mesh', {})
    if args.hotspot_bbox:
        # Keep the nationwide/base atlas untouched; selective patches are
        # loaded only after the map zooms into this bbox.
        existing = native_payload.setdefault('phase_tiles', {})
        patches = existing.setdefault('patches', [])
        patch = dict(phase_manifest)
        patch['hotspot_bbox'] = [float(v) for v in args.hotspot_bbox]
        patches[:] = [p for p in patches if p.get('tile_zoom') != args.tile_zoom or p.get('hotspot_bbox') != patch['hotspot_bbox']]
        patches.append(patch)
        native_payload['phase_tiles'] = existing
    else:
        native_payload['phase_tiles'] = phase_manifest
    args.forecast.write_text(json.dumps(payload, allow_nan=False, separators=(',', ':')))
    print(json.dumps({'frames': count, 'nodes': int(len(x)), 'triangles': int(tri_valid.sum()), 'out_dir': str(args.out_dir)}))

if __name__ == '__main__': main()
