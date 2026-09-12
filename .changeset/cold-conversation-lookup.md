---
"@namzu/cli": patch
---

Recover a retained conversation passage after restart without spending a model
turn on every empty index page. Each read now advances through at most eight
lookup pages within its existing 8 MiB allowance, checking source ownership and
integrity before each operation. A continuation still returns when the work or
byte allowance requires another call. Durable addresses, exact text, read offsets
and cancellation behavior are unchanged.
