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
from concurrent.futures import ThreadPoolExecutor
import datetime as dt
import json
import os
import tempfile
import time
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
M2_HOURS = CONSTITUENTS["M2"]
# Below this amplitude the phase of a fitted constituent is effectively
# undefined.  Keep those cells out of the co-tidal field rather than allowing
# tiny coastal/noise fits to create false phase contours.
MIN_M2_AMPLITUDE_M = 0.03


class RemoteClassicNetCDF:
    """Small classic-NetCDF reader backed by byte-range HTTP requests."""

    def __init__(self, url):
        self.url = url
        head = None
        for attempt in range(6):
            try:
                head = requests.head(url, timeout=180)
                head.raise_for_status()
                break
            except requests.RequestException:
                if attempt == 5:
                    raise
                time.sleep(2.0 * (attempt + 1))
        self.size = int(head.headers["Content-Length"])
        self.tmp = tempfile.NamedTemporaryFile(prefix="stofs-header-", suffix=".nc", delete=False)
        self.path = self.tmp.name
        self.tmp.close()
        os.truncate(self.path, self.size)
        with open(self.path, "r+b") as f:
            f.write(self.range(0, min(self.size, 4 * 1024 * 1024)))
        # mmap maps the sparse file without reading record payloads.  The
        # arrays are only used to discover byte offsets; payload reads below
        # still go through HTTP Range requests.
        self.ds = netcdf_file(self.path, mmap=True)
        self._base_ptr = np.frombuffer(self.ds._mm_buf, dtype=np.uint8).__array_interface__["data"][0]

    def range(self, start, length):
        end = start + length - 1
        last_error = None
        for attempt in range(6):
            try:
                r = requests.get(self.url, headers={"Range": f"bytes={start}-{end}"}, timeout=180)
                r.raise_for_status()
                if len(r.content) != length:
                    raise RuntimeError(f"short range read {len(r.content)} != {length}")
                return r.content
            except (requests.RequestException, RuntimeError) as exc:
                last_error = exc
                if attempt == 5:
                    raise
                time.sleep(1.5 * (attempt + 1))
        raise last_error

    def variable_bytes(self, name):
        var = self.ds.variables[name]
        count = int(np.prod(var.data.shape))
        if var.data.shape and var.data.shape[0] is None:
            raise RuntimeError(f"record variable {name} cannot be read as one contiguous array")
        begin = self.offset(name)
        return self.range(begin, count * var.data.dtype.itemsize)

    def offset(self, name):
        """Return the NetCDF byte offset from the mmap-backed array view."""
        array = self.ds.variables[name].data
        return int(array.__array_interface__["data"][0] - self._base_ptr)

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


def find_mesh_file(date, cycle):
    """Find the one-time STOFS mesh companion (same node numbering)."""
    prefix = f"stofs_2d_glo.{date}/{cycle}/rerun/"
    r = requests.get(f"{S3}/", params={"list-type": "2", "prefix": prefix, "max-keys": 1000}, timeout=30)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    keys = [e.text for e in root.findall("{*}Contents/{*}Key") if e.text]
    keys = [k for k in keys if k.endswith("stofs_2d_glo_tide.68.nc")]
    if not keys:
        raise RuntimeError(f"no one-timestep STOFS mesh file at {prefix}")
    return keys[0]


