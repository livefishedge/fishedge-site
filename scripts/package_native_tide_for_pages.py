#!/usr/bin/env python3
"""Package complete-native contours into a Pages-sized viewer artifact.

The contour paths are generated from the complete native mesh offline. Raw
ADCIRC nodes/faces are retained in the archival build process, but are not
sent as a 100-MiB JSON document to every browser; Pages has a 25-MiB file cap.
"""
import argparse, json
from pathlib import Path

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--forecast', type=Path, required=True)
    args = ap.parse_args(); p = json.loads(args.forecast.read_text()); m = p.get('native_mesh') or {}
    contours = m.get('native_contours')
    if not contours: raise SystemExit('native contours are missing; refuse to package')
    required = ('node_count', 'triangle_count', 'contour_triangle_count', 'source')
    missing = [k for k in required if k not in m and k not in (m.get('source') or {})]
    if missing: raise SystemExit('native provenance missing: ' + ','.join(missing))
    packaged = {k: m[k] for k in ('node_count','triangle_count','contour_triangle_count','contour_step_ft','native_contours','source') if k in m}
    packaged['representation'] = 'precomputed native-mesh contours; raw nodes/faces kept out of Pages payload due 25 MiB file limit'
    packaged['complete_native_mesh_processed'] = True
    p['native_mesh'] = packaged
    p.setdefault('quality', {}).setdefault('native_mesh', {})['pages_representation'] = packaged['representation']
    args.forecast.write_text(json.dumps(p, allow_nan=False, separators=(',', ':')))
    print({'bytes': args.forecast.stat().st_size, 'contours': len(contours), 'representation': packaged['representation']})
if __name__ == '__main__': main()
