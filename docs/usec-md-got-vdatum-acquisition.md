# USEC-MD GOT + NOAA VDatum acquisition record

Acquired 2026-09-01 from the authoritative NASA GSFC and NOAA VDatum
distribution endpoints. Archives and extracted files are kept outside the
web tree under `/tmp/fishedge-tide-assets/usec-md/`; the web deployment
contains only the reproducible acquisition/normalization code.

## NASA offshore harmonic atlas

- Provider/model: NASA GSFC GOT4.10c
- URL: `https://earth.gsfc.nasa.gov/sites/default/files/2023-12/got4.10c.tar.gz`
- Archive SHA-256:
  `2431decebe847414925289e4904bce09709bf668ce3c888700cc884a1236e038`
- Normalized USEC-MD artifact: `got/got4.10c-usec-md.json`
- Constituents extracted: M2, S2, N2, K2, K1, O1, P1, Q1
- Normalization bbox: 77–72°W, 36–40°N; 17×21 grid

## NOAA VDatum regional transformation grids

These are vertical transformation grids, not harmonic constituent fields.
They can supply MSL/MLLW output conversion after a harmonic field is built.

| Package | URL | Archive SHA-256 |
|---|---|---|
| DEdelbay21_8301.zip | `https://vdatum.noaa.gov/download/data/DEdelbay21_8301.zip` | `1d2f69cc6d06424a6d2b088b08ea0fa9f6757237f11c32020524bd9fd85b784e` |
| NJVA_mab11_8301.zip | `https://vdatum.noaa.gov/download/data/NJVA_mab11_8301.zip` | `4a19e6f89bcee541208defe2b93d34db4799ca898f5e8ca5df695ccb91dc5468` |
| NJcstemb11_8301.zip | `https://vdatum.noaa.gov/download/data/NJcstemb11_8301.zip` | `860cdab22ea042a20a4c5c1b2fac2dfe079296b510063e3e52e520c083c5441c` |
| VAswchb11_8301.zip | `https://vdatum.noaa.gov/download/data/VAswchb11_8301.zip` | `2b2bb751641b09c5031fd16e8e7288ab28c4b269727e30207ed732ce307bb306` |

Each package contains `.gtx` transformation grids and metadata/boundary
files. `scripts/acquire_got_vdatum_usecmd.py` re-downloads, hashes, safely
extracts, and writes a machine-readable manifest. Existing archives are
reused and rehashed unless `--force` is supplied.

## Scope boundary

This acquisition intentionally contains no STOFS input. VDatum alone cannot
provide the coastal M2/S2/K1/O1 harmonic amplitudes and phases described in
the original proposal. A GOT-only prediction with a VDatum output-datum
correction is implementable now; a 100%-priority coastal harmonic layer
requires a separately published coastal harmonic atlas.
