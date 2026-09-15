#!/usr/bin/env python3
"""Acquire and verify a licensed/public harmonic atlas without guessing inputs.

The pipeline accepts a local atlas directory (GOT-style NetCDF files) or an
explicit URL plus SHA-256.  It never invents FES/TPXO data and refuses an
unhashed remote asset.  Downloaded archives are kept outside the web tree.
"""
import argparse
import hashlib
import json
import shutil
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

SUPPORTED = {"GOT4.10c", "FES2022", "TPXO10", "TPXO9"}

def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, choices=sorted(SUPPORTED))
    ap.add_argument("--output", required=True, type=Path)
    ap.add_argument("--source-dir", type=Path)
    ap.add_argument("--url")
    ap.add_argument("--sha256", required=True, help="expected SHA-256 of --url archive")
    args = ap.parse_args()
    if bool(args.source_dir) == bool(args.url):
        raise SystemExit("provide exactly one of --source-dir or --url")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    source = args.source_dir
    archive = None
    if args.url:
        archive = args.output.parent / (args.model.lower() + ".download")
        with urllib.request.urlopen(args.url, timeout=120) as response, archive.open("wb") as out:
            shutil.copyfileobj(response, out)
        actual = sha256(archive)
        if actual.lower() != args.sha256.lower():
            archive.unlink(missing_ok=True)
            raise SystemExit(f"sha256 mismatch: expected {args.sha256}, got {actual}")
        extract = Path(tempfile.mkdtemp(prefix=args.model.lower() + "-", dir=args.output.parent))
        if zipfile.is_zipfile(archive):
            with zipfile.ZipFile(archive) as zf: zf.extractall(extract)
        elif tarfile.is_tarfile(archive):
            with tarfile.open(archive) as tf: tf.extractall(extract, filter="data")
        else:
            raise SystemExit("download is not a supported zip/tar archive")
        source = extract
    if not source.exists():
        raise SystemExit(f"source directory does not exist: {source}")
    files = sorted(str(p.relative_to(source)) for p in source.rglob("*") if p.is_file())
    if not files:
        raise SystemExit("source directory contains no files")
    manifest = {"provider_model": args.model, "source_dir": str(source), "archive_sha256": args.sha256,
                "files": files, "contract": "normalized harmonic atlas; source remains outside web artifact"}
    args.output.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest, indent=2))

if __name__ == "__main__": main()
