---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add opt-in learning discovery from retained, host-scored failures. Hosts can record observations and authorize evaluator revisions; the SDK selects an eligible task against the installed guidance, then uses the existing generation, verification and fresh confirmation cycle. Task claims survive process restarts and prevent concurrent or accidental duplicate experiments. Provider errors, unresolved usage and obsolete observations are excluded from selection.

The CLI accepts discovery hosts in `resident learn` and adds `resident learning --observations` for paginated inspection. Compact output includes failure reasons and verification/confirmation pass counts so inspection does not require following raw artifact hashes. Existing explicit-failure hosts remain supported. Learning storage upgrades to schema 2 on its next write; older SDK builds restricted to schema 1 cannot reopen that upgraded database. Keep a database backup if a rollback to such a build is required.
