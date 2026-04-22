---
'@namzu/cli': patch
---

Doctor registry — preserve completed records on wall-timeout + double-fire defense (ses_013 Phase 0).

Two pre-existing bugs in `DoctorRegistry.run()` surfaced by the ses_013 codex adversarial review:

- **Wall-timeout aggregation no longer erases completed records.** Before: when the wall-clock timer won the race, every check was mapped to `inconclusive`, even ones that already finished. Fast pass + slow timeout produced 0 pass + N inconclusive. After: only checks that haven't finished by the wall-clock deadline are marked `inconclusive`; completed records are preserved verbatim. Fast pass + slow timeout now correctly produces 1 pass + (N-1) inconclusive.
- **Completion can no longer double-fire.** A check whose per-check timeout fired microseconds before/after the check itself resolved could produce duplicate records. Defended by an `if (completed.has(check.id)) return` guard inside the per-check callback. First record wins.

No public API change — bug fix only. 4 new tests pin the corrected contract; suite total 22 → 26.
