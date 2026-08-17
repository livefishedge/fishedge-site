# FishEdge Bathymetric LOD — Build, Deploy, Operate

**Branch:** `feat/bathy-lod-canyon-zoom`
**Dev build marker:** `2026-08-16T22-41Z-v12-bathy-lod-dev`
**Dev preview URL:** `https://feat-bathy-lod-canyon-zoom.fishedge-site.pages.dev/dashboard/`
**Production:** `fishedge.live/dashboard/` — **DO NOT MERGE TO MAIN** while this branch is open.

Progressive resolution for depth contours. Coarse GEBCO grid is always
visible; medium (25 m) and fine (10 m) PBF vector tiles are requested
only when the viewport zoom + coverage cross the configured thresholds.

| LOD | Zoom | Contour interval | Source | Tile format |
|-----|------|------------------|--------|-------------|
| coarse | 0–7   | 100 / 200 / 500 / 1000 / 2000 / 5000 m | existing GEBCO 2026 raster-derived JSON (`gebco_bathy.json`) | inline Vector |
| medium | 8–10  | 25 m  | NOAA BlueTopo + NCEI multibeam (Mid-Atlantic) | `ol.source.VectorTile` PBF |
| fine   | 11–14 | 10 m  | NOAA NCEI multibeam (Baltimore Canyon pilot) | `ol.source.VectorTile` PBF |

---

## Architecture

```
dashboard/index.html
  ├── <script src="bathy-lod.js">     ← new module (window.BathyLodController)
  ├── ensureDesktopBathyContourLayer  ← attaches __bathyLodController
  ├── ensureMobileBathyContourLayer   ← attaches __bathyLodController (mobileEnabled: false default)
  ├── buildBathyContourLayer (combined) ← attaches __bathyLodController
  └── bindBathyMoveend callback       ← calls syncForView() then existing rebuild
       └── unbindBathyMoveend         ← also disposes the controller (region switch)
```

The controller (`BathyLodController`) owns a per-region map of
`ol.layer.VectorTile` instances (medium + fine), each backed by an
`ol.source.VectorTile`. When `syncForView()` decides the active LOD has
changed:

1. It checks the LOD-specific coverage bbox (`viewport center in bbox`).
2. It checks the failure cooldown (`failedLods[key]`) and short-circuits.
3. It instantiates a tile layer if needed, awaits first `tileloadend` or
   `tileloaderror`, with an 8 s timeout.
4. On success it cross-fades coarse → new LOD over 200 ms; on failure it
   stays on coarse and remembers the failure for 30 s.
5. Logs `[bathy] lod swap <from>-><to>; zoom <z>; <reason>; <ms>ms`.

Zoom hysteresis (0.25 around z=8 and z=11) prevents thrash on the boundary.
Mobile is opt-in via `window.BATHY_LOD_MOBILE_ENABLED = true`.

---

## Building the tile assets (offline)

The browser only loads tile URLs from the CDN. **Nothing in the dashboard
repo contains the tiles themselves.** They live on R2 under a dev-only
prefix.

```bash
# 1. Populate the manifest
$EDITOR dashboard/bathy/lod-manifest.json   # mosaic_files + URL/CRS/datum checksums

# 2. Download sources (manual — NOAA portals, possibly with auth)
mkdir -p src/usec_md/medium src/usec_md/fine
# … copy each NOAA GeoTIFF into the right tier dir

# 3. Build PBF tiles
REGION=usec_md ./dashboard/bathy/build_bathy_lod.sh

# 4. Explode to {z}/{x}/{y}.pbf
REGION=usec_md EXPLODE=1 ./dashboard/bathy/build_bathy_lod.sh
```

The build pipeline (`build_bathy_lod.sh`) expects: `gdalbuildvrt`,
`gdalwarp`, `gdal_contour` (GDAL ≥ 3.4), `ogr2ogr`, `tippecanoe`,
`mb-util`. On Debian/Ubuntu:

```bash
sudo apt-get install -y gdal-bin tippecanoe
pip install mbutil
```

---

## Publishing to the dev CDN prefix

Upload the exploded PBF dirs to a dev-only R2 bucket:

```
https://data.fishedge.live/dev/bathy/v1/usec_md/medium/{z}/{x}/{y}.pbf
https://data.fishedge.live/dev/bathy/v1/usec_md/fine/{z}/{x}/{y}.pbf
```

CORS must allow `GET`/`OPTIONS` from the Pages preview origin
(`https://feat-bathy-lod-canyon-zoom.fishedge-site.pages.dev`). Use
`Content-Type: application/vnd.mapbox-vector-tile` and let Cloudflare
gzip at the edge (do not pre-gzip unless you set
`Content-Encoding: gzip` consistently).

Immutable cache headers (`Cache-Control: public, max-age=31536000,
immutable`) on tile paths because they are versioned by the prefix.

---

## Verifying the dev preview

After pushing the branch and Cloudflare Pages builds the preview:

```bash
PREVIEW='https://feat-bathy-lod-canyon-zoom.fishedge-site.pages.dev/dashboard/'
MARKER='2026-08-16T22-41Z-v12-bathy-lod-dev'
PROD='https://fishedge.live/dashboard/'

curl -sI "$PREVIEW" | head                       # expect HTTP/2 200
curl -fsSL "$PREVIEW" | grep -c "$MARKER"        # expect >=1
curl -fsSL "$PROD"    | grep -c "$MARKER"        # expect 0 (prod untouched)
```

In the browser, open DevTools Network + Console:

1. **No medium/fine PBF requests at ocean zoom** (z < 8).
2. **First medium request fires when crossing z=8** inside the medium
   coverage bbox.
3. **First fine request fires when crossing z=11** inside the Baltimore
   Canyon bbox.
4. **Cross-fade** — `[bathy] lod swap coarse->medium; zoom 8.10; …` then
   `[bathy] desktop:medium rebuild <ms>ms; <segs> segments; <levels>
   level features`.
5. **Failure fallback** — block `https://data.fishedge.live` in DevTools
   and confirm coarse stays visible + `[bathy] lod medium unavailable;
   retaining coarse` warning appears exactly once per session.

---

## Acceptance checklist

- Ocean zoom (z=5) shows only coarse/major contours. No PBF traffic.
- Canyon zoom (z=12) inside the Baltimore Canyon bbox shows fine 10 m
  contours; outside it falls back to medium (if covered) or coarse.
- No double `moveend` listeners — a single zoom gesture causes at most
  one debounced LOD evaluation + one coarse rebuild.
- Region switch disposes the previous controller and creates a fresh
  one for the new region.
- Mobile stays on coarse by default; setting
  `window.BATHY_LOD_MOBILE_ENABLED = true` enables the same LOD behavior.
- Prod `fishedge.live` shows zero matches for the new build marker.

---

## Open follow-ups (not in this PR)

- Extend fine coverage to other canyons (Norfolk, Washington, Hudson).
- Add contour-line decluttering + zoom-gated depth labels.
- PMTiles archive as an alternative to `{z}/{x}/{y}.pbf` once a range
  reader is added to the OL map.
- Lint/format `bathy-lod.js` against project ESLint config.