import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { identityMatch, resolveDisplayGroups, resolveFeatures, stableId } from '../scripts/fishing-ground-identity.mjs';

const source = JSON.parse(readFileSync('dashboard/data/fishing-grounds-source.json')).features;
const result = resolveDisplayGroups(resolveFeatures(source));
const names = item => [item.name, ...item.aliases];
const pairs = [
  ['Barnegat Inlet Buoy', 'BI'],
  ['Barnegat Ridge South', 'Barnegat, South End Ridge'],
  ['Barnrgat Ridge North', 'Barnegat, North End Ridge'],
  ['Rock Pile', 'Rock Piles'],
  ['HA Bouy', 'HA Buoy'],
];
for (const pair of pairs) test(`one display entry: ${pair.join(' / ')}`, () => {
  const found = result.filter(item => pair.some(name => names(item).includes(name)));
  assert.equal(found.length, 1);
  for (const name of pair) assert.ok(names(found[0]).includes(name));
});

test('all source identities and polygon parts survive exactly once', () => {
  const actual = result.flatMap(item => item.source_record_ids).sort();
  assert.deepEqual(actual, source.map(item => item.id || stableId(item)).sort());
  const parts = geometry => geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.coordinates || [];
  for (const original of source) {
    const resolved = result.find(item => item.source_record_ids.includes(original.id || stableId(original)));
    for (const part of parts(original.geometry)) {
      assert.ok(parts(resolved.geometry).some(p => JSON.stringify(p) === JSON.stringify(part)), original.name);
    }
    assert.ok(source.some(s => JSON.stringify(s.point) === JSON.stringify(resolved.point)), 'anchor must be a source point');
  }
});

test('previously grouped aliases do not split apart', () => {
  const previous = JSON.parse(readFileSync('tests/fixtures/fishing-ground-prior-groups.json'));
  for (const oldNames of previous) {
    assert.ok(result.some(current => oldNames.every(name => names(current).includes(name))), oldNames[0]);
  }
});

test('directions, numbered sites, and unrelated local abbreviations stay separate', () => {
  const point = [-74, 40];
  for (const [a, b] of [['Barnegat Ridge North', 'Barnegat Ridge South'], ['5 Buoy', '6 Buoy'], ['Site 1', 'Site 2']]) {
    assert.equal(identityMatch({ name: a, point }, { name: b, point }), false);
  }
  assert.equal(resolveDisplayGroups([{ name: 'BI', point }, { name: 'Barnegat Inlet Buoy', point }]).length, 2);
});

test('published full, point and registry catalogs agree', () => {
  const full = JSON.parse(readFileSync('dashboard/data/fishing-grounds.json')).features;
  const points = JSON.parse(readFileSync('dashboard/data/fishing-grounds-points.json')).features;
  const registry = JSON.parse(readFileSync('dashboard/data/fishing-grounds-registry.json')).records;
  assert.deepEqual(full.map(({ geometry, ...item }) => item), points);
  assert.deepEqual(points.map(item => item.id), registry.map(item => item.structure_id));
  assert.deepEqual(full, result);
});

test('every display entry has orthogonal area and source classifications', () => {
  const zones = new Set(['major_offshore', 'offshore', 'inshore']);
  const sources = new Set(['official', 'unofficial', 'mixed', 'unknown']);
  assert.ok(result.some(item => item.zone === 'major_offshore'));
  assert.ok(result.some(item => item.zone === 'inshore'));
  assert.ok(result.some(item => item.source_status === 'official'));
  assert.ok(result.some(item => item.source_status === 'unofficial'));
  for (const item of result) {
    assert.ok(zones.has(item.zone), item.name);
    assert.ok(sources.has(item.source_status), item.name);
    assert.ok(item.zone_label && item.source_status_label, item.name);
  }
});

test('planner-curated major grounds override misleading coastal words', () => {
  for (const name of ['Barnegat Ridge South', 'Barnegat Ridge North', 'Barnegat Light Reef', 'Romer Shoal', 'Mako', 'Baltimore Canyon']) {
    const item = result.find(candidate => candidate.name === name || candidate.aliases.includes(name));
    assert.ok(item, name);
    assert.equal(item.zone, 'major_offshore', name);
    assert.equal(item.classification_reason, 'Planner-curated major offshore ground', name);
  }
});
