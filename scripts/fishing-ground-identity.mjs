// Deterministic identity resolver shared by the catalog builders. It keeps
// source records and geometry while choosing one display identity for nearby
// spelling/descriptor variants.

const DESCRIPTORS = new Set(['canyon', 'valley', 'ridge', 'lump', 'lumps', 'rock', 'rocks', 'reef', 'reefs', 'bank', 'banks', 'shoal', 'shoals', 'hole', 'holes', 'bed', 'beds', 'ground', 'grounds', 'slough', 'slue', 'channel', 'point', 'points', 'bar', 'bars', 'buoy', 'rips', 'deep']);
const PROTECTED = /(^|\s)block\b|(^|\s)box\b/i;
const SYNONYMS = {
  inside: 'inside', inner: 'inside', inshore: 'inside',
  outside: 'outside', outer: 'outside',
  pt: 'point', pts: 'points', pnt: 'point', pnts: 'points',
  pk: 'peak', mt: 'mount', shl: 'shoal', shoals: 'shoal',
  rks: 'rock', rocks: 'rock', rfs: 'reef', reefs: 'reef',
  bks: 'bank', banks: 'bank', grnd: 'ground', grounds: 'ground',
  beds: 'bed', lumps: 'lump', holes: 'hole', grounds: 'ground',
  noreast: 'northeast', norwest: 'northwest', soueast: 'southeast', souwest: 'southwest',
};
const QUALIFIERS = new Set(['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest', 'central', 'mid', 'middle', 'inner', 'inside', 'inshore', 'outer', 'outside']);
const NUMBER_WORDS = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
const DISPLAY_PROTECTED = /(^|\s)(block|box|site|fathom|fathoms|nm|mile|miles)\b|\b\d+(?:\.\d+)?\s*(?:ft|nm|mile|miles|fathom|fathoms)\b/i;
const OFFICIAL_SOURCES = new Set(['Maryland DNR', 'BOEM Atlantic Fishing Atlas', 'NOAA/ArcGIS US Submarine Canyons']);
const UNOFFICIAL_SOURCES = new Set(['NJ DEP / Shore Guide']);
const MAJOR_OFFSHORE_RE = /\b(canyon|canyons|seamount|deepwater|offshore|outer bank|outer banks|major bank)\b/i;
const INSHORE_RE = /\b(inlet|buoy|bridge|sewer|jetty|channel|shore|beach|inshore|inside|slough|harbor|harbour|bay)\b/i;

export function classifyFeature(item) {
  const names = [item?.name, ...(Array.isArray(item?.aliases) ? item.aliases : [])].filter(Boolean).join(' ');
  const sourceNames = [...new Set([...(Array.isArray(item?.sources) ? item.sources : []), item?.source].filter(Boolean))];
  const official = sourceNames.filter(source => OFFICIAL_SOURCES.has(source)).length;
  const unofficial = sourceNames.filter(source => UNOFFICIAL_SOURCES.has(source)).length;
  const source_status = official && unofficial ? 'mixed' : official ? 'official' : unofficial ? 'unofficial' : 'unknown';
  const source_status_label = source_status === 'official' ? 'Official source' : source_status === 'unofficial' ? 'Unofficial reference' : source_status === 'mixed' ? 'Mixed provenance' : 'Unclassified source';
  const explicitMajor = MAJOR_OFFSHORE_RE.test(names) || /canyon|seamount/i.test(String(item?.type || ''));
  const explicitInshore = INSHORE_RE.test(names);
  const zone = explicitMajor ? 'major_offshore' : explicitInshore ? 'inshore' : 'offshore';
  return {
    zone,
    zone_label: zone === 'major_offshore' ? 'Major offshore' : zone === 'inshore' ? 'Inshore' : 'Offshore',
    source_status,
    source_status_label,
    classification_confidence: explicitMajor || explicitInshore ? 'high' : 'default',
    classification_reason: explicitMajor ? 'explicit offshore/deepwater/canyon terminology' : explicitInshore ? 'explicit inlet/coastal/inshore terminology' : 'regional offshore default',
  };
}