def mesh(remote):
    """Read/cache coordinates and triangle connectivity for USEC-MD."""
    if MESH_CACHE.exists():
        return dict(np.load(MESH_CACHE, allow_pickle=False))
    x = np.frombuffer(remote.variable_bytes("x"), dtype=remote.ds.variables["x"].data.dtype).copy()
    y = np.frombuffer(remote.variable_bytes("y"), dtype=remote.ds.variables["y"].data.dtype).copy()
    elements = np.frombuffer(remote.variable_bytes("element"), dtype=remote.ds.variables["element"].data.dtype).copy().reshape((-1, 3)) - 1
    # Select only the mesh neighborhood needed by the 17x21 output grid.
    # The global mesh is highly refined near shore; indexing every node in a
    # half-degree collar would defeat lazy zeta reads without improving the
    # published raster.
    target = np.array([(lon, lat) for lat in np.arange(BBOX[1], BBOX[3] + STEP / 2, STEP) for lon in np.arange(BBOX[0], BBOX[2] + STEP / 2, STEP)])
    tree = cKDTree(np.column_stack((x, y)))
    _, nearest = tree.query(target, k=min(32, len(x)))
    selected_nodes = np.unique(np.asarray(nearest).ravel())
    selected_set = np.zeros(len(x), dtype=bool); selected_set[selected_nodes] = True
    selected_elements = elements[np.all(selected_set[elements], axis=1)]
    MESH_CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(MESH_CACHE, x=x[selected_nodes], y=y[selected_nodes], node_ids=selected_nodes, elements=selected_elements)
    return dict(np.load(MESH_CACHE, allow_pickle=False))


def read_zeta(remote, node_ids, hours):
    var = remote.ds.variables["zeta"]
    itemsize = var.data.dtype.itemsize
    recsize = int(remote.ds._recsize)
    begin = remote.offset("zeta")
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
    # NetCDF-3 records are node-contiguous. Coalesce nearby sparse runs into
    # bounded byte windows to keep HTTP request count low while still avoiding
    # a full 100-MB-per-hour global record read.
    joined = []
    for lo, hi in spans:
        if joined and lo - joined[-1][1] <= 10_000 and hi - joined[-1][0] <= 2_000_000:
            joined[-1] = (joined[-1][0], hi)
        else:
            joined.append((lo, hi))
    coalesced = []
    for lo, hi in joined:
        while hi - lo > 2_000_000:
            coalesced.append((lo, lo + 2_000_000)); lo += 2_000_000
        coalesced.append((lo, hi))
    spans = coalesced
    out = np.full((len(hours), len(node_ids)), np.nan)
    def fetch_span(hour, lo, hi):
        raw = remote.range(begin + hour * recsize + lo * itemsize, (hi - lo) * itemsize)
        values = np.frombuffer(raw, dtype=var.data.dtype).astype(float)
        values[values < -9000] = np.nan
        return lo, hi, values
    for ti, hour in enumerate(hours):
        with ThreadPoolExecutor(max_workers=8) as pool:
            reads = list(pool.map(lambda span: fetch_span(int(hour), *span), spans))
        for lo, hi, values in reads:
            left = int(np.searchsorted(node_ids, lo, side="left"))
            right = int(np.searchsorted(node_ids, hi, side="left"))
            selected = values[node_ids[left:right] - lo]
            out[ti, left:right] = selected
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
    quality = np.zeros(values.shape[1], dtype=bool)
    finite = np.isfinite(values)
    complete = finite.all(axis=0)
    if complete.any():
        # All complete nodes share the same design matrix; solve them in one
        # BLAS call instead of thousands of tiny lstsq invocations.
        coeff[:, complete] = np.linalg.pinv(design) @ values[:, complete]
    for i in np.flatnonzero(~complete):
        ok = finite[:, i]
        # The 126-hour source supports a well-conditioned fit with the
        # sampled records; require only an overdetermined set, not 3x the
        # coefficient count (which would reject a 24-sample/3-hour run).
        if ok.sum() >= design.shape[1] + 2:
            coeff[:, i] = np.linalg.lstsq(design[ok], values[ok, i], rcond=None)[0]
    for i in range(values.shape[1]):
        if not np.isfinite(coeff[:, i]).all():
            continue
        # A short operational forecast contains surge and other
        # non-astronomical energy. Reject fits whose M2 signal is weak or
        # whose unexplained residual is comparable to that signal.
        m2_amp = float(np.hypot(coeff[1, i], coeff[2, i]))
        ok = finite[:, i]
        residual = values[ok, i] - design[ok] @ coeff[:, i]
        rms = float(np.sqrt(np.mean(residual * residual)))
        quality[i] = m2_amp >= MIN_M2_AMPLITUDE_M and rms <= max(0.04, 0.45 * m2_amp)
    coeff[:, ~quality] = np.nan
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
        amplitude = (np.hypot(a, b) * 3.280839895).reshape(len(lats), len(lons))
        phase = (np.rad2deg(np.arctan2(b, a)) % 360).reshape(len(lats), len(lons))
        result[name] = {
            "amplitude_ft": [[None if not np.isfinite(v) else float(v) for v in row] for row in amplitude],
            "phase_deg": [[None if not np.isfinite(v) else float(v) for v in row] for row in phase],
        }
    # A target is wet only when all four surrounding raster corners have a
    # valid source fit. This conservative mask prevents contour segments from
    # crossing dry/land cells at the coast.
    m2_amp = np.asarray(result["M2"]["amplitude_ft"], dtype=float)
    wet_points = np.isfinite(m2_amp)
    wet_cells = (wet_points[:-1, :-1] & wet_points[1:, :-1] &
                 wet_points[:-1, 1:] & wet_points[1:, 1:])
    result["wet_mask"] = wet_cells.tolist()
    return result


