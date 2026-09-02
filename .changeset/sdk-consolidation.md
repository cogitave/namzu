---
"@namzu/sdk": minor
---

Consolidation, the bridge from episodic to semantic memory. `query({ consolidateInto: memoryStore })` writes what the run learned when it ends — its decisions, discoveries and failures, and the files it changed — as one memory entry tagged `learning` (`consolidationEntry` builds it; a run that learned nothing writes nothing), and emits `memory_consolidated` with the entry's id and counts. A store that fails is logged and never fails the run. The salience scorer (`scoreMessages`, `buildGoal`, `planWorkingSet`, `planSalienceWorkingSet`) is exported for a host that wants to render or tune it.
