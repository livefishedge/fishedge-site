# Underwater structure classification — 2026-09-29

The catalog now separates display filtering from identity resolution. No source record or geometry is removed.

## Area classification

- `major_offshore`: explicit canyon, seamount, deepwater, offshore, or major-bank terminology; canyon/seamount feature types also qualify.
- `inshore`: explicit inlet, buoy, bridge, sewer, jetty, channel, shore, beach, inshore, inside, slough, harbor, or bay terminology.
- `offshore`: the regional default when neither explicit rule applies.

The rules are name/type based and expose `classification_reason`; they are not a claim of precise shoreline distance.

## Source classification

- `official`: Maryland DNR, BOEM Atlantic Fishing Atlas, or NOAA/ArcGIS US Submarine Canyons.
- `unofficial`: NJ DEP / Shore Guide reference records. The geometry may originate from an official-derived dataset, but the displayed name is not treated as independently verified agency naming.
- `mixed`: one display identity has both official and unofficial source lineage.
- `unknown`: any future source not in the explicit policy.

Current display catalog counts: 61 major offshore, 583 offshore, 110 inshore; 264 official, 463 unofficial, 27 mixed.

The dashboard exposes independent Area and Source filters under Fishing Grounds. Filtering changes display only; full polygons and source lineage remain available.
