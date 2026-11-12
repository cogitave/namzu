---
'@namzu/sdk': minor
---

A comparison of two eval reports no longer names a winner for settings that no suite read. `ReportSettings` gains `readKeys` (the settings a suite asked for through `evalSetting` or `currentEvalSettings`, `*` for the whole object), `EvalComparison.settings` gains `unreadKeys` and `anyDifferenceRead`, and `WithheldReason` gains `settings-not-read`, given when the snapshots differ and no shared suite read a key that differs. A script that matched on the exhaustive list of reasons needs one more case; a comparison that used to name a winner between settings the suites ignored now says `no winner is named`. A password written into a URL is now refused in a settings snapshot, as a key is. When a report records a task split, the suite's own "no held-out cases" line says it is the suite's declaration, not the hashed split.
