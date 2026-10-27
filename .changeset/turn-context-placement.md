---
'@namzu/sdk': patch
'@namzu/cli': patch
---

A turn's request-only data (repository snapshot, recalled memory, conversation evidence, file evidence) now keeps the place it first had on every later call of the turn, instead of moving from before your message to after the tool results. A caching provider keeps reading the same prefix, so the later calls of a long turn cost less. Data whose text changed is replaced, not kept beside the new text. The terminal's repository snapshot is sent on every call of the turn with the same text. The conversation-evidence block is shorter and in plain words, without internal field names, and its JSON no longer carries the scan byte count. The note that evidence is unavailable is now two plain sentences, not JSON, so it no longer carries the status, stage or reason as fields. Nothing to change in your code; a host that matches the old wording of the evidence block reads `scannedBytes` from it, or parses the availability note's fields should read the new text.
