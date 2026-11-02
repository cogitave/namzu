---
"@namzu/computer-use": patch
---

A `ui_act` ref to one of several identical controls (same role and name, no id) no longer acts on a neighbour after the window changes: it answers `AMBIGUOUS_TARGET` and sends nothing, so take a new `ui_snapshot` and use the ref it gives. A window handle that another program reuses no longer adopts the old program's refs, a `query` snapshot no longer overwrites where existing refs were found, and one read creates at most 1,000 new refs. A paged outline no longer repeats nameless containers on the next page.
