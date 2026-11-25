---
'@namzu/cli': patch
---

Output written to a pipe is no longer cut short when a command ends: `namzu schedule history <job> --json | wc -c` now returns the whole output instead of stopping at 64 KB.
