#!/usr/bin/env python3
"""Acquire the real USEC-MD NASA GOT and NOAA VDatum source packages.

The files are deliberately kept outside the web tree.  The manifest records
the exact URL, byte hash, archive members, and extraction location.  VDatum
is a vertical transformation source; it is not treated as a tidal harmonic
atlas.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import tarfile
import urllib.request
import zipfile
from pathlib import Path

GOT_URL = "https://earth.gsfc.nasa.gov/sites/default/files/2023-12/got4.10c.tar.gz"
VDATUM_BASE = "https://vdatum.noaa.gov/download/data/"
VDATUM_PACKAGES = (
    "DEdelbay21_8301.zip",
    "MDVA_chb11_8301.zip",
    "NJVA_mab11_8301.zip",
    "NJcstemb11_8301.zip",
    "VAswchb11_8301.zip",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, destination: Path, force: bool = False) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists() and destination.stat().st_size and not force:
        return sha256(destination)
    partial = destination.with_suffix(destination.suffix + ".part")
    with urllib.request.urlopen(url, timeout=180) as response, partial.open("wb") as output:
        shutil.copyfileobj(response, output)
    partial.replace(destination)
    if destination.stat().st_size == 0:
        raise SystemExit(f"empty download: {url}")
    return sha256(destination)


def members(path: Path) -> list[str]:
    if tarfile.is_tarfile(path):
        with tarfile.open(path, "r:*") as archive:
            return sorted(member.name for member in archive.getmembers() if member.isfile())
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            return sorted(info.filename for info in archive.infolist() if not info.is_dir())
    raise SystemExit(f"unsupported archive: {path}")


def safe_extract(path: Path, destination: Path) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    root = destination.resolve()
    if tarfile.is_tarfile(path):
        with tarfile.open(path, "r:*") as archive:
            for member in archive.getmembers():
                target = (destination / member.name).resolve()
                if root != target and root not in target.parents:
                    raise SystemExit(f"unsafe archive member: {member.name}")
            archive.extractall(destination)
    else:
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                target = (destination / info.filename).resolve()
                if root != target and root not in target.parents:
                    raise SystemExit(f"unsafe archive member: {info.filename}")
            archive.extractall(destination)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/tmp/fishedge-tide-assets/usec-md"))
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--force", action="store_true", help="redownload existing archives")
    parser.add_argument("--vdatum-package", dest="vdatum_packages", action="append",
                        choices=VDATUM_PACKAGES,
                        help="regional package to acquire; repeat for multiple packages (default: all)")
    args = parser.parse_args()
    root = args.root.resolve()
    manifest_path = (args.manifest or root / "manifest.json").resolve()
    got_archive = root / "got" / "got4.10c.tar.gz"
    got_extract = root / "got" / "extracted"
    got_hash = download(GOT_URL, got_archive, args.force)
    safe_extract(got_archive, got_extract)
    records = [{
        "provider": "NASA GSFC",
        "model": "GOT4.10c",
        "url": GOT_URL,
        "archive": str(got_archive),
        "archive_sha256": got_hash,
        "extract_dir": str(got_extract),
        "members": members(got_archive),
    }]
    packages = tuple(args.vdatum_packages or VDATUM_PACKAGES)
    for package in packages:
        archive = root / "vdatum" / package
        url = VDATUM_BASE + package
        package_hash = download(url, archive, args.force)
        extract = root / "vdatum" / "extracted" / package.removesuffix(".zip")
        safe_extract(archive, extract)
        records.append({
            "provider": "NOAA",
            "dataset": "VDatum regional transformation grids",
            "region_package": package,
            "url": url,
            "archive": str(archive),
            "archive_sha256": package_hash,
            "extract_dir": str(extract),
            "members": members(archive),
            "role": "vertical datum transformation only; no tidal constituents",
        })
    payload = {
        "region": "USEC-MD",
        "acquired_utc": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "web_tree_policy": "source archives and extracted grids remain outside the web tree",
        "sources": records,
        "next_gate": "Use GOT harmonic coefficients plus VDatum offsets; do not infer a coastal harmonic atlas from VDatum.",
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(payload, indent=2) + "\n")
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    main()
