import { writeFile, mkdir } from 'node:fs/promises';

// Mid-Atlantic/Delmarva coverage used by the current dashboard region. Keep
// this bounded: the BOEM atlas is slow on oversized envelopes.
const bbox = [-77, 35, -71, 41];
const NJ_URL = 'https://www.shore-guide.com/data/downloads/nj-fishing-grounds.geojson';
const MD_FISHING_URL = 'https://mdgeodata.md.gov/imap/rest/services/Biota/MD_Finfish/FeatureServer/10/query';
const MD_REEF_URL = 'https://mdgeodata.md.gov/imap/rest/services/Biota/MD_Finfish/FeatureServer/9/query';
const ATLANTIC_URL = 'https://gis.boem.gov/arcgis/rest/services/AtlanticFishGuide/Atlantic_Coast_Fishing_Atlas/MapServer/2/query';

const aliases = new Map([
  ['norfolk', 'Norfolk Canyon'], ['norfolk canyon', 'Norfolk Canyon'], ['norfork canyon', 'Norfolk Canyon'],
  ['baltimore', 'Baltimore Canyon'], ['baltimore canyon', 'Baltimore Canyon'],
  ['wilmington', 'Wilmington Canyon'], ['wilmington canyon', 'Wilmington Canyon'],
  ['hudson', 'Hudson Canyon'], ['hudson canyon', 'Hudson Canyon'],
  ['poormans canyon', "Poor Man's Canyon"], ['poor mans canyon', "Poor Man's Canyon"],
  ['cigar or little bimini', 'The Cigar'], ['the cigar', 'The Cigar'],
  ['21 mile little hill or lump', '21 Mile Hill'], ['21 mile hill', '21 Mile Hill'],
  ['3 mile 10 mile hill or lump', '3 Mile Hill'], ['3 mile hill', '3 Mile Hill']
]);

function canonicalName(raw) {
  const name = String(raw || '').trim();
  const key = name.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  return aliases.get(key) || name;
}

function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;
  let area = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[i + 1];
    const cross = ax * by - bx * ay;
    area += cross; cx += (ax + bx) * cross; cy += (ay + by) * cross;
  }
  if (Math.abs(area) < 1e-12) return null;
  return [cx / (3 * area), cy / (3 * area)];
}

function geometryPoint(geometry) {
  if (!geometry) return null;
  if (geometry.type === 'Polygon') return ringCentroid(geometry.coordinates?.[0]);
  if (geometry.type === 'MultiPolygon') return ringCentroid(geometry.coordinates?.[0]?.[0]);
  if (Array.isArray(geometry.rings)) return ringCentroid(geometry.rings[0]);
  return null;
}

function inBbox([lon, lat]) {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

async function arcgis(url, type, source) {
  const params = new URLSearchParams({
    where: '1=1', geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope',
    inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects',
    outFields: '*', returnGeometry: 'true', resultRecordCount: '2000', f: 'json'
  });
  const response = await fetch(`${url}?${params}`);
  if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
  const json = await response.json();
  return (json.features || []).map(feature => {
    const attrs = feature.attributes || {};
    const name = attrs.Name || attrs.name || attrs.NAME;
    const geometry = feature.geometry?.rings ? { type: 'Polygon', coordinates: feature.geometry.rings } : null;
    const point = geometryPoint(geometry);
    if (!name || !point || !inBbox(point)) return null;
    return { name: canonicalName(name), type, source, point, geometry };
  }).filter(Boolean);
}

async function main() {
  const nj = await (await fetch(NJ_URL)).json();
  const njItems = (nj.features || []).map(feature => {
    const properties = feature.properties || {};
    const point = geometryPoint(feature.geometry);
    if (!properties.name || !point || !inBbox(point)) return null;
    return { name: canonicalName(properties.name), type: 'Fishing ground', source: 'NJ DEP / Shore Guide', point, geometry: feature.geometry };
  }).filter(Boolean);
  const [mdFishing, mdReefs, atlantic] = await Promise.all([
    arcgis(MD_FISHING_URL, 'Fishing ground', 'Maryland DNR'),
    arcgis(MD_REEF_URL, 'Artificial reef', 'Maryland DNR'),
    arcgis(ATLANTIC_URL, 'Fishing ground', 'BOEM Atlantic Fishing Atlas')
  ]);
  const byName = new Map();
  for (const item of [...njItems, ...mdFishing, ...mdReefs, ...atlantic]) {
    const existing = byName.get(item.name);
    if (!existing) byName.set(item.name, item);
    else {
      existing.geometry = existing.geometry && item.geometry
        ? { type: 'MultiPolygon', coordinates: [
            ...(existing.geometry.type === 'MultiPolygon' ? existing.geometry.coordinates : [existing.geometry.coordinates]),
            ...(item.geometry.type === 'MultiPolygon' ? item.geometry.coordinates : [item.geometry.coordinates])
          ] }
        : existing.geometry || item.geometry;
    }
  }
  const output = {
    version: 1,
    generated_at: new Date().toISOString(),
    bbox,
    features: [...byName.values()]
  };
  await mkdir('dashboard/data', { recursive: true });
  await writeFile('dashboard/data/fishing-grounds.json', JSON.stringify(output));
  console.log(`wrote ${output.features.length} canonical fishing grounds`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
