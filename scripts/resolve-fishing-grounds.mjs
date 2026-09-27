import { readFile, writeFile } from 'node:fs/promises';
import { resolveFeatures } from './fishing-ground-identity.mjs';

const path = 'dashboard/data/fishing-grounds.json';
const source = JSON.parse(await readFile(path, 'utf8'));
const features = resolveFeatures(source.features || []);
const output = { ...source, version: 3, generated_at: new Date().toISOString(), identity_policy: 'phonetic-structural-nearby-v1', features };
await writeFile(path, JSON.stringify(output));
await writeFile('dashboard/data/fishing-grounds-points.json', JSON.stringify({
  ...output,
  features: features.map(({ geometry, ...item }) => item),
}));
console.log(JSON.stringify({ input: (source.features || []).length, output: features.length, collapsed: (source.features || []).length - features.length, aliases: features.filter(item => item.aliases?.length).map(item => ({ name: item.name, aliases: item.aliases })) }, null, 2));
