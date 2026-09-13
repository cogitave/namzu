---
"@namzu/cli": patch
---

Stabilize goal conversation UI tests by waiting for the enabled composer before
typing commands, including after conversation replacement. Tests continue to
exercise durable goal ordering and automatic continuation without increasing
timeouts or changing CLI behavior.
