import { readFile, writeFile, mkdir } from 'node:fs/promises';

const input = JSON.parse(await readFile('dashboard/data/fishing-grounds.json', 'utf8'));
const features = input.features || [];

function slug(value) {
  return String(value || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function normalized(value) {
  return String(value || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// These are display families, not destructive merges. Every source child stays
// addressable and retains its original geometry and point.
function familyName(name) {
  const raw = String(name || '').trim();
  const distanceBlock = raw.match(/^(.*?\bblock)\s*(?:[-—]\s*)?(?:\d+(?:\.\d+)?\s*nm)(?:\s+\d+)?$/i);
  if (distanceBlock) return distanceBlock[1].replace(/\s+/g, ' ').trim();
  const numberedBlock = raw.match(/^(.*?\bblock)\s*[-—]?\s*\d+$/i);
  if (numberedBlock) return numberedBlock[1].replace(/\s+/g, ' ').trim();
  return raw;
}

function sourceStatus(source) {
  if (source === 'Maryland DNR' || source === 'BOEM Atlantic Fishing Atlas' || source === 'NOAA/ArcGIS US Submarine Canyons') {
    return { source_class: 'official_source', review_status: 'default' };
  }
  if (source === 'NJ DEP / Shore Guide') {
    return { source_class: 'derived_official_geometry', review_status: 'provisional' };
  }
  return { source_class: 'unclassified', review_status: 'reference_only' };
}

const records = features.map((feature, index) => {
  const point = feature.point || [null, null];
  const id = feature.id || `${slug(feature.name)}:${Number(point[0]).toFixed(4)}:${Number(point[1]).toFixed(4)}`;
  const family = familyName(feature.name);
  return {
    structure_id: id,
    family_id: `${slug(feature.source)}:${slug(family)}`,
    family_name: family,
    name: feature.name,
    type: feature.type,
    source: feature.source,
    source_class: sourceStatus(feature.source).source_class,
    review_status: sourceStatus(feature.source).review_status,
    point,
    aliases: feature.aliases || [],
    source_record_index: index,
    source_record_id: feature.id || null,
  };
});

const families = new Map();
for (const record of records) {
  const family = families.get(record.family_id) || {
    family_id: record.family_id,
    family_name: record.family_name,
    child_structure_ids: [],
    child_count: 0,
    source_classes: new Set(),
    review_status: 'default',
  };
  family.child_structure_ids.push(record.structure_id);
  family.child_count += 1;
  family.source_classes.add(record.source_class);
  if (record.review_status !== 'default') family.review_status = 'provisional';
  families.set(record.family_id, family);
}

// Choose a real child nearest the family centroid. Never invent a midpoint
// that could be mistaken for a sampled or navigable fishing target.
for (const family of families.values()) {
  const children = family.child_structure_ids.map(id => records.find(record => record.structure_id === id));
  const valid = children.filter(record => Number.isFinite(record.point[0]) && Number.isFinite(record.point[1]));
  const center = valid.reduce((sum, record) => [sum[0] + record.point[0], sum[1] + record.point[1]], [0, 0]).map(v => valid.length ? v / valid.length : null);
  const representative = valid.slice().sort((a, b) => {
    const da = Math.hypot(a.point[0] - center[0], a.point[1] - center[1]);
    const db = Math.hypot(b.point[0] - center[0], b.point[1] - center[1]);
    return da - db;
  })[0];
  family.representative_structure_id = representative?.structure_id || null;
  family.source_classes = [...family.source_classes].sort();
}

await mkdir('dashboard/data', { recursive: true });
await writeFile('dashboard/data/fishing-grounds-registry.json', JSON.stringify({
  version: 1,
  generated_at: new Date().toISOString(),
  input_catalog_version: input.version,
  policy: {
    default_geometry: 'retain all source geometry',
    default_labels: 'one family label at regional scale; child labels at close zoom',
    representative_anchor: 'nearest real child to family centroid',
    provisional_source: 'NJ DEP geometry via Shore Guide name enrichment is not treated as independently verified naming',
  },
  sources: {
    'NJ DEP / Shore Guide': { url: 'https://www.shore-guide.com/data/downloads/nj-fishing-grounds.geojson', class: 'derived_official_geometry' },
    'Maryland DNR': { class: 'official_source' },
    'BOEM Atlantic Fishing Atlas': { class: 'official_source' },
    'NOAA/ArcGIS US Submarine Canyons': { class: 'official_source' },
  },
  records,
  families: [...families.values()],
}, null, 2) + '\n');

const littleEgg = [...families.values()].filter(f => /little egg .*deep ?water block/i.test(f.family_name));
console.log(JSON.stringify({ records: records.length, families: families.size, littleEgg }, null, 2));
