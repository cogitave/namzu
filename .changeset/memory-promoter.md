---
'@namzu/sdk': minor
'@namzu/cli': minor
---

A run now remembers what it worked out, instead of dropping it at settle

`promoteMemory` is invoked once when a run settles, with the compaction extractor's already-structured output — decisions, discoveries, user requirements, failures, environment facts, with eviction counts carried rather than hidden. **No shipped app supplied the hook.** So that structure, which the compaction pass spent tokens producing, was serialized into one system message and dropped on the floor when the run ended; the only way into namzu's memory store was the model deciding to call `save_memory`.

New in `@namzu/sdk`: `createMemoryPromoter({ store, tags?, maxPerCategory? }): PromoteMemory`, plus `RUN_MEMORY_TAG`. `@namzu/cli` supplies it over the very store its memory tools already use, so what a run learns is what `search_memory` finds on the next one.

**The filter is the whole decision, and it is strict.** A run that learned nothing leaves **no record at all** — not an empty one, not one whose body says "no decisions". Only the five knowledge categories count: user requirements, decisions, discoveries, failures, environment. Not `task`, which every run has because it is the prompt restated; not `files`, which every run that opened anything has and which says what was *touched* rather than what was *learned*. The model reads this store on later runs, so a record per run is not merely wasted disk — it is context spent on runs that discovered nothing.

Records are markdown, tagged `run-memory`, and carry the forming run's id in their metadata so a surprising memory can be checked against what actually happened. Eviction counts are rendered, because somebody reading the record should know they are reading a truncated account of the run.

The promoter deliberately does **not** catch its own failures: the runtime already catches and logs a promoter throw at settle without touching the answer, and catching here as well would hide a broken store from the one place that reports it.

It also does not deduplicate, merge with a previous run's record, or expire anything. Each is a policy with real trade-offs, and `promoteMemory` is a callback precisely so the runtime does not decide them — this is the obvious default, not the only possible one. Pass your own `PromoteMemory` to `query` to replace it.

Sub-agents do not promote. A parent that delegated six times would otherwise leave seven accounts of one piece of work for the next run to read; the parent's settle speaks for the whole task.
