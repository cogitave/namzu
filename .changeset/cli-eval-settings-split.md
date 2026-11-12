---
'@namzu/cli': minor
---

`namzu eval` can run suites under a settings file and on one split of the tasks, and says which it did. `--settings <file>` (JSON or YAML in the shape of the config file, limited to `compaction`, `goal`, `handBack`, `limits`, `memory`, `model`, `refusalFallback`, `routing`, `smallModel` and `workflow`) names the settings in every report as a snapshot called after the file, or `--settings-name`; any other key, and any value that is or names a credential, is refused with exit 3 and nothing is written. `--split tune|held-out|all` runs one split (default `all`, as before); judge settings you chose on `tune` with `held-out`.

`namzu eval compare` now prints each side's snapshot and split and what differs between the snapshots, and names no winner when either report ran on the tune split or on all tasks, has no snapshot (reports written before this version), ran identical settings, or ran different tasks. A script or a CI step that reads a winner from a comparison of two existing reports gets `no winner is named` instead; its numbers are still printed and `--json` carries the reasons in `verdict.withheld`. Reports written by this version gain fields only; every number is unchanged.
