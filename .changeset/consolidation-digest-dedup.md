---
"@namzu/sdk": minor
---

Consolidation no longer writes the same learning twice. `consolidationEntry` now adds a `knowledge:<digest>` tag, `metadata.knowledgeDigest` and `type: 'project'`, the digest covering the run's decisions, discoveries and failures. Before writing, the runtime calls the new `isConsolidated(store, entry)` and skips the write — and its `memory_consolidated` event — when a consolidation with that digest already exists, archived included. This is the deduplication `createMemoryPromoter` already did.

What changes for a host passing `consolidateInto`: a run whose learnings are identical to an earlier consolidation's writes no record and emits no `memory_consolidated` event. A host that expected one record per run should look for the earlier record by its `knowledge:<digest>` tag. A host comparing `consolidationEntry(...).tags` exactly sees one more tag.
