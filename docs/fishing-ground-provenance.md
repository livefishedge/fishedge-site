# Fishing-ground catalog provenance and display policy

The current 851-record bundle is an expansion of the 832-record bundle from
commit `51af6f6c0`. The increase is primarily the later South/offshore
BOEM/canyon additions; it is not evidence that 19 newly researched grounds
were independently verified.

## Source classes

- **Maryland DNR**, **BOEM Atlantic Fishing Atlas**, and the **US Submarine
  Canyons** service retain government/service identities and are default source
  records.
- **NJ DEP / Shore Guide** records have official NJ DEP polygon geometry, but
  Shore Guide enriches sparse `NoName##` service records with display names.
  They are therefore `derived_official_geometry` and provisional as names,
  not rejected geometry.

The registry at `dashboard/data/fishing-grounds-registry.json` preserves source
class, review status, stable child IDs, family IDs, and representative child
anchors. It is an audit/display registry, not a license to delete source
geometry.

## Display policy

Keep every validated source polygon and point selectable. At regional and
medium zoom, display one family label anchored to the nearest real child of
the family centroid. At close zoom, expose child records. A display family is
not automatically a routing or forecast-sampling target.

The first explicit families are naming-pattern families such as Little Egg
East Deepwater Block and Little Egg Southeast Deepwater Block. East and
Southeast remain separate families; their 9 child polygons are retained.
Numbered, directional, block, and site children are not silently deleted.
