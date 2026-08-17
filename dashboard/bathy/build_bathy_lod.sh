#!/usr/bin/env bash
# build_bathy_lod.sh — Build medium/fine PBF vector tiles for FishEdge bathy LOD.
#
# Inputs (download separately, do NOT check in):
#   - NOAA BlueTopo GeoTIFF tiles intersecting the Baltimore Canyon pilot bbox
#     (or whatever the manifest's mosaic_files lists).
#   - NOAA NCEI multibeam surveys intersecting the same bbox, for the fine
#     tier. Survey IDs go in the manifest.
#
# Output:
#   - One MBTiles archive per LOD + per region, written to
#     dist/<region>/<lod>.mbtiles.
#   - Optionally exploded to dist/<region>/<lod>/{z}/{x}/{y}.pbf for direct
#     upload to R2.
#
# Usage:
#   REGION=usec_md  ./build_bathy_lod.sh
#   REGION=usec_md  LOD_TIER=fine  ./build_bathy_lod.sh
#
# Tools required:
#   - gdalbuildvrt, gdalwarp, gdal_contour (>= GDAL 3.4)
#   - tippecanoe  (https://github.com/felt/tippecanoe)
#   - mb-util     (https://github.com/mapbox/mbutil) for {z}/{x}/{y}.pbf explode
#   - jq          for the manifest

set -euo pipefail

REGION="${REGION:-usec_md}"
LOD_TIER="${LOD_TIER:-all}"      # all | medium | fine
SRC_DIR="${SRC_DIR:-./src/${REGION}}"
WORK_DIR="${WORK_DIR:-./work/${REGION}}"
DIST_DIR="${DIST_DIR:-./dist/${REGION}}"
MANIFEST="${MANIFEST:-dashboard/bathy/lod-manifest.json}"

CRS="${CRS:-EPSG:32618}"         # UTM 18N — Mid-Atlantic

# ─── Validate manifest exists ───────────────────────────────────────────
if [[ ! -f "${MANIFEST}" ]]; then
  echo "❌ Manifest missing: ${MANIFEST}" >&2
  echo "   Populate dashboard/bathy/lod-manifest.json first." >&2
  exit 2
fi

# ─── Tier settings (mirrors CONFIG in dashboard/bathy-lod.js) ──────────
case "${LOD_TIER}" in
  medium)
    CONTOUR_INTERVAL_M=25
    PBF_MIN_ZOOM=8
    PBF_MAX_ZOOM=10
    ;;
  fine)
    CONTOUR_INTERVAL_M=10
    PBF_MIN_ZOOM=11
    PBF_MAX_ZOOM=14
    ;;
  all)
    CONTOUR_INTERVAL_M=""
    PBF_MIN_ZOOM=""
    PBF_MAX_ZOOM=""
    ;;
  *)
    echo "❌ LOD_TIER must be: medium | fine | all (got: ${LOD_TIER})" >&2
    exit 2
    ;;
esac

# ─── Source inventory ──────────────────────────────────────────────────
# Read the mosaic_files[] from the manifest for the requested tier.
# Falls back to a directory scan of SRC_DIR if the array is empty (for
# prototype runs).
mkdir -p "${SRC_DIR}" "${WORK_DIR}" "${DIST_DIR}"

tiempo() { date +"%Y-%m-%dT%H:%M:%SZ"; }
log()    { echo "[$(tiempo)] $*"; }

build_one_lod() {
  local tier="$1"
  local interval="$2"
  local zmin="$3"
  local zmax="$4"
  local out="${DIST_DIR}/${tier}.mbtiles"

  log "▶ ${tier}: interval=${interval}m, z=${zmin}-${zmax}"

  # 1. Build VRT from source rasters (one VRT per tier). Skip non-existent
  #    files so the pipeline runs with whatever's downloaded.
  local vrt="${WORK_DIR}/${tier}.vrt"
  : > "${WORK_DIR}/${tier}.sources.txt"
  if [[ -d "${SRC_DIR}/${tier}" ]]; then
    find "${SRC_DIR}/${tier}" -maxdepth 1 \( -name "*.tif" -o -name "*.tiff" \) >> "${WORK_DIR}/${tier}.sources.txt"
  fi
  if [[ ! -s "${WORK_DIR}/${tier}.sources.txt" ]]; then
    log "  ⚠ No source rasters for ${tier} in ${SRC_DIR}/${tier} — skipping."
    return 0
  fi
  gdalbuildvrt -srcnodata -9999 "${vrt}" -input_file_list "${WORK_DIR}/${tier}.sources.txt"

  # 2. Warp to projected CRS at source-native cell size.
  local warped="${WORK_DIR}/${tier}_${CRS}.tif"
  gdalwarp -t_srs "${CRS}" -dstnodata -9999 -r bilinear \
    -co COMPRESS=DEFLATE -co TILED=YES \
    "${vrt}" "${warped}"

  # 3. Generate contours.
  local contours="${WORK_DIR}/${tier}_contours.fgb"
  gdal_contour -a depth_m -i "${interval}" -nln "${tier}" -of FlatGeobuf \
    "${warped}" "${contours}"

  # 4. Convert to GeoJSONSeq for Tippecanoe.
  local seq="${WORK_DIR}/${tier}_contours.geojsonseq"
  ogr2ogr -f GeoJSONSeq -t_srs EPSG:4326 "${seq}" "${contours}"

  # 5. Tile with Tippecanoe.
  local layername="bathy_${tier}"
  tippecanoe \
    --output="${out}" \
    --layer="${layername}" \
    --minimum-zoom="${zmin}" \
    --maximum-zoom="${zmax}" \
    --drop-densest-as-needed \
    --extend-zooms-if-still-dropping \
    --force \
    --read-parallel \
    "${seq}"

  log "  ✓ ${out}"
  log "    size: $(du -h "${out}" | cut -f1)"
}

# ─── Run ───────────────────────────────────────────────────────────────
if [[ "${LOD_TIER}" == "all" ]]; then
  build_one_lod medium 25  8  10
  build_one_lod fine   10 11  14
else
  build_one_lod "${LOD_TIER}" "${CONTOUR_INTERVAL_M}" "${PBF_MIN_ZOOM}" "${PBF_MAX_ZOOM}"
fi

# ─── Optional: explode to {z}/{x}/{y}.pbf for R2 ───────────────────────
if [[ "${EXPLODE:-0}" == "1" ]]; then
  for tier in medium fine; do
    mbtile="${DIST_DIR}/${tier}.mbtiles"
    if [[ -f "${mbtile}" ]]; then
      out="${DIST_DIR}/${tier}"
      log "▶ Exploding ${mbtile} → ${out}/{z}/{x}/{y}.pbf"
      mb-util --image_format=pbf "${mbtile}" "${out}"
      log "  ✓ $(find "${out}" -name "*.pbf" | wc -l) tiles"
    fi
  done
fi

log "Done. Upload the *.mbtiles (or exploded PBF dirs) to:"
log "  https://data.fishedge.live/dev/bathy/v1/${REGION}/{medium|fine}/"