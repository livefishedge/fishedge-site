#!/usr/bin/env python3
"""Fetch named NOAA Okeanos elevation rasters and build transparent XYZ tiles."""
import json, math, sys
from pathlib import Path
import requests
import numpy as np
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import calculate_default_transform, reproject, Resampling
from rasterio.crs import CRS

ROOT = Path(__file__).resolve().parents[1]
PRODUCTS = ROOT / "dashboard/data/bathy/canyon_products"
TILES = ROOT / "dashboard/data/bathy/canyon_tiles"
API = "https://gis.ngdc.noaa.gov/arcgis/rest/services/OceanExploration/okeanos_explorer_grids/ImageServer"
R = 6378137.0
PALETTE = np.array([[3,1,7],[22,10,70],[49,32,154],[21,94,208],[8,167,211],[24,208,203]], dtype=np.float32)

SOURCES = {
    "ex1106_baltimore_25m": (68, 25, 13),
    "ex1106_keller_25m": (66, 25, 13),
    "ex1201_hendrickson_toms_25m": (69, 25, 13),
    "ex1201_mcmaster_ryan_25m": (70, 25, 13),
    "ex1205l2_hudson_25m": (88, 25, 13),
    "ex1904_va_ny_20m": (260, 20, 12),
    "ex1904_ny_ri_20m": (258, 20, 12),
    "ex1904_rov_30m": (259, 30, 11),
    "ex1906_north_25m": (265, 25, 11),
    "ex2103_canyons_20m": (278, 20, 13),
    "ex2105_transit_25m": (290, 25, 11),
    "ex2205_transit1_50m": (311, 50, 11),
    "ex2205_transit2_50m": (312, 50, 11),
}

def wm(lon, lat):
    return lon * math.pi * R / 180, math.log(math.tan((90 + lat) * math.pi / 360)) * R

def api_json(path, params):
    r = requests.get(API + path, params=params, timeout=180)
    r.raise_for_status()
    return r.json()

def catalog_item(oid):
    d = api_json("/query", {"f":"json", "objectIds":str(oid), "outFields":"OBJECTID,Name,CruiseID", "returnGeometry":"true", "outSR":"4326"})
    f = d["features"][0]; pts = [p for ring in f["geometry"]["rings"] for p in ring]
    return f["attributes"], (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))

def fetch(name, oid, nominal, max_zoom):
    attrs, bb = catalog_item(oid)
    w, s, e, n = bb
    x1, y1 = wm(w, s); x2, y2 = wm(e, n)
    ratio = (x2-x1)/(y2-y1)
    width = min(5000, max(1200, int(2600 * ratio)))
    height = min(5000, max(1200, int(width / ratio)))
    params = {"f":"json", "bbox":f"{x1},{y1},{x2},{y2}", "bboxSR":"3857", "imageSR":"3857", "size":f"{width},{height}", "format":"tiff", "pixelType":"F32", "noData":"-99999", "interpolation":"RSP_Bilinear", "mosaicRule":json.dumps({"lockRasterIds":[oid]})}
    meta = api_json("/exportImage", params)
    href = meta.get("href")
    if not href: raise RuntimeError(f"no export href for {name}: {meta}")
    raw = requests.get(href, timeout=300); raw.raise_for_status()
    PRODUCTS.mkdir(parents=True, exist_ok=True)
    wm_path = PRODUCTS / f"{name}_wm.tif"; wm_path.write_bytes(raw.content)
    with rasterio.open(wm_path) as ds:
        a = ds.read(1, masked=True).astype("float32")
        valid = np.isfinite(a) & (a < -0.001)
        if valid.sum() == 0: raise RuntimeError(f"{name} has no valid depths")
        stats = {"min":float(a[valid].min()), "max":float(a[valid].max()), "valid":int(valid.sum()), "shape":list(a.shape), "bounds":bb, "nominal_m":nominal, "objectid":oid}
    (PRODUCTS / f"{name}.json").write_text(json.dumps(stats, indent=2))
    build_tiles(name, wm_path, max_zoom)
    print(name, json.dumps(stats), flush=True)

def tile_bounds(z, x, y):
    N=2**z
    return (x/N*2*math.pi*R-math.pi*R, (1-2*(y+1)/N)*math.pi*R, (x+1)/N*2*math.pi*R-math.pi*R, (1-2*y/N)*math.pi*R)

def build_tiles(name, path, max_zoom):
    from PIL import Image
    from rasterio.windows import from_bounds
    with rasterio.open(path) as ds:
        for z in range(5, max_zoom+1):
            N=2**z; minx=max(0,int(math.floor((ds.bounds.left+math.pi*R)/(2*math.pi*R)*N))); maxx=min(N-1,int(math.floor((ds.bounds.right+math.pi*R)/(2*math.pi*R)*N)))
            miny=max(0,int(math.floor((1-ds.bounds.top/(math.pi*R))/2*N))); maxy=min(N-1,int(math.floor((1-ds.bounds.bottom/(math.pi*R))/2*N)))
            for x in range(minx,maxx+1):
                for y in range(miny,maxy+1):
                    b=tile_bounds(z,x,y); d=ds.read(1, window=from_bounds(*b, ds.transform), out_shape=(256,256), resampling=Resampling.bilinear, boundless=True, masked=True)
                    a=np.asarray(d.data,dtype=np.float32); valid=(~np.ma.getmaskarray(d)) & np.isfinite(a) & (a < -0.001)
                    q=np.clip((a+2500)/2500,0,1)*5; lo=np.floor(q).astype(np.int16); hi=np.minimum(lo+1,5); f=(q-lo)[...,None]
                    rgb=(PALETTE[lo]*(1-f)+PALETTE[hi]*f).astype(np.uint8); out=np.concatenate([rgb,(valid.astype(np.uint8)*255)[...,None]],axis=2)
                    dest=TILES/name/"color"/str(z)/str(x); dest.mkdir(parents=True,exist_ok=True); Image.fromarray(out,"RGBA").save(dest/f"{y}.png", optimize=True)

if __name__ == "__main__":
    for name,(oid,nominal,mz) in SOURCES.items(): fetch(name,oid,nominal,mz)
