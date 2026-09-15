#!/usr/bin/env python3
"""Resumable parallel byte-range downloader for immutable NOAA objects."""
import argparse, hashlib, os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import requests

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('url'); ap.add_argument('output', type=Path)
    ap.add_argument('--workers', type=int, default=16)
    ap.add_argument('--chunk-mib', type=int, default=64)
    args = ap.parse_args()
    head = requests.head(args.url, timeout=60); head.raise_for_status()
    size = int(head.headers['Content-Length'])
    parts_dir = args.output.with_name(args.output.name + '.parts')
    parts_dir.mkdir(parents=True, exist_ok=True)
    chunk = args.chunk_mib * 1024 * 1024
    ranges = [(i, min(size, i + chunk) - 1) for i in range(0, size, chunk)]
    def fetch(item):
        idx, (lo, hi) = item; part = parts_dir / f'{idx:06d}.part'
        if part.exists() and part.stat().st_size == hi - lo + 1: return
        for attempt in range(6):
            try:
                r = requests.get(args.url, headers={'Range': f'bytes={lo}-{hi}'}, timeout=180)
                r.raise_for_status()
                if len(r.content) != hi - lo + 1: raise RuntimeError('short range')
                part.write_bytes(r.content); return
            except Exception:
                if attempt == 5: raise
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(fetch, enumerate(ranges)))
    tmp = args.output.with_suffix(args.output.suffix + '.assembling')
    with tmp.open('wb') as out:
        for i in range(len(ranges)):
            part = parts_dir / f'{i:06d}.part'
            if part.stat().st_size != ranges[i][1] - ranges[i][0] + 1: raise RuntimeError('incomplete part')
            with part.open('rb') as src:
                while True:
                    b = src.read(8 * 1024 * 1024)
                    if not b: break
                    out.write(b)
    os.replace(tmp, args.output)
    digest = hashlib.sha256()
    with args.output.open('rb') as f:
        for b in iter(lambda: f.read(16 * 1024 * 1024), b''): digest.update(b)
    print({'bytes': size, 'sha256': digest.hexdigest(), 'output': str(args.output)})
if __name__ == '__main__': main()
