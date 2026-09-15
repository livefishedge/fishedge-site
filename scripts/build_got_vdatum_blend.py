#!/usr/bin/env python3
"""Build a USEC-MD GOT/coastal harmonic blend in complex space.

NASA GOT supplies the offshore harmonic atlas.  The coastal input must be an
independent, normalized harmonic source (for example an explicitly exported
ADCIRC/STOFS constituent atlas); NOAA VDatum is accepted only as a vertical
datum-offset grid.  VDatum does *not* supply tidal constituents.

The script deliberately refuses to manufacture coastal constituents from
station data or from a VDatum grid.  It writes a normalized candidate and a
provenance manifest, but promotion remains the responsibility of the real-data
benchmark/held-out validation gate.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

CONSTITUENTS = ("M2", "S2", "N2", "K2", "K1", "O1", "P1", "Q1")
FT_TO_M = 0.3048


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text())


def grid(source, name):
    values = source.get(name)
    if values is None:
        raise SystemExit(f"source lacks {name}")
    return np.asarray(values, dtype=float)


def complex_fields(source, names):
    result = {}
    for name in names:
        item = source.get("constituents", {}).get(name)
        if not item:
            raise SystemExit(f"source lacks constituent {name}")
        amp = grid(item, "amplitude_ft")
        phase = np.deg2rad(grid(item, "phase_deg"))
        if amp.shape != phase.shape:
            raise SystemExit(f"{name}: amplitude/phase shapes differ")
        result[name] = (amp * np.cos(phase), amp * np.sin(phase))
    return result


def offset_grid(vdatum, shape):
    if vdatum is None:
        return np.zeros(shape, dtype=float)
    field = vdatum.get("msl_to_mllw_ft") or vdatum.get("offset_ft")
    if field is None:
        raise SystemExit("VDatum input must contain msl_to_mllw_ft or offset_ft")
    out = np.asarray(field, dtype=float)
    if out.shape != shape:
        raise SystemExit(f"VDatum offset shape {out.shape} != source shape {shape}")
    return out


def weight_grid(vdatum, shape, default=1.0):
    if vdatum is None:
        return np.full(shape, default, dtype=float)
    field = vdatum.get("coastal_weight")
    if field is None:
        return np.full(shape, default, dtype=float)
    out = np.clip(np.asarray(field, dtype=float), 0.0, 1.0)
    if out.shape != shape:
        raise SystemExit(f"coastal weight shape {out.shape} != source shape {shape}")
    return out


def serialize_complex(coeff, names, shape, datum_offset):
    out = {}
    for name in names:
        re, im = coeff[name]
        amp = np.hypot(re, im)
        phase = (np.rad2deg(np.arctan2(im, re)) % 360.0)
        valid = np.isfinite(amp) & np.isfinite(phase)
        out[name] = {
            "amplitude_ft": np.where(valid, amp, None).tolist(),
            "phase_deg": np.where(valid, phase, None).tolist(),
        }
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--got", required=True, type=Path, help="normalized NASA GOT artifact")
    ap.add_argument("--coastal", required=True, type=Path, help="normalized independent coastal harmonic artifact")
    ap.add_argument("--vdatum", type=Path, help="normalized NOAA VDatum offset/weight grid")
    ap.add_argument("--output", required=True, type=Path)
    args = ap.parse_args()
    got = read_json(args.got)
    coastal = read_json(args.coastal)
    vdatum = read_json(args.vdatum) if args.vdatum else None
    names = [name for name in CONSTITUENTS if name in got.get("constituents", {}) and name in coastal.get("constituents", {})]
    if len(names) < 4:
        raise SystemExit("need at least four shared constituents; refusing partial blend")
    if got.get("lats") != coastal.get("lats") or got.get("lons") != coastal.get("lons"):
        raise SystemExit("GOT and coastal grids differ; remap each source explicitly before blending")
    lats, lons = got["lats"], got["lons"]
    shape = (len(lats), len(lons))
    got_c = complex_fields(got, names)
    coastal_c = complex_fields(coastal, names)
    w = weight_grid(vdatum, shape)
    # Coastal datum correction is an elevation-reference operation.  It does
    # not alter harmonic phase/amplitude; it is recorded separately for the
    # downstream prediction engine and validation comparison.
    datum = offset_grid(vdatum, shape)
    blended = {}
    for name in names:
        gr, gi = got_c[name]
        cr, ci = coastal_c[name]
        blended[name] = (w * cr + (1.0 - w) * gr, w * ci + (1.0 - w) * gi)
    payload = {
        "source": "NASA GOT + independent coastal harmonic source + NOAA VDatum",
        "provider": "NASA GSFC / NOAA",
        "model": "USEC-MD GOT-coastal complex harmonic blend",
        "datum": "MSL-like harmonic elevations; VDatum MSL-to-MLLW offset supplied separately",
        "lats": lats, "lons": lons, "bbox": got.get("bbox"),
        "constituents": serialize_complex(blended, names, shape, datum),
        "vdatum_msl_to_mllw_ft": np.where(np.isfinite(datum), datum, None).tolist(),
        "coastal_weight": np.where(np.isfinite(w), w, None).tolist(),
        "wet_mask": got.get("wet_mask") or coastal.get("wet_mask"),
        "provenance": {
            "got_source_sha256": got.get("source_sha256"),
            "coastal_source_sha256": coastal.get("source_sha256"),
            "vdatum_source_sha256": vdatum.get("source_sha256") if vdatum else None,
            "got_artifact_sha256": sha256(args.got),
            "coastal_artifact_sha256": sha256(args.coastal),
            "vdatum_artifact_sha256": sha256(args.vdatum) if args.vdatum else None,
            "phase_blend": "complex Re/Im; no degree interpolation",
            "vdatum_role": "vertical offset only; no tidal constituents inferred",
            "independent_offshore_field": True,
            "promotion": "shadow-only until baseline, LOO, separate-period, offshore, and estuary gates pass",
        },
    }
    # JSON cannot represent NaN under the artifact contract.
    text = json.dumps(payload, allow_nan=False, separators=(",", ":"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(text + "\n")
    print(json.dumps({"output": str(args.output), "constituents": names,
                      "got_artifact_sha256": payload["provenance"]["got_artifact_sha256"],
                      "coastal_artifact_sha256": payload["provenance"]["coastal_artifact_sha256"]}, indent=2))


if __name__ == "__main__":
    main()
