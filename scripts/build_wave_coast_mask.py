#!/usr/bin/env python3
"""Build a high-resolution water alpha mask from an authoritative shoreline.

This mask is deliberately independent of wave-data coverage.  Wave products
keep every finite source value; the mask only clips pixels at render time.
"""
import argparse, json
from pathlib import Path

import numpy as np
from PIL import Image
from cartopy.io import shapereader
from rasterio.features import rasterize
from rasterio.transform import from_origin
from shapely.geometry import box, shape


def build(payload, output, width=2000, height=1600):
    bbox = payload.get("display_bbox") or payload["bbox"]
    west, south, east, north = map(float, bbox)
    land_box = box(west, south, east, north)
    transform = from_origin(west, north, (east-west)/width, (north-south)/height)
    land_shapes = []
    reader = shapereader.Reader(shapereader.natural_earth(
        resolution="10m", category="physical", name="land"))
    for record in reader.records():
        geom = record.geometry
        if geom is not None and geom.intersects(land_box):
            land_shapes.append((geom, 0))
    water = rasterize(land_shapes, out_shape=(height, width), transform=transform,
                      fill=255, dtype="uint8", all_touched=False)
    output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(water, mode="L").save(output, optimize=True)
    payload["wave_coast_mask_contract"] = {
        "kind": "high_resolution_shoreline_alpha",
        "source": "Natural Earth 10m land polygons",
        "purpose": "render-time clipping only; never a wave-data validity mask",
        "water_value": 255,
        "land_value": 0,
        "width": width,
        "height": height,
        "bbox": [west, south, east, north],
    }
    products = ["wave_height_ft", "swell_height_ft", "wind_wave_height_ft"]
    payload["wave_source_contract"] = {
        "validity": "product/frame value is valid when finite at the source grid corner",
        "products": ["wave_height_ft", "swell_height_ft", "wind_wave_height_ft"],
        "zero_is_valid_calm_water": True,
        "missing_values": ["null", "NaN", "fill"],
        "coast_mask_is_not_coverage": True,
        "valid_source_cells_by_product": {
            key: sum(
                all(v is not None and np.isfinite(v) for v in (row[xi], row[xi + 1], next_row[xi], next_row[xi + 1]))
                for frame in payload.get("frames", [])
                for yi, (row, next_row) in enumerate(zip(frame.get(key, [])[:-1], frame.get(key, [])[1:]))
                for xi in range(max(0, len(row) - 1))
            )
            for key in products
        },
    }
    payload.pop("wave_water_cells", None)
    payload.pop("wave_water_mask_contract", None)
    return payload


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("input", type=Path)
    ap.add_argument("outputs", nargs="+", type=Path)
    ap.add_argument("--mask-output", type=Path, required=True)
    ap.add_argument("--width", type=int, default=2000)
    ap.add_argument("--height", type=int, default=1600)
    args = ap.parse_args()
    payload = json.loads(args.input.read_text())
    payload = build(payload, args.mask_output, args.width, args.height)
    encoded = json.dumps(payload, allow_nan=False, separators=(",", ":"))
    for path in args.outputs:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(encoded)
    print(json.dumps({"mask": str(args.mask_output), "bytes": args.mask_output.stat().st_size,
                      "outputs": [str(p) for p in args.outputs]}))


if __name__ == "__main__":
    main()