export function normalizedName(value) {
  return String(value || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9()]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function soundex(value) {
  const word = String(value || '').replace(/[^a-z]/gi, '').toUpperCase();
  if (!word) return '';
  const map = { B:1,F:1,P:1,V:1,C:2,G:2,J:2,K:2,Q:2,S:2,X:2,Z:2,D:3,T:3,L:4,M:5,N:5,R:6 };
  let out = word[0]; let previous = map[word[0]] || 0;
  for (const ch of word.slice(1)) {
    const code = map[ch] || 0;
    if (code && code !== previous) out += code;
    previous = code;
    if (out.length === 4) break;
  }
  return (out + '000').slice(0, 4);
}

function coreTokens(value) {
  const raw = normalizedName(value)
    .replace(/^doc\s+/, '')
    .replace(/\b(north|south|east|west|northeast|northwest|southeast|southwest)\s+end\b/g, '$1')
    .replace(/\bnorth\s+east\b/g, 'northeast')
    .replace(/\bnorth\s+west\b/g, 'northwest')
    .replace(/\bsouth\s+east\b/g, 'southeast')
    .replace(/\bsouth\s+west\b/g, 'southwest')
    .replace(/\((?:north|south|east|west|northeast|northwest|southeast|southwest)\)/g, '')
    .replace(/(canyon|valley|ridge|lumps?|rocks?|reefs?|banks?|shoals?|holes?|beds?|grounds?|slough|slue|channel|points?|bars?|buoy|rips)$/g, ' $1');
  return raw.split(' ').map(token => NUMBER_WORDS[token] || SYNONYMS[token] || token).filter(token => token && !DESCRIPTORS.has(token));
}

function nameVariants(value) {
  const raw = String(value || '').replace(/\((?:north|south|east|west|northeast|northwest|southeast|southwest)\)/gi, ' ');
  return raw.split(/\s+or\s+|\s*\/\s*/i).map(part => part.trim()).filter(Boolean);
}

function directionTokens(value) {
  return coreTokens(value).filter(token => QUALIFIERS.has(token) && /^(north|south|east|west|northeast|northwest|southeast|southwest)$/.test(token));
}

function numericTokens(value) {
  return normalizedName(value).split(' ').map(token => NUMBER_WORDS[token] || token).filter(token => /\d/.test(token));
}

function phoneticTokens(value) {
  return coreTokens(value).map(soundex);
}

function tokenIdentityMatch(a, b) {
  const aa = coreTokens(a), bb = coreTokens(b);
  if (!aa.length || !bb.length || aa.length !== bb.length) return false;
  const pa = phoneticTokens(a), pb = phoneticTokens(b);
  return pa.every((code, index) => code && code === pb[index]) ||
    pa.slice().sort().every((code, index) => code && code === pb.slice().sort()[index]);
}

function editSimilarity(a, b) {
  const aa = coreTokens(a).join('');
  const bb = coreTokens(b).join('');
  if (!aa || !bb) return 0;
  const row = Array.from({ length: bb.length + 1 }, (_, i) => i);
  for (let i = 1; i <= aa.length; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= bb.length; j++) {
      const next = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (aa[i - 1] === bb[j - 1] ? 0 : 1));
      prev = next;
    }
  }
  return 1 - row[bb.length] / Math.max(aa.length, bb.length);
}

function featureNames(item) {
  return [item?.name, ...(Array.isArray(item?.aliases) ? item.aliases : [])].filter(Boolean);
}

function qualifierTokens(value) {
  return coreTokens(value).filter(token => QUALIFIERS.has(token)).sort();
}

function geometryBbox(geometry) {
  if (!geometry?.coordinates) return null;
  const points = [];
  const walk = value => {
    if (Array.isArray(value) && typeof value[0] === 'number') points.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
  };
  walk(geometry.coordinates);
  if (!points.length) return null;
  return [Math.min(...points.map(point => point[0])), Math.min(...points.map(point => point[1])),
    Math.max(...points.map(point => point[0])), Math.max(...points.map(point => point[1]))];
}

