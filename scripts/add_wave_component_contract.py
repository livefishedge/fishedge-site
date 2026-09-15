#!/usr/bin/env python3
"""Add explicit component-coverage metadata for coarse marine wave partitions."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
paths = [
    ROOT / 'data/usec_md/briefing/forecast.json',
    ROOT / 'dashboard/trip-planner/data/usec_md/briefing/forecast.json',
]
contract = {
    'swell': {
        'status': 'regional_context_only_unless_open_water_supported',
        'source': 'Open-Meteo Marine API; model selection is not exposed in the response',
        'reason': 'the source grid is regional/coarse and does not resolve local entrance shielding, bars, fetch, or shallow-water transformation',
        'policy': 'animate/fill swell only where the native water footprint is connected to open boundary water; otherwise label it unresolved',
    },
    'wind_wave': {
        'status': 'regional_source_with_partial_water_anchors',
        'source': 'Open-Meteo Marine API; model selection is not exposed in the response',
        'policy': 'partial wet cells may show source-backed wind-wave context, but this is not a validated local fetch model',
    },
    'support_geometry': {
        'source': 'native mesh wet triangles plus detailed land geometry',
        'open_water_rule': 'wet raster pixels connected to the domain boundary through water',
        'limitations': 'connectivity does not model refraction, diffraction, shoaling, breaking, or attenuation through an entrance',
    },
}
for path in paths:
    payload = json.loads(path.read_text())
    payload['wave_component_contract'] = contract
    path.write_text(json.dumps(payload, allow_nan=False, separators=(',', ':')))
print(json.dumps({'paths': [str(p) for p in paths]}))
