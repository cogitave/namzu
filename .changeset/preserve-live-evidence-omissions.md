---
"@namzu/cli": patch
---

Fix live evidence continuations incorrectly reporting an exhaustive search
after automatic recall had encountered a preview or unavailable original.
The continuation now retains omissions from the same live scan, even when its
remaining pages contain only valid records and are fully consumed.

`unavailableRuns` remains a count for the current call. A final page can have
zero new unavailable runs while `incomplete` remains true because an earlier
record was missing. Healthy scans still finish normally; a separate historical
scan's omissions do not taint the live cursor. No additional reads, model calls,
action replay or broader access are introduced.
