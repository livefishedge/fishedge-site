import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';

const bbox = [-76.5, 35.5, -71.5, 40.5];
const old = JSON.parse(execFileSync('git', ['show', '51af6f6c0:dashboard/data/fishing-grounds.json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
const current = JSON.parse(await readFile('dashboard/data/fishing-grounds.json', 'utf8'));
const inside = item => item.point && item.point[0] >= bbox[0] && item.point[0] <= bbox[2] && item.point[1] >= bbox[1] && item.point[1] <= bbox[3];
const features = old.features.filter(inside);
await writeFile('dashboard/data/fishing-grounds-md-legacy.json', JSON.stringify({
  version: 1,
  baseline: 'pre-2026-09-18 catalog commit 51af6f6c0',
  bbox,
  features,
}, null, 2) + '\n');
console.log(JSON.stringify({ baselineRecords: features.length, currentRecords: current.features.filter(inside).length }));
