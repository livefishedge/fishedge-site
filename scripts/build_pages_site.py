#!/usr/bin/env python3
"""Build only public site assets; compute inputs never enter a Pages deploy."""
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / '.pages-dist'
EXCLUDED_ROOTS = {'data', 'scripts', 'tests', 'reports', 'docs', 'evidence',
                  'supabase', '.github'}


def main():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir()
    files = subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode().split('\0')
    count = 0
    for name in files:
        if not name:
            continue
        relative = Path(name)
        if relative.parts[0] in EXCLUDED_ROOTS:
            continue
        if any(part.startswith('.') for part in relative.parts):
            continue
        if relative.suffix in {'.npz', '.npy', '.nc', '.pyc'}:
            continue
        source = ROOT / relative
        if source.is_symlink():
            raise RuntimeError(f'Unexpected public symlink: {relative}')
        if source.stat().st_size > 25 * 1024 * 1024:
            raise RuntimeError(f'Public asset exceeds Pages file limit: {relative}')
        destination = OUT / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
        count += 1
    for required in ['index.html', '_redirects', 'dashboard/index.html',
                     'dashboard/planner/map.html',
                     'dashboard/trip-planner/data/usec_md/briefing/forecast.json',
                     'dashboard/trip-planner/data/usec_south/briefing/forecast.json']:
        if not (OUT / required).is_file():
            raise RuntimeError(f'Missing required public asset: {required}')
    if count + 1 > 20000:
        raise RuntimeError(f'Pages asset limit exceeded: {count + 1}')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    (OUT / '_deployment.json').write_text(json.dumps({'commit': commit, 'assets': count + 1}))
    print(f'Pages output: {count + 1} assets; commit {commit}')


if __name__ == '__main__':
    main()
