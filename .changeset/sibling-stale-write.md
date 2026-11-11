---
'@namzu/sdk': patch
---

Fixes a regression since the previous release: two sub-agents that read the same file and then both wrote it could silently replace each other's edit. Sub-agents shared their parent's whole file tracker, so the first write updated what the second agent was taken to have read and the second write was not refused as stale. A sub-agent now starts with its own read record, and the later write is refused as stale again, with the usual instruction to read the file and redo the edit. Only the record of what the agents wrote, which the approval classifier uses to read a script an agent made, stays shared by a parent and its sub-agents. Nothing to change in a host that passes a tracker from `createFileReadTracker()`; a custom `FileReadTracker` gains an optional `forChild()` and, without it, is no longer handed to a child, which then starts a tracker of its own.
