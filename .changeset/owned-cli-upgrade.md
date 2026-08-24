---
'@namzu/cli': minor
---

Add `namzu upgrade` and the read-only `namzu upgrade --check`. The updater
derives the npm prefix from the package that is actually running, pins the
registry's exact version, and reads that same package root back before reporting
success; installations whose owner cannot be established are refused rather
than updating another binary on `PATH`.

The TUI's update notice now points to the real command. Finite `/permissions`
and `/effort` choosers also ignore the Return key that opened them until the
menu has committed, preventing a key repeat from applying the first choice
before the operator can see it.
