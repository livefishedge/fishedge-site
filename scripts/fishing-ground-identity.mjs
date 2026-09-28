// Deterministic identity resolver shared by the catalog builders. It keeps
// source records and geometry while choosing one display identity for nearby
// spelling/descriptor variants.

const DESCRIPTORS = new Set(['canyon', 'valley', 'ridge', 'lump', 'lumps', 'rock', 'rocks', 'reef', 'reefs', 'bank', 'banks', 'shoal', 'shoals', 'hole', 'holes', 'bed', 'beds', 'ground', 'grounds', 'slough', 'slue', 'channel', 'point', 'points', 'bar', 'bars', 'buoy', 'rips']);
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
  return pa.every((code, index) => code && code === pb[index]);
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
  const resolved = [];
  for (const raw of (features || []).filter(item => String(item?.name || '').trim())) {
    const item = { ...raw, name: String(raw.name || '').trim(), aliases: Array.isArray(raw.aliases) ? raw.aliases.slice() : [] };
    const existing = resolved.find(candidate => identityMatch(candidate, item));
    if (!existing) {
      item.id = item.id || stableId(item);
      resolved.push(item);
      continue;
    }
    if (item.name !== existing.name && !existing.aliases.includes(item.name)) existing.aliases.push(item.name);
    if (item.source && !existing.sources?.includes(item.source)) existing.sources = [...(existing.sources || [existing.source]), item.source];
    if (item.geometry) existing.geometry = mergeGeometry(existing.geometry, item.geometry);
  }
  return resolved;
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
