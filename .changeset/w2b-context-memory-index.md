---
'@namzu/cli': patch
---

The curated memory files (`USER.md`, `MEMORY.md`) and the stored-memory index are now sent to the model as one hidden reminder, in full the first time and afterwards only the part that changed, instead of being added to every request after the history. Each request now begins with the earlier ones, so the provider can cache the memory. Nothing to change to keep working; resident sessions still send the memory with each request.
