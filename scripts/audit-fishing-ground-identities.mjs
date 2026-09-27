import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DESCRIPTORS = new Set(['canyon','valley','ridge','lump','lumps','rock','rocks','reef','reefs','bank','banks','shoal','shoals','hole','holes','ground','grounds','bed','beds']);
const SYNONYMS = { inside:'inside', inner:'inside', inshore:'inside', outside:'outside', outer:'outside' };
const compact = value => String(value || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '');
const tokens = value => compact(value).split(/(?=[0-9])/).filter(Boolean);
const variants = value => String(value || '').split(/\s+or\s+|\s*\/\s*/i).map(s => s.trim()).filter(Boolean);
const core = value => String(value || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').split(' ').map(s => SYNONYMS[s] || s).filter(s => s && !DESCRIPTORS.has(s));
function editSimilarity(a, b) {
  const aa = compact(a), bb = compact(b); if (!aa || !bb) return 0;
  const row = Array.from({ length: bb.length + 1 }, (_, i) => i);
  for (let i = 1; i <= aa.length; i++) { let prev = row[0]; row[0] = i; for (let j = 1; j <= bb.length; j++) { const old = row[j]; row[j] = aa[i-1] === bb[j-1] ? prev : 1 + Math.min(prev, row[j], row[j-1]); prev = old; } }
  return 1 - row[bb.length] / Math.max(aa.length, bb.length);
}
function distanceNm(a, b) { const dx = (a[0]-b[0]) * Math.cos((a[1]+b[1]) * Math.PI / 360); const dy = a[1]-b[1]; return Math.hypot(dx,dy) * 60; }
function score(a, b) {
  const av = variants(a.name), bv = variants(b.name); let best = 0; let reason = 'nearby-name';
  for (const left of av) for (const right of bv) {
    const lc = core(left).join(''), rc = core(right).join('');
    const s = lc === rc ? 1 : editSimilarity(lc, rc);
    if (s > best) { best = s; reason = lc === rc ? 'same-identity-core' : 'phonetic/spelling-candidate'; }
  }
  return { similarity: best, reason };
}
const load = async (path, source) => { const d = JSON.parse(await readFile(path, 'utf8')); return (d.features || []).map((item, index) => ({ ...item, audit_id: `${source}:${index}`, audit_source: source })); };
const records = [...await load('dashboard/data/fishing-grounds.json', 'compiled'), ...await load('dashboard/data/fishing-grounds-md-legacy.json', 'legacy-md')];
const candidates = [];
let exactDuplicateCount = 0;
for (let i = 0; i < records.length; i++) for (let j = i + 1; j < records.length; j++) {
  const a = records[i], b = records[j]; if (!Array.isArray(a.point) || !Array.isArray(b.point)) continue;
  const nm = distanceNm(a.point, b.point); if (nm > 15) continue;
  if (nm < 0.01 && compact(a.name) === compact(b.name)) { exactDuplicateCount++; continue; }
  const match = score(a, b); if (match.similarity < 0.48) continue;
  candidates.push({ distance_nm: Number(nm.toFixed(2)), similarity: Number(match.similarity.toFixed(3)), confidence: match.similarity >= .85 ? 'high' : match.similarity >= .65 ? 'review' : 'low', reason: match.reason, a: { audit_id:a.audit_id, name:a.name, source:a.source, point:a.point }, b: { audit_id:b.audit_id, name:b.name, source:b.source, point:b.point } });
}
candidates.sort((a,b) => b.similarity - a.similarity || a.distance_nm - b.distance_nm);
await mkdir('reports', { recursive: true });
await writeFile('reports/fishing-ground-identity-audit.json', JSON.stringify({ version:1, generated_at:new Date().toISOString(), input_records:records.length, exact_duplicate_count:exactDuplicateCount, candidate_count:candidates.length, candidates }, null, 2) + '\n');
console.log(JSON.stringify({ input_records:records.length, exact_duplicate_count:exactDuplicateCount, candidate_count:candidates.length, high:candidates.filter(x=>x.confidence==='high').length, review:candidates.filter(x=>x.confidence==='review').length, low:candidates.filter(x=>x.confidence==='low').length, top:candidates.slice(0,20).map(x=>[x.a.name,x.b.name,x.distance_nm,x.similarity]) }, null, 2));
