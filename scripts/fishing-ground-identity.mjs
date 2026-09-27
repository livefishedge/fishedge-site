// Deterministic identity resolver shared by the catalog builders. It keeps
// source records and geometry while choosing one display identity for nearby
// spelling/descriptor variants.

const DESCRIPTORS = new Set(['canyon', 'valley', 'ridge', 'lump', 'lumps', 'rock', 'rocks', 'reef', 'reefs', 'bank', 'banks', 'shoal', 'shoals']);
const PROTECTED = /(^|\s)(block|site|box|nm|fathom|fathoms)\b|\b\d+(?:\.\d+)?\s*(?:nm|mile|miles|fathom|fathoms)\b/i;

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
    .replace(/\((?:north|south|east|west|northeast|northwest|southeast|southwest)\)/g, '')
    .replace(/(canyon|valley|ridge|lumps?|rocks?|reefs?|banks?|shoals?)$/g, ' $1');
  return raw.split(' ').filter(token => !DESCRIPTORS.has(token));
}

function directionTokens(value) {
  return normalizedName(value).replace(/\([^)]*\)/g, '').split(' ')
    .filter(token => /^(north|south|east|west|northeast|northwest|southeast|southwest)$/.test(token));
}

function numericPrefix(value) {
  return (normalizedName(value).split(' ')[0] || '').match(/^\d/);
}

function phoneticTokens(value) {
  return coreTokens(value).map(soundex);
}

function tokenIdentityMatch(a, b) {
  const aa = coreTokens(a), bb = coreTokens(b);
  if (!aa.length || aa.length !== bb.length) return false;
  const pa = phoneticTokens(a), pb = phoneticTokens(b);
  return pa.every((code, index) => code && code === pb[index]);
}

export function identityMatch(a, b) {
  if (!a || !b || !a.point || !b.point || PROTECTED.test(a.name || '') || PROTECTED.test(b.name || '')) return false;
  if (numericPrefix(a.name) && numericPrefix(b.name) && normalizedName(a.name).split(' ')[0] !== normalizedName(b.name).split(' ')[0]) return false;
  const da = directionTokens(a.name), db = directionTokens(b.name);
  if (da.length && db.length && da.join('|') !== db.join('|')) return false;
  const dx = (a.point[0] - b.point[0]) * Math.cos((a.point[1] + b.point[1]) * Math.PI / 360);
  const dy = a.point[1] - b.point[1];
  if (Math.hypot(dx, dy) > 0.12) return false;
  const aa = coreTokens(a.name).join('');
  const bb = coreTokens(b.name).join('');
  return aa.length >= 2 && (aa === bb || tokenIdentityMatch(a.name, b.name));
}

export function stableId(item) {
  const key = normalizedName(item.name).replace(/ /g, '-');
  return `${key}:${Number(item.point[0]).toFixed(4)}:${Number(item.point[1]).toFixed(4)}`;
}

export function resolveFeatures(features) {
  const resolved = [];
  for (const raw of (features || []).filter(item => String(item?.name || '').trim())) {
    const item = { ...raw, name: String(raw.name || '').trim(), aliases: [] };
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
