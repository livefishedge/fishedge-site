#!/usr/bin/env python3
"""Build a compact regional STOFS mesh cache from the current NOAA source.

Only coordinates, local triangle connectivity, and global node IDs are kept.
The cache is an intermediate build artifact; raw native arrays never enter
the browser payload.
"""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_stofs_native_mesh_artifact import build_complete_region_mesh
from fetch_stofs_global_harmonics import RemoteClassicNetCDF


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source-url', required=True)
    ap.add_argument('--cache', type=Path, required=True)
    ap.add_argument('--bbox', type=float, nargs=4, required=True,
                    metavar=('WEST', 'SOUTH', 'EAST', 'NORTH'))
    args = ap.parse_args()
    remote = RemoteClassicNetCDF(args.source_url)
    try:
        mesh = build_complete_region_mesh(remote, args.cache, tuple(args.bbox))
    finally:
        remote.close()
    print({'cache': str(args.cache), 'nodes': len(mesh['x']),
           'triangles': len(mesh['elements'])})


if __name__ == '__main__':
    main()
