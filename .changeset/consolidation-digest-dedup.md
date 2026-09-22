---
"@namzu/sdk": major
---

Consolidation no longer writes the same learning twice. `consolidationEntry` now adds a `knowledge:<digest>` tag, `metadata.knowledgeDigest` and `type: 'project'`, the digest covering the turn's decisions, discoveries and failures. Before writing, the runtime calls the new `isConsolidated(store, entry)` and skips the write — and its `memory_consolidated` event — when a consolidation with that digest already exists, archived included. This is the deduplication `createMemoryPromoter` already did.

Why major: the duplicate records were a defect — search filled with copies of one learning — but a documented event and a store write that used to happen on every settled turn with `consolidateInto` now do not happen for a turn whose learnings match an earlier one. A host that counted `memory_consolidated` events or records per turn observes that as a changed default, whatever the reason for it.

What changes for a host passing `consolidateInto`: a turn whose learnings are identical to an earlier consolidation's writes no record and emits no `memory_consolidated` event. A host that expected one record per turn should look for the earlier record by its `knowledge:<digest>` tag. A host comparing `consolidationEntry(...).tags` exactly sees one more tag. There is no switch to restore a write per turn; a host that needs one writes the entry itself with `store.create(consolidationEntry(...))`.
