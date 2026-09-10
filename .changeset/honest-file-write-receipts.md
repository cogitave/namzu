---
"@namzu/sdk": minor
"@namzu/cli": patch
---

Add observed write receipts with operation, UTF-8 byte count, SHA-256 and changed-region preview. Diff presentation accepts an optional summary label. Completed tool events carry bounded diff presentation so hosts do not have to reconstruct it from text. Existing write input, character-size metadata and permission defaults remain unchanged.

CLI write approvals describe a possible full replacement instead of implying creation; completed writes display the observed operation and diff. Final newline terminators no longer add a phantom line, and real blank lines remain visible. Backends with unknown prior state report Wrote rather than Created.
