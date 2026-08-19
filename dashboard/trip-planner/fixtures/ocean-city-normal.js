/*!
 * Captured provider responses for fixture-driven tests.
 *
 * These snapshots are taken from the live coverage measurement run on
 * 2026-08-18 and represent a "normal" Ocean City / Indian River area
 * snapshot. Tests assert the adapter parsers normalize these correctly
 * into captain-conditions-v1 rows.
 *
 * If the upstream API schema changes, these fixtures will catch the
 * regression before it ships.
 */
(function attachFixtures(global) {
  'use strict';

  const FIXTURES = Object.freeze({
    ocean_city_normal: Object.freeze({
      captured_iso: '2026-08-18T20:01:00-04:00',
      lat: 38.3302, lon: -75.0919, // Ocean City Inlet
      ndbc_44009_recent: [
        // wind + pressure only, no waves (typical of 44009 during light air)
        '2026 08 18 22 50 330  3.0  4.0    MM    MM    MM  MM 1011.6  24.4  25.7  23.7   MM -0.6    MM',
        '2026 08 18 22 40 330  3.0  3.0    MM    MM    MM  MM 1011.8  24.4  25.7  23.7   MM   MM    MM',
      ],
      ndbc_44084_recent: [
        // waves only (44084 is wave-only; no wind/pressure)
        '2026 08 18 22 26  MM   MM   MM   0.5    12   6.5 134     MM    MM  24.6    MM   MM   MM    MM',
        '2026 08 18 21 56  MM   MM   MM   0.5     8   6.4 122     MM    MM  24.4    MM   MM   MM    MM',
      ],
      open_meteo_marine_first_row: {
        time: '2026-08-18T20:00',
        wave_height: 0.55,
        wave_direction: 130,
        wave_period: 7.4,
        wind_wave_height: 0.08,
        swell_wave_height: 0.48,
        swell_wave_period: 8.0,
        swell_wave_direction: 130,
      },
      open_meteo_weather_first_row: {
        time: '2026-08-18T20:00',
        wind_speed_10m: 9.7,
        wind_gusts_10m: 13.0,
        wind_direction_10m: 230,
        pressure_msl: 1011.7,
        relative_humidity_2m: 0.82,
        visibility: 24140,
        precipitation: 0.0,
        weather_code: 1,
      },
      coops_pred_8557863: {
        predictions: [
          { t: '2026-08-18 00:08', v: '3.694', type: 'H' },
          { t: '2026-08-18 06:16', v: '0.429', type: 'L' },
          { t: '2026-08-18 12:39', v: '4.196', type: 'H' },
          { t: '2026-08-18 19:03', v: '0.853', type: 'L' },
          { t: '2026-08-19 00:54', v: '3.331', type: 'H' },
          { t: '2026-08-19 07:01', v: '0.708', type: 'L' },
          { t: '2026-08-19 13:31', v: '4.043', type: 'H' },
          { t: '2026-08-19 19:59', v: '1.165', type: 'L' },
          { t: '2026-08-20 01:45', v: '3.046', type: 'H' },
          { t: '2026-08-20 07:50', v: '0.935', type: 'L' },
          { t: '2026-08-20 14:28', v: '3.927', type: 'H' },
          { t: '2026-08-20 20:59', v: '1.386', type: 'L' },
        ],
      },
      nws_alerts_active: {
        '@context': { '@version': '1.1' },
        type: 'FeatureCollection',
        features: [],
        title: 'Current watches, warnings, and advisories for 38.3302 N, 75.0919 W',
      },
    }),

    ocean_city_degraded: Object.freeze({
      captured_iso: '2026-08-19T03:30:00-04:00',
      lat: 38.3302, lon: -75.0919,
      ndbc_44009_recent: [
        '2026 08 19 03 20  MM   MM   MM    MM    MM    MM  MM    MM    MM    MM    MM   MM   MM    MM',
      ],
      ndbc_44084_recent: [
        '2026 08 19 03 26  MM   MM   MM    MM    MM    MM  MM     MM    MM    MM    MM   MM   MM    MM',
      ],
      open_meteo_marine_first_row: null, // simulate provider 5xx
      open_meteo_weather_first_row: {
        time: '2026-08-19T03:00',
        wind_speed_10m: 18.0,
        wind_gusts_10m: 24.0,
        wind_direction_10m: 250,
        pressure_msl: 1004.0,
        relative_humidity_2m: 0.92,
        visibility: 6000,
        precipitation: 2.3,
        weather_code: 65,
      },
      coops_pred_8557863: { predictions: [] }, // empty
      nws_alerts_active: {
        '@context': { '@version': '1.1' },
        type: 'FeatureCollection',
        features: [{
          id: 'https://api.weather.gov/alerts/.../cap',
          properties: {
            '@id': 'https://api.weather.gov/alerts/.../cap',
            event: 'Small Craft Advisory',
            headline: '...SCA IN EFFECT THROUGH LATE TONIGHT...',
            areaDesc: 'Coastal waters from Cape May NJ to Fenwick Island DE out 20 nm',
            severity: 'Moderate',
            certainty: 'Likely',
            urgency: 'Expected',
            effective: '2026-08-19T03:00:00-04:00',
            expires: '2026-08-20T06:00:00-04:00',
            senderName: 'NWS Mount Holly NJ',
            geocode: { SAME: ['034055'] },
          },
        }],
      },
    }),

    ocean_city_mismatch: Object.freeze({
      captured_iso: '2026-08-20T04:30:00-04:00',
      lat: 38.3302, lon: -75.0919,
      ndbc_44009_recent: [
        '2026 08 20 04 20 200 12.0 18.0  2.4     6   5.8 180 1000.0  24.0  24.5  22.0   MM -0.5    MM',
      ],
      ndbc_44084_recent: [
        '2026 08 20 04 26  MM   MM   MM   2.6     7   6.0 175     MM    MM  24.5    MM   MM   MM    MM',
      ],
      open_meteo_marine_first_row: {
        time: '2026-08-20T04:00',
        wave_height: 0.7,
        wave_direction: 110,
        wave_period: 9.0,
      },
      open_meteo_weather_first_row: {
        time: '2026-08-20T04:00',
        wind_speed_10m: 6.0,
        wind_gusts_10m: 8.0,
        wind_direction_10m: 240,
        pressure_msl: 1010.0,
        relative_humidity_2m: 0.7,
        visibility: 24000,
        precipitation: 0.0,
        weather_code: 1,
      },
      coops_pred_8557863: { predictions: [] },
      nws_alerts_active: { '@context': { '@version': '1.1' }, type: 'FeatureCollection', features: [] },
    }),
  });

  const api = Object.freeze({ FIXTURES });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof global !== 'undefined') global.FishEdgeTripPlannerFixtures = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
