---
'@namzu/cli': patch
---

The CLI test runner now uses at most four workers on many-core machines. This prevents healthy session and scheduled-run tests from hitting their wall-clock timeout under heavy test contention; CLI runtime behavior and APIs are unchanged.
