import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { identityMatch } from './fishing-ground-identity.mjs';

const DESCRIPTORS = new Set(['canyon','valley','ridge','lump','lumps','rock','rocks','reef','reefs','bank','banks','shoal','shoals','hole','holes','bed','beds','ground','grounds','slough','slue','channel','point','points','bar','bars','buoy','rips']);
const SYNONYMS = { inside:'inside', inner:'inside', inshore:'inside', outside:'outside', outer:'outside', pt:'point', pnt:'point', shl:'shoal', rks:'rock', bks:'bank', grnd:'ground' };
const QUALIFIERS = new Set(['north','south','east','west','northeast','northwest','southeast','southwest','central','mid','middle','inside','inshore','inner','outside','outer']);
const NUMBER_WORDS = { zero:'0', one:'1', two:'2', three:'3', four:'4', five:'5', six:'6', seven:'7', eight:'8', nine:'9', ten:'10' };
const normalize = value => String(value || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const variants = value => String(value || '').split(/\s+or\s+|\s*\/\s*/i).map(s => s.trim()).filter(Boolean);
const tokens = value => normalize(value).split(' ').map(token => NUMBER_WORDS[token] || SYNONYMS[token] || token).filter(Boolean);
const core = value => tokens(value).filter(token => !DESCRIPTORS.has(token));
const numbers = value => tokens(value).filter(token => /\d/.test(token));
const qualifiers = value => core(value).filter(token => QUALIFIERS.has(token)).sort();
const compact = value => core(value).join('');
function editSimilarity(a, b) {
  const aa = compact(a), bb = compact(b); if (!aa || !bb) return 0;
  const row = Array.from({ length: bb.length + 1 }, (_, i) => i);
  for (let i = 1; i <= aa.length; i++) { let prev = row[0]; row[0] = i; for (let j = 1; j <= bb.length; j++) { const old = row[j]; row[j] = aa[i-1] === bb[j-1] ? prev : 1 + Math.min(prev, row[j], row[j-1]); prev = old; } }
  return 1 - row[bb.length] / Math.max(aa.length, bb.length);
}
function distanceNm(a, b) { const dx = (a[0]-b[0]) * Math.cos((a[1]+b[1]) * Math.PI / 360); const dy = a[1]-b[1]; return Math.hypot(dx, dy) * 60; }
function bbox(geometry) {
  if (!geometry?.coordinates) return null; const points = [];
  const walk = value => Array.isArray(value?.[0]) ? value.forEach(walk) : points.push(value);
  walk(geometry.coordinates); if (!points.length) return null;
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
}
function overlaps(a, b) { return a && b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3]; }
function bestNameScore(a, b) {
  let best = 0;
  for (const left of variants(a.name)) for (const right of variants(b.name)) best = Math.max(best, editSimilarity(left, right));
  return best;
}
function decision(a, b, distance, similarity, geometryOverlap) {
  const qa = qualifiers(a.name), qb = qualifiers(b.name), na = numbers(a.name), nb = numbers(b.name);
  const qualifierConflict = qa.length !== qb.length || qa.some((q, i) => q !== qb[i]);
  const numericConflict = na.length !== nb.length || na.some((n, i) => n !== nb[i]);
  if (identityMatch(a, b)) return { type: 'merge', reason: 'same semantic core, compatible qualifiers/numbers, and within resolver distance' };
  if (qualifierConflict || numericConflict) return { type: 'keep-separate', reason: qualifierConflict ? 'directional or positional qualifier differs' : 'numeric/depth/block qualifier differs' };
  if (compact(a.name) === compact(b.name) && (geometryOverlap || distance <= 3)) return { type: 'merge', reason: 'same normalized identity and coincident/overlapping geometry' };
  if (similarity >= 0.82 && distance <= 3 && (geometryOverlap || a.source !== b.source)) return { type: 'merge', reason: 'spelling/abbreviation variant with nearby or overlapping cross-source geometry' };
  if (compact(a.name) === compact(b.name) || (similarity >= 0.7 && geometryOverlap)) return { type: 'parent/subarea', reason: 'same or near-same name with distinct footprint; retain both source records' };
  return { type: 'unresolved', reason: 'candidate requires source review; no automatic identity decision' };
}
async function load(path, source) {
  const data = JSON.parse(await readFile(path, 'utf8'));
  return (data.features || []).filter(item => item?.name && Array.isArray(item.point)).map((item, index) => ({
    audit_id: `${source}:${index}`, name: item.name, source: item.source || source, point: item.point, geometry_bbox: bbox(item.geometry), type: item.type || null,
  }));
}
const records = [...await load('dashboard/data/fishing-grounds-source.json', 'compiled'), ...await load('dashboard/data/fishing-grounds-md-legacy.json', 'legacy-md')];
const decisions = [];
for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) {
  const a = records[i], b = records[j]; const distance = distanceNm(a.point, b.point); const geometryOverlap = overlaps(a.geometry_bbox, b.geometry_bbox);
  if (distance > 15 && !geometryOverlap) continue;
  const similarity = bestNameScore(a, b); if (similarity < 0.35 && !geometryOverlap) continue;
  const result = decision(a, b, distance, similarity, geometryOverlap);
  decisions.push({ a: a.audit_id, b: b.audit_id, names: [a.name, b.name], sources: [a.source, b.source], distance_nm: Number(distance.toFixed(2)), name_similarity: Number(similarity.toFixed(3)), geometry_overlap: geometryOverlap, decision: result.type, reason: result.reason });
}
const current = JSON.parse(await readFile('dashboard/data/fishing-grounds.json', 'utf8'));
const counts = Object.fromEntries(['merge','keep-separate','parent/subarea','unresolved'].map(type => [type, decisions.filter(item => item.decision === type).length]));
const canonicalMapping = current.features.map(canonical => ({
  canonical_id: canonical.id,
  canonical_name: canonical.name,
  source_record_ids: records.filter(record => identityMatch(canonical, record)).map(record => record.audit_id),
}));
const mappedRecordIds = new Set(canonicalMapping.flatMap(group => group.source_record_ids));
await mkdir('reports', { recursive: true });
await writeFile('reports/fishing-ground-review-ledger.json', JSON.stringify({ version: 2, generated_at: new Date().toISOString(), policy: { source_records_are_immutable: true, every_candidate_has_decision: true, unresolved_never_auto_merged: true, canonical_catalog_records: current.features.length, display_groups_are_separate_from_source_identity: true }, source_accounting: { total: records.length, compiled: records.filter(x => x.audit_id.startsWith('compiled:')).length, legacy_md: records.filter(x => x.audit_id.startsWith('legacy-md:')).length, mapped: mappedRecordIds.size, unmapped: records.length - mappedRecordIds.size }, decisions: { total: decisions.length, counts }, display_groups: current.features.filter(feature => (feature.display_group_size || 1) > 1).map(feature => ({ display_group_id: feature.display_group_id || feature.id, canonical_name: feature.name, aliases: feature.aliases || [], related_ids: feature.related_ids || [], size: feature.display_group_size })), canonical_mapping: canonicalMapping, records: records.map(({ geometry_bbox, ...record }) => ({ ...record, geometry_bbox })), candidate_decisions: decisions }, null, 2) + '\n');
console.log(JSON.stringify({ source_records: records.length, candidate_decisions: decisions.length, counts, canonical_records: current.features.length, mapped: mappedRecordIds.size, unmapped: records.length - mappedRecordIds.size }, null, 2));
