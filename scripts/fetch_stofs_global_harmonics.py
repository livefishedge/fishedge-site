#!/usr/bin/env python3
"""Lazy NOAA STOFS global HTP extraction for co-tidal/co-range maps.

The native STOFS HTP file is classic NetCDF with an unstructured ADCIRC mesh.
This reader uses HTTP Range requests: it downloads the header and mesh arrays
once, indexes only nodes/elements intersecting USEC-MD, then reads selected
zeta record spans for the requested forecast hours.  The global object is
never materialized locally or shipped to the viewer.

The resulting fields are M2/S2/K1/O1 harmonic amplitude and phase, rasterized
onto the existing 17x21 display grid.  No CO-OPS station interpolation is used
for these fields.
"""

import argparse
import datetime as dt
import json
import os
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
import requests
from scipy.io import netcdf_file
from scipy.spatial import cKDTree

S3 = "https://noaa-gestofs-pds.s3.amazonaws.com"
MESH_CACHE = Path(__file__).resolve().parents[1] / "data" / "usec_md" / "briefing" / ".stofs_mesh_cache.npz"
BBOX = [-77.0, 36.0, -72.0, 40.0]
STEP = 0.25
CONSTITUENTS = {"M2": 12.4206, "S2": 12.0, "K1": 23.9345, "O1": 25.8193}


class RemoteClassicNetCDF:
    """Small classic-NetCDF reader backed by byte-range HTTP requests."""

    def __init__(self, url):
        self.url = url
        head = requests.head(url, timeout=60)
        head.raise_for_status()
        self.size = int(head.headers["Content-Length"])
        self.tmp = tempfile.NamedTemporaryFile(prefix="stofs-header-", suffix=".nc", delete=False)
        self.path = self.tmp.name
        self.tmp.close()
        os.truncate(self.path, self.size)
        with open(self.path, "r+b") as f:
            f.write(self.range(0, min(self.size, 4 * 1024 * 1024)))
        self.ds = netcdf_file(self.path, mmap=False)

    def range(self, start, length):
        end = start + length - 1
        r = requests.get(self.url, headers={"Range": f"bytes={start}-{end}"}, timeout=180)
        r.raise_for_status()
        if len(r.content) != length:
            raise RuntimeError(f"short range read {len(r.content)} != {length}")
        return r.content

    def variable_bytes(self, name):
        var = self.ds.variables[name]
        count = int(np.prod(var.data.shape))
        return self.range(int(var._begin), count * var.data.dtype.itemsize)

    def close(self):
        self.ds.close()
        os.unlink(self.path)


