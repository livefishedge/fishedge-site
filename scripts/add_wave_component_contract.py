#!/usr/bin/env python3
"""Add explicit component-coverage metadata for coarse marine wave partitions."""
import json
from pathlib import Path

from cartopy.io import shapereader

ROOT = Path(__file__).resolve().parents[1]
paths = [
    ROOT / 'data/usec_md/briefing/forecast.json',
    ROOT / 'dashboard/trip-planner/data/usec_md/briefing/forecast.json',
]
reader = shapereader.Reader(shapereader.natural_earth(
    resolution='10m', category='physical', name='geography_marine_polys'))
bay = next(record.geometry for record in reader.records()
           if record.attributes.get('name') == 'Chesapeake Bay')
if bay.geom_type != 'Polygon':
    raise SystemExit('Chesapeake Bay geometry is not a simple polygon')
polygon = [[round(float(x), 6), round(float(y), 6)]
           for x, y in bay.simplify(0.002, preserve_topology=True).exterior.coords]
contract = {
    'swell': {
        'status': 'unsupported_inside_exclusion_geometry',
        'source': 'NOAA WaveWatch III via Open-Meteo Marine API',
        'reason': 'regional source resolution does not resolve Chesapeake entrance, fetch shielding, bars, or shallow-water transformation',
        'policy': 'do not display swell as transmitted through the bay; retain source values outside the exclusion geometry',
    },
    'wind_wave': {
        'status': 'source_backed_with_coast_mask',
        'source': 'NOAA WaveWatch III via Open-Meteo Marine API',
    },
    'exclusion_geometries': [{'id': 'chesapeake_bay', 'source': 'Natural Earth 10m geography_marine_polys', 'polygon_lon_lat': polygon}],
}
for path in paths:
    payload = json.loads(path.read_text())
    payload['wave_component_contract'] = contract
    path.write_text(json.dumps(payload, allow_nan=False, separators=(',', ':')))
print(json.dumps({'vertices': len(polygon), 'paths': [str(p) for p in paths]}))
