#!/usr/bin/env python3
"""Build transparent, correctly georeferenced XYZ tiles for verified canyon surveys."""
import math
from pathlib import Path
import numpy as np
import rasterio
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

R = 6378137.0
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dashboard/data/bathy/canyon_tiles"
SOURCES = {
    "ex1302": ROOT / "dashboard/data/bathy/canyon_products/ex1302_50m_wm.tif",
    "ex1903l2": ROOT / "dashboard/data/bathy/canyon_products/ex1903l2_north_25m_wm.tif",
}
PALETTE = np.array([[3, 1, 7], [22, 10, 70], [49, 32, 154],
                    [21, 94, 208], [8, 167, 211], [24, 208, 203]], dtype=np.float32)
VMIN, VMAX = -2500.0, 0.0

def tile_bounds(z, x, y):
    n = 2 ** z
    return (x / n * 2 * math.pi * R - math.pi * R,
            (1 - 2 * (y + 1) / n) * math.pi * R,
            (x + 1) / n * 2 * math.pi * R - math.pi * R,
            (1 - 2 * y / n) * math.pi * R)

def colorize(a, valid):
    valid = valid & np.isfinite(a) & (a < -0.001)
    q = np.clip((a - VMIN) / (VMAX - VMIN), 0, 1) * (len(PALETTE) - 1)
    lo = np.floor(q).astype(np.int16)
    hi = np.minimum(lo + 1, len(PALETTE) - 1)
    f = (q - lo)[..., None]
    rgb = (PALETTE[lo] * (1 - f) + PALETTE[hi] * f).astype(np.uint8)
    return np.concatenate([rgb, (valid.astype(np.uint8) * 255)[..., None]], axis=2)

for name, path in SOURCES.items():
    with rasterio.open(path) as ds:
        for z in range(5, 14):
            n = 2 ** z
            minx = max(0, int(math.floor((ds.bounds.left + math.pi * R) / (2 * math.pi * R) * n)))
            maxx = min(n - 1, int(math.floor((ds.bounds.right + math.pi * R) / (2 * math.pi * R) * n)))
            miny = max(0, int(math.floor((1 - ds.bounds.top / (math.pi * R)) / 2 * n)))
            maxy = min(n - 1, int(math.floor((1 - ds.bounds.bottom / (math.pi * R)) / 2 * n)))
            for x in range(minx, maxx + 1):
                for y in range(miny, maxy + 1):
                    left, bottom, right, top = tile_bounds(z, x, y)
                    data = ds.read(1, window=from_bounds(left, bottom, right, top, ds.transform),
                                   out_shape=(256, 256), resampling=Resampling.bilinear,
                                   boundless=True, masked=True)
                    valid = ~np.ma.getmaskarray(data)
                    a = np.asarray(data.data, dtype=np.float32)
                    out = colorize(a, valid)
                    dest = OUT / name / "color" / str(z) / str(x)
                    dest.mkdir(parents=True, exist_ok=True)
                    Image.fromarray(out, "RGBA").save(dest / f"{y}.png", optimize=True)
    print(name, "done", flush=True)