def find_htp(date, cycle):
    prefix = f"stofs_2d_glo.{date}/{cycle}/rerun/"
    r = requests.get(f"{S3}/", params={"list-type": "2", "prefix": prefix, "max-keys": 1000}, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    keys = [e.text for e in root.findall("{*}Contents/{*}Key") if e.text]
    keys = [k for k in keys if k.endswith("stofs_2d_glo_tide.63.nc")]
    if not keys:
        raise RuntimeError(f"no STOFS HTP global file at {prefix}")
    return keys[0]


def mesh(remote):
    """Read/cache coordinates and triangle connectivity for USEC-MD."""
    if MESH_CACHE.exists():
        return dict(np.load(MESH_CACHE, allow_pickle=False))
    x = np.frombuffer(remote.variable_bytes("x"), dtype=remote.ds.variables["x"].data.dtype).copy()
    y = np.frombuffer(remote.variable_bytes("y"), dtype=remote.ds.variables["y"].data.dtype).copy()
    elements = np.frombuffer(remote.variable_bytes("element"), dtype=remote.ds.variables["element"].data.dtype).copy().reshape((-1, 3)) - 1
    node_ok = (x >= BBOX[0] - 0.5) & (x <= BBOX[2] + 0.5) & (y >= BBOX[1] - 0.5) & (y <= BBOX[3] + 0.5)
    selected_nodes = np.flatnonzero(node_ok)
    selected_set = np.zeros(len(x), dtype=bool); selected_set[selected_nodes] = True
    selected_elements = elements[np.all(selected_set[elements], axis=1)]
    MESH_CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(MESH_CACHE, x=x[selected_nodes], y=y[selected_nodes], node_ids=selected_nodes, elements=selected_elements)
    return dict(np.load(MESH_CACHE, allow_pickle=False))


def read_zeta(remote, node_ids, hours):
    var = remote.ds.variables["zeta"]
    itemsize = var.data.dtype.itemsize
    recsize = int(remote.ds._recsz)
    begin = int(var._begin)
    # Group node IDs into contiguous spans so each time step uses a small
    # number of range requests even though the source is unstructured.
    spans = []
    start = previous = int(node_ids[0])
    for value in node_ids[1:]:
        value = int(value)
        if value != previous + 1:
            spans.append((start, previous + 1)); start = value
        previous = value
    spans.append((start, previous + 1))
    out = np.full((len(hours), len(node_ids)), np.nan)
    positions = {int(node): i for i, node in enumerate(node_ids)}
    for ti, hour in enumerate(hours):
        for lo, hi in spans:
            raw = remote.range(begin + hour * recsize + lo * itemsize, (hi - lo) * itemsize)
            values = np.frombuffer(raw, dtype=var.data.dtype).astype(float)
            for offset, value in enumerate(values):
                out[ti, positions[lo + offset]] = np.nan if value < -9000 else value
    return out


def fit_and_rasterize(values, x, y, times):
    """Fit M2/S2/K1/O1 at mesh nodes, then inverse-distance rasterize."""
    lons = np.arange(BBOX[0], BBOX[2] + STEP / 2, STEP)
    lats = np.arange(BBOX[1], BBOX[3] + STEP / 2, STEP)
    t = np.asarray(times, dtype=float)
    cols = [np.ones(len(t))]
    for period in CONSTITUENTS.values():
        cols.extend((np.cos(2 * np.pi * t / period), np.sin(2 * np.pi * t / period)))
    design = np.column_stack(cols)
    coeff = np.full((design.shape[1], values.shape[1]), np.nan)
    for i in range(values.shape[1]):
        ok = np.isfinite(values[:, i])
        if ok.sum() >= design.shape[1] * 3:
            coeff[:, i] = np.linalg.lstsq(design[ok], values[ok, i], rcond=None)[0]
    tree = cKDTree(np.column_stack((x, y)))
    target = np.array([(lon, lat) for lat in lats for lon in lons])
    _, ix = tree.query(target, k=min(8, len(x)))
    if ix.ndim == 1: ix = ix[:, None]
    weights = 1 / np.maximum(1e-8, np.linalg.norm(np.column_stack((x, y))[ix] - target[:, None, :], axis=2) ** 2)
    weights /= weights.sum(axis=1, keepdims=True)
    result = {}
    for name, offset in zip(CONSTITUENTS, range(1, design.shape[1], 2)):
        ca = coeff[offset][ix]; cb = coeff[offset + 1][ix]
        valid = np.isfinite(ca) & np.isfinite(cb)
        safe_weights = np.where(valid, weights, 0.0)
        safe_weights /= np.maximum(safe_weights.sum(axis=1, keepdims=True), 1e-12)
        a = np.sum(safe_weights * np.where(valid, ca, 0.0), axis=1)
        b = np.sum(safe_weights * np.where(valid, cb, 0.0), axis=1)
        covered = valid.any(axis=1)
        a[~covered] = np.nan; b[~covered] = np.nan
        result[name] = {"amplitude_ft": (np.hypot(a, b) * 3.280839895).reshape(len(lats), len(lons)).tolist(), "phase_deg": (np.rad2deg(np.arctan2(b, a)) % 360).reshape(len(lats), len(lons)).tolist()}
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--cycle", default="00")
    ap.add_argument("--hours", type=int, default=126)
    ap.add_argument("--output", required=True, type=Path)
    args = ap.parse_args()
    key = find_htp(args.date, args.cycle)
    remote = RemoteClassicNetCDF(f"{S3}/{key}")
    try:
        m = mesh(remote)
        hours = np.arange(min(args.hours, len(remote.ds.dimensions["time"])))
        values = read_zeta(remote, m["node_ids"], hours)
        fields = fit_and_rasterize(values, m["x"], m["y"], hours)
    finally:
        remote.close()
    result = {"source": "NOAA STOFS-2D Global HTP", "source_object": key, "constituents": fields, "bbox": BBOX, "grid_step_deg": STEP, "wet_mask": np.isfinite(fields["M2"]["amplitude_ft"]).tolist()}
    args.output.write_text(json.dumps(result, allow_nan=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