def merge_forecast(path, fields, source):
    """Attach the compact M2 phase/amplitude fields to viewer frames."""
    payload = json.loads(Path(path).read_text())
    amp = fields["M2"]["amplitude_ft"]
    high_phase = fields["M2"]["phase_deg"]
    wet_mask = fields.get("wet_mask")
    first = dt.datetime.strptime(payload["frames"][0]["time"].replace("Z", ""), "%Y-%m-%dT%H:%M")
    for frame in payload["frames"]:
        current = dt.datetime.strptime(frame["time"].replace("Z", ""), "%Y-%m-%dT%H:%M")
        hours = (current - first).total_seconds() / 3600.0
        frame["tide_amplitude_ft"] = amp
        frame["tide_phase_deg"] = [[None if value is None else float((360.0 * hours / M2_HOURS - value) % 360.0) for value in row] for row in high_phase]
    if wet_mask is not None:
        payload["tide_water_cells"] = wet_mask
    payload["tide_harmonic_source"] = {"provider": "NOAA STOFS-2D Global HTP", "object": source, "constituents": list(CONSTITUENTS), "primary": "M2", "method": "lazy regional mesh extraction + QC harmonic fit", "min_m2_amplitude_m": MIN_M2_AMPLITUDE_M}
    Path(path).write_text(json.dumps(payload, allow_nan=False, separators=(",", ":")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True)
    ap.add_argument("--cycle", default="00")
    ap.add_argument("--hours", type=int, default=126)
    ap.add_argument("--stride", type=int, default=3, help="sample every N source hours for the harmonic fit")
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--merge-forecast", nargs="*", default=[])
    args = ap.parse_args()
    key = find_htp(args.date, args.cycle)
    if MESH_CACHE.exists():
        m = dict(np.load(MESH_CACHE, allow_pickle=False))
    else:
        mesh_key = find_mesh_file(args.date, args.cycle)
        mesh_remote = RemoteClassicNetCDF(f"{S3}/{mesh_key}")
        try:
            m = mesh(mesh_remote)
        finally:
            mesh_remote.close()
    remote = RemoteClassicNetCDF(f"{S3}/{key}")
    try:
        time_count = int(remote.ds.variables["zeta"].data.shape[0])
        hours = np.arange(0, min(args.hours, time_count), max(1, args.stride))
        values = read_zeta(remote, m["node_ids"], hours)
        fields = fit_and_rasterize(values, m["x"], m["y"], hours)
    finally:
        remote.close()
    result = {"source": "NOAA STOFS-2D Global HTP", "source_object": key, "constituents": fields, "bbox": BBOX, "grid_step_deg": STEP, "wet_mask": fields["wet_mask"]}
    args.output.write_text(json.dumps(result, allow_nan=False, separators=(",", ":")))
    for path in args.merge_forecast:
        merge_forecast(path, fields, key)
        print(f"merged STOFS harmonic fields: {path}")


if __name__ == "__main__":
    main()
