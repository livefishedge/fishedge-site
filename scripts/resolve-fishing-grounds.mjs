import { readFile, writeFile } from 'node:fs/promises';
import { resolveDisplayGroups, resolveFeatures } from './fishing-ground-identity.mjs';

const sourcePath = 'dashboard/data/fishing-grounds-source.json';
const outputPath = 'dashboard/data/fishing-grounds.json';
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const identityFeatures = resolveFeatures(source.features || []);
const features = resolveDisplayGroups(identityFeatures);
const output = { ...source, version: 7, generated_at: new Date().toISOString(), identity_policy: 'catalog-wide-component-resolver-v5-reviewed-display-groups', source_feature_count: identityFeatures.length, features };
await writeFile(outputPath, JSON.stringify(output));
await writeFile('dashboard/data/fishing-grounds-points.json', JSON.stringify({
  ...output,
  features: features.map(({ geometry, ...item }) => item),
}));
console.log(JSON.stringify({ input: (source.features || []).length, identity_records: identityFeatures.length, output: features.length, display_groups_collapsed: identityFeatures.length - features.length, aliases: features.filter(item => item.aliases?.length).map(item => ({ name: item.name, aliases: item.aliases, related_ids: item.related_ids })) }, null, 2));
