---
'@namzu/cli': patch
---

The memory curation log (`<NAMZU_HOME>/memory/curation.jsonl`) now writes its lines one at a time, in the order they happen. Two lines written together could land in either order before.
