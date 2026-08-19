# `captain-conditions-v1` — Normalized Conditions Contract (Dev MVP)

> Status: **Dev contract v1, not production**. Lives only on branch `feat/trip-planner-dev-mvp`.  
> Purpose: every value the briefing UI displays, regardless of source, must pass through this schema.

This contract is the single source of truth for the captain briefing. Each field carries:

- Its canonical unit (display layer may convert, never the storage layer).
- A **provenance** block: source class, source id, distance to point, model/run time, valid time, retrieved time, age, and quality flag.
- A **freshness** classification (`OBSERVATION` | `MODEL_FORECAST` | `DETERMINISTIC` | `COMPUTED_LOCAL`).

If a field cannot be filled with provenance, it MUST be `null` with an explicit `missing_reason` enum. Never default to `0`.

## Top-level request envelope

```json
{
  "request": {
    "home_inlet_id": "ocean-city-md",
    "home_inlet_label": "Ocean City Inlet, MD",
    "home_inlet_lonlat": [-75.0919, 38.3302],
    "departure_iso": "2026-08-19T04:00:00-04:00",
    "return_iso": "2026-08-19T14:00:00-04:00",
    "target_lonlat": [-74.5, 38.5],
    "transit_corridor_lonlats": [[-75.06, 38.45], [-74.85, 38.50], [-74.6, 38.50]],
    "tz": "America/New_York",
    "units": { "wind": "kt", "wave_height": "ft", "wave_period": "s", "pressure": "inHg", "temperature": "F" }
  }
}
```

## Per-segment payload (one per: inlet, transit, target, return)

```json
{
  "segment": {
    "id": "inlet" | "transit" | "target" | "return",
    "label": "Ocean City Inlet & Bar",
    "lonlat": [-75.0919, 38.3302],
    "now": {
      "wind": { "speed": 9.7, "gust": 13.0, "dir_deg": 230, "dir_cardinal": "SW",
        "freshness": "OBSERVATION",
        "source": { "provider": "NDBC", "station_id": "44009", "distance_nm": 11.2,
          "observation_time": "2026-08-18T19:50:00-04:00",
          "retrieved_time": "2026-08-18T20:01:00-04:00",
          "age_minutes": 11,
          "quality_flag": "ok" } },
      "wave": { "height": 1.6, "height_unit": "ft",
        "dominant_period": 12.0, "average_period": 6.5,
        "dir_deg": 134, "dir_cardinal": "SE",
        "freshness": "OBSERVATION",
        "source": { "provider": "NDBC", "station_id": "44084", "distance_nm": 11.6,
          "observation_time": "2026-08-18T18:26:00-04:00",
          "retrieved_time": "2026-08-18T20:01:00-04:00",
          "age_minutes": 95,
          "quality_flag": "ok" },
        "missing_reason": null },
      "pressure": { "value": 29.87, "unit": "inHg", "tendency_3h": -0.02,
        "freshness": "OBSERVATION",
        "source": { "provider": "NDBC", "station_id": "44009", "distance_nm": 11.2,
          "observation_time": "2026-08-18T19:50:00-04:00",
          "retrieved_time": "2026-08-18T20:01:00-04:00",
          "age_minutes": 11,
          "quality_flag": "ok" } },
      "air_temperature": { "value": 76.3, "unit": "F", "freshness": "OBSERVATION",
        "source": { "provider": "NDBC", "station_id": "44009", "distance_nm": 11.2,
          "observation_time": "2026-08-18T19:50:00-04:00",
          "retrieved_time": "2026-08-18T20:01:00-04:00",
          "age_minutes": 11,
          "quality_flag": "ok" } },
      "water_temperature": { "value": 76.3, "unit": "F", "freshness": "OBSERVATION",
        "source": { "provider": "NDBC", "station_id": "44084", "distance_nm": 11.6,
          "observation_time": "2026-08-18T18:26:00-04:00",
          "retrieved_time": "2026-08-18T20:01:00-04:00",
          "age_minutes": 95,
          "quality_flag": "ok" } },
      "humidity": null,
      "visibility": null,
      "precipitation": null,
      "weather_code": null,
      "tide": { "next_high_iso": "2026-08-19T00:54:00-04:00",
        "next_high_value": 3.331, "unit": "ft", "datum": "MLLW",
        "next_low_iso": "2026-08-19T07:01:00-04:00",
        "next_low_value": 0.708, "unit": "ft", "datum": "MLLW",
        "freshness": "DETERMINISTIC",
        "source": { "provider": "NOAA_CO-OPS", "station_id": "8557863",
          "issued_time": null,
          "observation_time": null,
          "valid_window_start": "2026-08-18T00:00:00-04:00",
          "valid_window_end": "2026-08-20T23:59:00-04:00",
          "retrieved_time": "2026-08-18T20:01:00-04:00",
          "age_minutes": null,
          "quality_flag": "harmonic_prediction" } },
      "current": null,
      "moon": { "phase_fraction": 0.41, "illumination": 0.34,
        "transit_iso": "2026-08-19T00:18:00-04:00", "underfoot_iso": "2026-08-19T12:18:00-04:00",
        "rise_iso": "2026-08-19T06:42:00-04:00", "set_iso": "2026-08-19T20:11:00-04:00",
        "freshness": "COMPUTED_LOCAL",
        "source": { "provider": "astronomy_engine_local",
          "observation_time": "2026-08-18T20:01:00-04:00",
          "retrieved_time": "2026-08-18T20:01:00-04:00",
          "age_minutes": 0,
          "quality_flag": "ok" } },
      "alerts": []
    },
    "trip_window": {
      "departure_iso": "2026-08-19T04:00:00-04:00",
      "return_iso": "2026-08-19T14:00:00-04:00",
      "hourly": [
        { "iso": "2026-08-19T04:00:00-04:00",
          "wind_speed": 11.0, "wind_gust": 15.0, "wind_dir_deg": 240, "wind_dir_cardinal": "WSW",
          "wave_height": 1.8, "wave_period": 11.0, "wave_dir_deg": 130, "wave_dir_cardinal": "SE",
          "pressure": 29.85, "temperature": 74.0,
          "precipitation": 0.0, "weather_code": 1,
          "freshness": "MODEL_FORECAST",
          "source": { "provider": "Open-Meteo", "model": "gfs_wave",
            "model_run_iso": "2026-08-18T18:00:00Z",
            "valid_time_iso": "2026-08-19T04:00:00-04:00",
            "retrieved_time": "2026-08-18T20:01:00-04:00",
            "age_minutes": 61,
            "quality_flag": "ok" } }
      ],
      "worst_window": { "start_iso": "2026-08-19T10:00:00-04:00",
        "end_iso": "2026-08-19T13:00:00-04:00",
        "max_wind_gust": 21.0, "max_wave_height": 3.4, "min_wave_period": 6.0,
        "dominant_dir_deg": 270 },
      "obs_vs_model_disagreement": {
        "wind_speed_delta_kt": 1.3,
        "wave_height_delta_ft": 0.2,
        "wave_dir_delta_deg": 10,
        "verdict": "agree" | "marginal" | "mismatch"
      }
    },
    "alerts": [
      { "id": "https://api.weather.gov/alerts/...", "event": "Small Craft Advisory",
        "headline": "...", "area": "ANZ455", "effective": "...", "expires": "...",
        "freshness": "PUSH_OBSERVATION", "severity": "moderate" }
    ]
  }
}
```

