---
"@namzu/cli": patch
---

Clean up application homes created by the CLI test suite after both passing and failing tests, with a run-owned parent and final runner-exit sweep for late TUI persistence. Explicitly supplied homes remain untouched, including when a test changes `NAMZU_HOME`. This prevents development and CI runs from accumulating temporary session state; installed CLI behavior is unchanged.
