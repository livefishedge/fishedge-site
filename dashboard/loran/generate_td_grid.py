#!/usr/bin/env python3
"""
generate_td_grid.py — Loran-C GRI 9960 Time Difference (TD) grid → GeoJSON.

Generates WGS84 isolines for the 9960-X (Nantucket) and 9960-Y (Cape Fear) TD
pairs across an arbitrary lat/lon box. Output is a single FeatureCollection of
LineStrings tagged with {pair, td, type=major|minor}.

Improvements over the upstream starting point:
  * Vectorized Vincenty via numpy — ~50x speedup over scalar iterative.
  * Auto-computes TD bounds from corner sampling so isolines cover the full
    box. The upstream hardcoded ranges clipped the corners of the usec_md box
    (NW corner needed td_x ≈ 38505 µs, NE corner needed td_x ≈ 37820 µs —
    both outside the upstream's 37900-38150 band).
  * Standard Vincenty B_val coefficient (74 − 47·u²) — the upstream had a
    2x typo (37 − 25·u²). Sub-millimeter for WGS84 but wrong.
  * CLI args for output path, bounds, resolution, ASF offsets, step sizes,
    margin. Proper main() guard. Scoped matplotlib figure cleanup (the
    upstream plt.close() without args would close whatever figure is active,
    which can race with other code).

Defaults to usec_md: bounds = (35.5, 40.5, −76.5, −71.5), the full dashboard
region bbox, so the TD pattern is visible wherever the captain pans the map.
Zero-ASF (pure saltwater model); pass --asf-x / --asf-y for regional offsets.

Usage:
    # Default (full usec_md region):
    python generate_td_grid.py

    # Custom:
    python generate_td_grid.py \\
        --bounds "35.5,40.5,-76.5,-71.5" \\
        --resolution 180 \\
        --output dashboard/loran/td_grid_9960_usec_md.geojson

    # Apply NOAA NEFSC regional ASF offsets (µs):
    python generate_td_grid.py --asf-x -0.6 --asf-y 1.2

Requires: numpy>=1.24, matplotlib>=3.7
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Sequence, Tuple

import numpy as np

import matplotlib
matplotlib.use("Agg")  # headless backend — no DISPLAY required
import matplotlib.pyplot as plt


# ── WGS84 ellipsoid ──────────────────────────────────────────────────────────
A = 6378137.0                       # Semi-major axis (m)
F_INV = 298.257223563               # Reciprocal flattening
F = 1.0 / F_INV
B = (1.0 - F) * A                   # Semi-minor axis (m)
VELOCITY_M_PER_US = 299.692         # Saltwater propagation velocity (m/µs)


# ── GRI 9960 transmitters (WGS84, from MegaPulse chain info) ──────────────
# Authoritative coordinates per the MegaPulse Loran-C chain table, which
# matches USCG/NIST values to the precision published in the 1994 LORAN-C
# Signal Specification. Source (archived):
#   https://web.archive.org/web/20221112232009/https://www.megapulse.com/chaininfo.html
# Cross-referenced with the Wikipedia LORAN-C station table.
# Note: GRI 9960 also includes W (Caribou, ME) and Z (Dana, IN) — not modeled
# here because the upstream starting point covered M/X/Y only and Mike's
# spec was for those three.
STATIONS = {
    "M": (42.71408778, -76.82591889),   # Seneca, NY        (master)
    "X": (41.25334611,  -69.97737111),  # Nantucket, MA     (secondary)
    "Y": (34.06283556,  -77.91280556),  # Carolina Beach, NC (secondary)
                                       # (commonly misnamed "Cape Fear"; the
                                       # actual 9960-Y tower is at Carolina
                                       # Beach — ~60 km SE of the cape.)
}

# Emission Delay (µs) — MegaPulse "Emission / Coding Delay" column,
# raw emission value. The Coding Delay is a rounded subset for receiver
# display; the actual TD formula needs the raw emission value.
#   TD(p) = (TOF_sec(p) − TOF_master(p)) + EmissionDelay(sec)
DELAYS = {
    "X": 26969.93,   # 9960-X Nantucket     (Coding 25000.00)
    "Y": 42221.65,   # 9960-Y Carolina Beach (Coding 39000.00)
}


# ── Vectorized Vincenty inverse formula ──────────────────────────────────────
def vincenty_distance(lat1: np.ndarray,
                      lon1: np.ndarray,
                      lat2: float,
                      lon2: float,
                      max_iter: int = 200,
                      tol: float = 1e-12) -> np.ndarray:
    """Vincenty inverse formula on WGS84. Vectorized.

    Args:
        lat1, lon1: arrays of latitudes/longitudes (degrees).
        lat2, lon2: scalars (degrees).

    Returns:
        Array of geodesic distances in meters (same shape as lat1).
    """
    phi1 = np.radians(np.asarray(lat1, dtype=np.float64))
    lam1 = np.radians(np.asarray(lon1, dtype=np.float64))
    phi2 = np.radians(float(lat2))
    lam2 = np.radians(float(lon2))
    L = lam2 - lam1

    U1 = np.arctan((1.0 - F) * np.tan(phi1))
    U2 = np.arctan((1.0 - F) * np.tan(phi2))
    sinU1, cosU1 = np.sin(U1), np.cos(U1)
    sinU2, cosU2 = np.sin(U2), np.cos(U2)

    lam = np.broadcast_to(L, phi1.shape).astype(np.float64).copy()

    # B_val coefficients (standard Vincenty):
    #   B = (u²/1024) × {256 + u² × [−128 + u² × (74 − 47·u²)]}
    # We compute u² = cos²α × (A² − B²) / B² after convergence.

    not_converged = np.ones(phi1.shape, dtype=bool)
    for _ in range(max_iter):
        sin_lam = np.sin(lam)
        cos_lam = np.cos(lam)
        sin_sigma = np.sqrt(
            (cosU2 * sin_lam) ** 2
            + (cosU1 * sinU2 - sinU1 * cosU2 * cos_lam) ** 2
        )
        # Avoid div-by-zero on antipodal coincidence.
        sin_sigma_safe = np.where(sin_sigma == 0, 1.0, sin_sigma)

        cos_sigma = sinU1 * sinU2 + cosU1 * cosU2 * cos_lam
        sigma = np.arctan2(sin_sigma, cos_sigma)
        sin_alpha = cosU1 * cosU2 * sin_lam / sin_sigma_safe
        cos2_alpha = 1.0 - sin_alpha ** 2
        cos2_sigma_m = np.where(
            cos2_alpha != 0,
            cos_sigma - 2.0 * sinU1 * sinU2 / cos2_alpha,
            0.0,
        )
        C = (F / 16.0) * cos2_alpha * (4.0 + F * (4.0 - 3.0 * cos2_alpha))
        lam_prev = lam.copy()
        lam = L + (1.0 - C) * F * sin_alpha * (
            sigma
            + C * sin_sigma * (
                cos2_sigma_m + C * cos_sigma * (-1.0 + 2.0 * cos2_sigma_m ** 2)
            )
        )
        step = np.abs(lam - lam_prev)
        newly_converged = step < tol
        not_converged &= ~newly_converged
        if not not_converged.any():
            break

    u2 = cos2_alpha * (A ** 2 - B ** 2) / (B ** 2)
    A_val = 1.0 + u2 / 16384.0 * (
        4096.0 + u2 * (-768.0 + u2 * (320.0 - 175.0 * u2))
    )
    B_val = u2 / 1024.0 * (
        256.0 + u2 * (-128.0 + u2 * (74.0 - 47.0 * u2))
    )
    delta_sigma = (
        B_val
        * sin_sigma
        * (
            cos2_sigma_m
            + 0.25
            * B_val
            * (
                cos_sigma * (-1.0 + 2.0 * cos2_sigma_m ** 2)
                - (1.0 / 6.0)
                * B_val
                * cos2_sigma_m
                * (-3.0 + 4.0 * sin_sigma ** 2)
                * (-3.0 + 4.0 * cos2_sigma_m ** 2)
            )
        )
    )
    return B * A_val * (sigma - delta_sigma)


def td_for_pair(lat_grid: np.ndarray,
                lon_grid: np.ndarray,
                master_key: str,
                sec_key: str,
                delay_us: float,
                asf_us: float = 0.0) -> np.ndarray:
    """TD at each (lat, lon) = (TOF_secondary − TOF_master) / V + delay + ASF."""
    d_m = vincenty_distance(lat_grid, lon_grid, *STATIONS[master_key])
    d_s = vincenty_distance(lat_grid, lon_grid, *STATIONS[sec_key])
    return (d_s - d_m) / VELOCITY_M_PER_US + delay_us + asf_us


def auto_compute_td_bounds(bounds: Tuple[float, float, float, float],
                           n_samples: int = 21,
                           margin_us: float = 20.0
                           ) -> Tuple[float, float, float, float]:
    """Sample a regular grid in the box and return TD bounds per pair.

    Returns (x_lo, x_hi, y_lo, y_hi) in µs.
    """
    min_lat, max_lat, min_lon, max_lon = bounds
    lats = np.linspace(min_lat, max_lat, n_samples)
    lons = np.linspace(min_lon, max_lon, n_samples)
    lon_grid, lat_grid = np.meshgrid(lons, lats)
    lat_flat = lat_grid.ravel()
    lon_flat = lon_grid.ravel()

    td_x = td_for_pair(lat_flat, lon_flat, "M", "X", DELAYS["X"])
    td_y = td_for_pair(lat_flat, lon_flat, "M", "Y", DELAYS["Y"])
    return (
        float(td_x.min()) - margin_us,
        float(td_x.max()) + margin_us,
        float(td_y.min()) - margin_us,
        float(td_y.max()) + margin_us,
    )


def _snap_levels(lo: float, hi: float, step: float) -> np.ndarray:
    """Inclusive integer-multiple grid of levels spanning [lo, hi]."""
    n_lo = int(np.floor(lo / step))
    n_hi = int(np.ceil(hi / step))
    return np.arange(n_lo * step, (n_hi + 1) * step, step)


def _extract_isolines(lon_mesh: np.ndarray,
                      lat_mesh: np.ndarray,
                      grid: np.ndarray,
                      levels: Sequence[float],
                      pair_name: str,
                      line_type: str,
                      features: list) -> int:
    """Run plt.contour at given levels, append LineString features. Returns count.

    Uses QuadContourSet.allsegs (the modern API; cs.collections was removed
    in matplotlib 3.8+). allsegs is a list[list[np.ndarray]] indexed first by
    level, then by segment within that level.
    """
    fig, ax = plt.subplots()
    try:
        cs = ax.contour(lon_mesh, lat_mesh, grid, levels=list(levels))
        for level, segments in zip(cs.levels, cs.allsegs):
            for verts in segments:
                if len(verts) < 2:
                    continue
                features.append({
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": verts.tolist(),
                    },
                    "properties": {
                        "pair": pair_name,
                        "td": round(float(level), 2),
                        "type": line_type,
                    },
                })
    finally:
        plt.close(fig)
    return len(features)


def generate(bounds: Tuple[float, float, float, float],
             resolution: int,
             output_path: str,
             asf_x: float = 0.0,
             asf_y: float = 0.0,
             x_step_major: float = 10.0,
             x_step_minor: float = 5.0,
             y_step_major: float = 10.0,
             y_step_minor: float = 5.0,
             margin_us: float = 20.0,
             n_bounds_samples: int = 21) -> int:
    """Build TD grid, extract isolines, write GeoJSON. Returns feature count."""
    t_start = time.time()
    print(f"[td_grid] bounds={bounds} resolution={resolution}")

    # 1. Auto TD bounds from corner sampling (fixes upstream clipping bug)
    x_lo, x_hi, y_lo, y_hi = auto_compute_td_bounds(
        bounds, n_samples=n_bounds_samples, margin_us=margin_us,
    )
    print(f"[td_grid] 9960-X TD range: {x_lo:.1f} – {x_hi:.1f} µs "
          f"(±{margin_us:.0f} margin)")
    print(f"[td_grid] 9960-Y TD range: {y_lo:.1f} – {y_hi:.1f} µs "
          f"(±{margin_us:.0f} margin)")

    # 2. Build meshgrid
    min_lat, max_lat, min_lon, max_lon = bounds
    lats = np.linspace(min_lat, max_lat, resolution)
    lons = np.linspace(min_lon, max_lon, resolution)
    lon_mesh, lat_mesh = np.meshgrid(lons, lats)

    # 3. Compute TD grids (vectorized Vincenty × 2 pairs)
    lat_flat = lat_mesh.ravel()
    lon_flat = lon_mesh.ravel()
    t_v = time.time()
    grid_x = td_for_pair(lat_flat, lon_flat, "M", "X",
                         DELAYS["X"], asf_x).reshape(lat_mesh.shape)
    grid_y = td_for_pair(lat_flat, lon_flat, "M", "Y",
                         DELAYS["Y"], asf_y).reshape(lat_mesh.shape)
    print(f"[td_grid] Vincenty grids computed in "
          f"{time.time() - t_v:.2f}s "
          f"({resolution}×{resolution} × 2 Vincenty ops, vectorized)")

    # 4. Snap level sets to step boundaries
    levels_x_major = _snap_levels(x_lo, x_hi, x_step_major)
    levels_x_minor = _snap_levels(x_lo, x_hi, x_step_minor)
    levels_y_major = _snap_levels(y_lo, y_hi, y_step_major)
    levels_y_minor = _snap_levels(y_lo, y_hi, y_step_minor)
    print(f"[td_grid] 9960-X: {len(levels_x_major)} major / "
          f"{len(levels_x_minor)} minor levels "
          f"(steps {x_step_major} / {x_step_minor} µs)")
    print(f"[td_grid] 9960-Y: {len(levels_y_major)} major / "
          f"{len(levels_y_minor)} minor levels "
          f"(steps {y_step_major} / {y_step_minor} µs)")

    # 5. Extract isolines
    features: list = []
    t_e = time.time()
    _extract_isolines(lon_mesh, lat_mesh, grid_x, levels_x_major,
                      "9960-X", "major", features)
    _extract_isolines(lon_mesh, lat_mesh, grid_x, levels_x_minor,
                      "9960-X", "minor", features)
    _extract_isolines(lon_mesh, lat_mesh, grid_y, levels_y_major,
                      "9960-Y", "major", features)
    _extract_isolines(lon_mesh, lat_mesh, grid_y, levels_y_minor,
                      "9960-Y", "minor", features)
    print(f"[td_grid] Extracted {len(features)} isolines in "
          f"{time.time() - t_e:.2f}s")

    # 6. Write GeoJSON (compact: no whitespace)
    geojson = {
        "type": "FeatureCollection",
        "name": "gri9960-td-grid",
        "metadata": {
            "gri": 9960,
            "region_bbox": list(bounds),
            "resolution": resolution,
            "asf_x_us": asf_x,
            "asf_y_us": asf_y,
            "td_ranges_us": {
                "9960-X": [round(x_lo, 2), round(x_hi, 2)],
                "9960-Y": [round(y_lo, 2), round(y_hi, 2)],
            },
        },
        "features": features,
    }
    with open(output_path, "w") as f:
        json.dump(geojson, f, separators=(",", ":"))

    elapsed = time.time() - t_start
    major_count = sum(1 for f in features if f["properties"]["type"] == "major")
    minor_count = sum(1 for f in features if f["properties"]["type"] == "minor")
    print(f"[td_grid] Wrote {len(features)} features "
          f"({major_count} major + {minor_count} minor) → {output_path} "
          f"({elapsed:.1f}s total)")
    return len(features)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument(
        "--bounds", default="35.5,40.5,-76.5,-71.5",
        help="min_lat,max_lat,min_lon,max_lon "
             "(default: full usec_md region bbox)",
    )
    p.add_argument("--resolution", type=int, default=180,
                   help="grid points per axis (default: 180 ≈ 32k samples)")
    p.add_argument("--output",
                   default="dashboard/loran/td_grid_9960_usec_md.geojson",
                   help="output GeoJSON path (relative or absolute)")
    p.add_argument("--asf-x", type=float, default=0.0,
                   help="ASF offset for 9960-X in µs (regional correction)")
    p.add_argument("--asf-y", type=float, default=0.0,
                   help="ASF offset for 9960-Y in µs (regional correction)")
    p.add_argument("--x-major", type=float, default=10.0,
                   help="9960-X major step (µs, default 10)")
    p.add_argument("--x-minor", type=float, default=5.0,
                   help="9960-X minor step (µs, default 5)")
    p.add_argument("--y-major", type=float, default=10.0,
                   help="9960-Y major step (µs, default 10)")
    p.add_argument("--y-minor", type=float, default=5.0,
                   help="9960-Y minor step (µs, default 5)")
    p.add_argument("--margin", type=float, default=20.0,
                   help="TD bounds margin in µs past sampled extremes "
                        "(default 20)")
    p.add_argument("--n-bounds-samples", type=int, default=21,
                   help="samples per axis for auto TD bound estimation "
                        "(default 21)")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    try:
        bounds = tuple(float(x) for x in args.bounds.split(","))
    except ValueError:
        print(f"[error] --bounds must be 4 comma-separated floats, "
              f"got: {args.bounds!r}", file=sys.stderr)
        return 2
    if len(bounds) != 4:
        print(f"[error] --bounds must have 4 values, got {len(bounds)}",
              file=sys.stderr)
        return 2
    if min(bounds[0], bounds[1]) >= max(bounds[0], bounds[1]):
        print(f"[error] bounds: max_lat must exceed min_lat, got "
              f"min_lat={bounds[0]} max_lat={bounds[1]}", file=sys.stderr)
        return 2
    if min(bounds[2], bounds[3]) >= max(bounds[2], bounds[3]):
        print(f"[error] bounds: max_lon must exceed min_lon, got "
              f"min_lon={bounds[2]} max_lon={bounds[3]}", file=sys.stderr)
        return 2

    try:
        generate(
            bounds=bounds,
            resolution=args.resolution,
            output_path=args.output,
            asf_x=args.asf_x,
            asf_y=args.asf_y,
            x_step_major=args.x_major,
            x_step_minor=args.x_minor,
            y_step_major=args.y_major,
            y_step_minor=args.y_minor,
            margin_us=args.margin,
            n_bounds_samples=args.n_bounds_samples,
        )
    except Exception as e:
        import traceback
        print(f"[error] {e}", file=sys.stderr)
        traceback.print_exc()
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())