## Freshness classification

| Class | Meaning | UI badge | Default age ceiling |
|---|---|---|---|
| `OBSERVATION` | A measured sensor value | "Observed 11 min ago at 44009" | 90 min |
| `MODEL_FORECAST` | A model grid point valid for a future hour | "Model forecast, valid 4 AM, run 18Z" | 12 h |
| `DETERMINISTIC` | A computed prediction (harmonic tide, astronomical) | "Harmonic prediction" | n/a |
| `COMPUTED_LOCAL` | A local astronomical computation | "Computed locally" | n/a |
| `PUSH_OBSERVATION` | A push-published alert | "Active now" | 60 min |

## Missing-reason enum

```json
"missing_reason": null
| "no_nearby_observation"
| "observation_stale"
| "model_grid_unavailable"
| "provider_timeout"
| "provider_error_5xx"
| "no_supported_tide_station"
| "no_supported_current_station"
| "field_not_supported_at_source"
```

## Decision-rule envelope (separate schema, lives at `decision-engine.js`)

```json
{
  "decision": "GO" | "CAUTION" | "NO_GO" | "UNKNOWN",
  "reasons": [
    { "code": "WAVE_HEIGHT_OVER_TRIP_WINDOW_EXCEEDS_THRESHOLD",
      "field": "wave_height", "value": 3.6, "threshold": 3.0,
      "severity": "high" }
  ],
  "thresholds": {
    "wind_sustained_kt": 20.0,
    "wind_gust_kt": 25.0,
    "wave_height_ft": 3.0,
    "wave_period_min_s": 5.0,
    "visibility_nm": 1.0,
    "obs_vs_model_wave_factor": 1.5
  },
  "confidence": "high" | "medium" | "low",
  "missing_required_inputs": ["visibility", "current"],
  "data_freshness_summary": {
    "stale_segments": ["transit"],
    "no_nearby_observation_segments": ["target"]
  }
}
```

## Hard rules

1. Every `now.*` and `trip_window.hourly[*]` value MUST have `freshness` and `source.provider`. There are no exceptions.
2. `OBSERVATION` age > 90 min MUST downgrade `confidence` by one level (high → medium → low → unknown).
3. If any required safety field is `null` with `missing_reason` in `{no_nearby_observation, observation_stale, model_grid_unavailable}`, the segment `decision` becomes `UNKNOWN` — never `GO`.
4. `worst_window` MUST scan the entire departure-to-return window, not just current.
5. `obs_vs_model_disagreement.verdict == "mismatch"` on waves MUST downgrade to `CAUTION` at minimum.
6. `alerts[]` is rendered above the fold in the briefing drawer; an active marine alert with `severity in {severe, extreme}` forces the segment decision to `NO_GO`.
7. Display layer may convert units; storage layer MUST NOT.

This contract is the contract. UI, adapters, decision engine, tests, and evidence all reference it.
