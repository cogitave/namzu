---
'@namzu/sdk': patch
---

The SDK unit test runner now uses at most four workers on machines with many CPU cores. This prevents valid asynchronous tests from hitting their wall-clock timeout under test-worker contention; package runtime behavior and APIs are unchanged.