function bboxContains(a, b) {
  return a && b && a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    const intersects = ((yi > point[1]) !== (yj > point[1])) && (point[0] < (xj - xi) * (point[1] - yi) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonContainsPoint(polygon, point) {
  if (!polygon?.length || !pointInRing(point, polygon[0])) return false;
  return !polygon.slice(1).some(hole => pointInRing(point, hole));
}

function geometryOuterRings(geometry) {
  if (!geometry?.coordinates) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(polygon => polygon[0]);
  return [];
}

function geometryContains(container, child) {
  const containers = geometryOuterRings(container), children = geometryOuterRings(child);
  return containers.length > 0 && children.length > 0 && children.every(ring => ring.every(point => containers.some(containerRing => pointInRing(point, containerRing))));
}

function displayCore(value) {
  return coreTokens(value).filter(token => !QUALIFIERS.has(token)).join('');
}

function displaySimilarity(a, b) {
  const left = displayCore(a), right = displayCore(b);
  if (left.length < 4 || right.length < 4) return 0;
  if (left === right || (Math.min(left.length, right.length) >= 5 && (left.includes(right) || right.includes(left)))) return 1;
  return editSimilarity(a, b);
}

function structureTokens(value) {
  return normalizedName(value).split(' ').filter(token => DESCRIPTORS.has(token) || DESCRIPTORS.has(SYNONYMS[token])).map(token => SYNONYMS[token] || token).map(token => token.replace(/s$/, '')).sort();
}

// Display-equivalence is intentionally separate from source identity. It is
// used only where two nearby records are the same captain-facing ground or a
// parent polygon redundantly names a contained child. Protected operational
// subareas never enter this relation.
const REVIEWED_DISPLAY_GROUPS = [
  {
    ids: ['barnegat-inlet-buoy:-74.0642:39.7412', 'bi:-74.0585:39.7410'],
    reason: 'Mike screenshot review 2026-09-28: BI is the local Barnegat Inlet buoy label',
  },
  {
    ids: ['rock-pile:-73.0047:40.1940', 'rock-piles:-72.9143:40.0954'],
    reason: 'Mike screenshot review 2026-09-28: one display group; retain both disjoint source footprints, not a coordinate reconciliation',
  },
];

export function displayEquivalent(a, b) {
  if (a?.point && b?.point && REVIEWED_DISPLAY_GROUPS.some(group =>
    group.ids.includes(stableId(a)) && group.ids.includes(stableId(b)))) return true;
  if (!a?.point || !b?.point || DISPLAY_PROTECTED.test(a.name || '') || DISPLAY_PROTECTED.test(b.name || '')) return false;
  const dx = (a.point[0] - b.point[0]) * Math.cos((a.point[1] + b.point[1]) * Math.PI / 360);
  const dy = a.point[1] - b.point[1];
  const distanceNm = Math.hypot(dx, dy) * 60;
  if (distanceNm > 9) return false;
  const similarity = displaySimilarity(a.name, b.name);
  const qa = qualifierTokens(a.name), qb = qualifierTokens(b.name);
  const conflictingDirections = qa.length && qb.length && qa.join('|') !== qb.join('|');
  if (conflictingDirections) return false;
  const sameBase = displayCore(a.name) === displayCore(b.name) && displayCore(a.name).length >= 4;
  if (distanceNm > 9) return false;
  const sa = structureTokens([a.name, ...(a.aliases || [])].join(' ')), sb = structureTokens([b.name, ...(b.aliases || [])].join(' '));
  const structureCompatible = !sa.length || !sb.length || sa.join('|') === sb.join('|');
  const contained = geometryContains(a.geometry, b.geometry) || geometryContains(b.geometry, a.geometry);
  const bboxContained = bboxContains(geometryBbox(a.geometry), geometryBbox(b.geometry)) || bboxContains(geometryBbox(b.geometry), geometryBbox(a.geometry));
  if (sameBase) return similarity >= 0.9 && (structureCompatible || contained || bboxContained);
  return contained && similarity >= 0.55 && (structureCompatible || sa.includes('canyon') || sb.includes('canyon'));
}

export function identityMatch(a, b) {
  if (!a || !b || !a.point || !b.point || PROTECTED.test(a.name || '') || PROTECTED.test(b.name || '')) return false;
  const na = numericTokens(a.name), nb = numericTokens(b.name);
  if (na.length !== nb.length || na.some((n, i) => n !== nb[i])) return false;
  const dx = (a.point[0] - b.point[0]) * Math.cos((a.point[1] + b.point[1]) * Math.PI / 360);
  const dy = a.point[1] - b.point[1];
  if (Math.hypot(dx, dy) > 0.12) return false;
  return featureNames(a).some(nameA => nameVariants(nameA).some(left => featureNames(b).some(nameB => nameVariants(nameB).some(right => {
    const qa = qualifierTokens(left), qb = qualifierTokens(right);
    if (qa.length !== qb.length || qa.some((q, i) => q !== qb[i])) return false;
    const buoySpelling = name => normalizedName(name).replace(/\bbouy\b/g, 'buoy');
    if (buoySpelling(left) === buoySpelling(right)) return true;
    const aa = coreTokens(left).join('');
    const bb = coreTokens(right).join('');
    return aa.length >= 2 && (aa === bb || tokenIdentityMatch(left, right) || editSimilarity(left, right) >= 0.82);
  }))));
}

export function stableId(item) {
  const key = normalizedName(item.name).replace(/ /g, '-');
  return `${key}:${Number(item.point[0]).toFixed(4)}:${Number(item.point[1]).toFixed(4)}`;
}

export function resolveFeatures(features) {
  const items = (features || []).filter(item => String(item?.name || '').trim()).map(raw => ({
    ...raw,
    name: String(raw.name || '').trim(),
    aliases: Array.isArray(raw.aliases) ? raw.aliases.slice() : [],
  }));
  const parent = items.map((_, index) => index);
  const find = index => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  const union = (left, right) => { const a = find(left), b = find(right); if (a !== b) parent[b] = a; };
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    if (identityMatch(items[i], items[j])) union(i, j);
  }
  const groups = new Map();
  items.forEach((item, index) => { const root = find(index); const group = groups.get(root) || []; group.push(item); groups.set(root, group); });
  return [...groups.values()].map(group => {
    const [first, ...rest] = group;
    const item = { ...first, aliases: [...(first.aliases || [])], source_record_ids: group.flatMap(member => member.source_record_ids || [member.id || stableId(member)]) };
    for (const other of rest) {
      if (other.name !== item.name && !item.aliases.includes(other.name)) item.aliases.push(other.name);
      for (const alias of other.aliases || []) if (alias !== item.name && !item.aliases.includes(alias)) item.aliases.push(alias);
      if (other.source && !item.sources?.includes(other.source)) item.sources = [...(item.sources || [item.source]), other.source];
      if (other.geometry) item.geometry = mergeGeometry(item.geometry, other.geometry);
    }
    item.id = item.id || stableId(item);
    return item;
  });
}

export function resolveDisplayGroups(features) {
  const items = (features || []).map(item => ({ ...item, aliases: Array.isArray(item.aliases) ? item.aliases.slice() : [] }));
  const parent = items.map((_, index) => index);
  const find = index => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  const union = (left, right) => { const a = find(left), b = find(right); if (a !== b) parent[b] = a; };
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) if (displayEquivalent(items[i], items[j])) union(i, j);
  const groups = new Map();
  items.forEach((item, index) => { const root = find(index); const group = groups.get(root) || []; group.push(item); groups.set(root, group); });
  return [...groups.values()].map(group => {
    const [first, ...rest] = group;
    const item = { ...first, aliases: [...(first.aliases || [])], related_ids: group.flatMap(member => member.source_record_ids || [member.id || stableId(member)]), source_record_ids: group.flatMap(member => member.source_record_ids || [member.id || stableId(member)]) };
    for (const other of rest) {
      if (other.name !== item.name && !item.aliases.includes(other.name)) item.aliases.push(other.name);
      for (const alias of other.aliases || []) if (alias !== item.name && !item.aliases.includes(alias)) item.aliases.push(alias);
      if (other.geometry) item.geometry = mergeGeometry(item.geometry, other.geometry);
      if (other.source && !item.sources?.includes(other.source)) item.sources = [...(item.sources || [item.source]), other.source];
    }
    if (item.name === 'Barnrgat Ridge North' && item.aliases.includes('Barnegat, North End Ridge')) {
      item.aliases.push(item.name);
      item.name = 'Barnegat Ridge North';
    }
    item.display_group_id = item.id || stableId(item);
    item.display_group_size = group.length;
    Object.assign(item, classifyFeature(item));
    return item;
  });
}

export function mergeGeometry(a, b) {
  if (!a) return b;
  if (!b) return a;
  const parts = [];
  for (const geometry of [a, b]) {
    if (geometry.type === 'Polygon') parts.push(geometry.coordinates);
    if (geometry.type === 'MultiPolygon') parts.push(...geometry.coordinates);
  }
  const unique = [...new Map(parts.map(part => [JSON.stringify(part), part])).values()];
  return unique.length === 1 ? { type: 'Polygon', coordinates: unique[0] } : { type: 'MultiPolygon', coordinates: unique };
}
