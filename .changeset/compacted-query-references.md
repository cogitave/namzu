---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Allow automatic evidence-query resolution to use one explicitly marked compaction summary as a derived lookup reference after original turns leave visible history. The existing six-excerpt, 64-message and inference limits remain; ordinary system policy and tool text are excluded. Query-resolution basis metadata may now include `source: "compaction-summary"`. This provenance marks a derived reference, not proof of the requested fact: answers still require retained originals. Recorded CLI conversations use this through their existing recall configuration.
