---
'@namzu/sdk': minor
'@namzu/cli': minor
---

Add optional exact-word constraints through `MemorySearchParams.requiredIdentifiers`
in the built-in memory stores, applied before ranking and limiting results.

SDK hosts can opt into `createMemoryRecallStep({ identifierGrounding: true })`;
CLI users can set `memory.identifierGrounding: true`. Queries containing mixed
letter/digit identifiers then require one of those identifiers in an automatically
recalled record. Explicit memory tools keep their broad search behavior.

The option defaults to false. The live comparison removed irrelevant automatic
recall but did not improve factual accuracy and used more tokens, so this is a
precision control for suitable workloads, not a promoted performance default.
Exact spelling can miss aliases or renamed identifiers.
