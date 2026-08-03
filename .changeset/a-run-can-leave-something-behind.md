---
'@namzu/sdk': minor
---

A finished run can leave something behind

The SDK could store a memory and could not form one. `MemoryStore` and its disk implementation have been here all along, and the only path into them was the model calling `save_memory` — so a run that worked out a durable fact and never thought to write it down lost it at settle, along with everything the compaction pass had already extracted and structured on the way.

The extraction was already built: compaction distils the transcript into decisions, discoveries, requirements and failures precisely because a list of facts is worth more than a summary of prose. That structure was serialized into one system message and then dropped when the run ended. `promoteMemory` is called once, at settle, with it.

A callback rather than a store the runtime writes into — what is worth remembering is a policy question the host owns, and a runtime that decided it would write a row for every run whether or not anything happened. It is called for a failed run too (the approach that failed is exactly what a later run should not pay for twice), it is awaited rather than fire-and-forget (a one-shot process exits as soon as the run returns), and a throw is swallowed and logged, because a memory that failed to form must not retract an answer that was already produced.
