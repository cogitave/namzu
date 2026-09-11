---
"@namzu/sdk": minor
---

Add opt-in resident learning: versioned host-evidenced self-description and preference corrections, content-hash-bound guidance promotion through the existing paired harness verification gate, and rollback preserving current preferences. `ResidentHost` can expose a frozen learning snapshot via its new contextual callback when `learning: true`; existing two-argument callbacks and default hosts remain compatible. `projectResidentLearning` bounds selected guidance by characters without installing code or granting tool authority.

Add explicit terminal pursuit/message archival, immutable historical reads and paged archive events. Historical proposal/message deduplication and retired child counts survive active-slot reuse. Active state stays bounded; exact historical lookups grow with archive events and physical history compaction is not included.

Agenda schema 4 reads schemas 1–3 without invented learning or archive records; older writers refuse new records to prevent data loss. These are experimental SDK capabilities with reproducible continuity/evaluation/delivery tests, not new CLI defaults, an always-on service, or permission to contact people.
