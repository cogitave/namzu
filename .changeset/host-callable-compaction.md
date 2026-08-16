---
'@namzu/sdk': minor
---

`compactNow` and `compactRegion` let a host ask for compaction instead of
only having it happen.

`runCompactionCheck` was the only entry point in the kernel and it was
exported from nowhere — not from the compaction barrel and not from the
package root. So every compaction had to wait for the in-loop threshold or
for a provider to reject an overlong prompt: a host could not offer
"compact this conversation", could not shrink an idle session sitting
between turns, and could not collapse a span it had chosen.

Both are built on the compaction planner rather than a second copy of the
boundary arithmetic, and neither touches a run.

`compactNow` returns `null` when there is nothing to shed rather than a
zero-shed result — a caller has to be able to tell "I compacted and it did
nothing" from "I compacted", and an outcome reporting zero is the shape
that gets logged as a successful pass and shown to a user as work done.
Neither function edits the array it was given; there is no run here and the
history belongs to the host.

`compactRegion` refuses a span whose edge splits a `tool_use`/`tool_result`
pair, naming the offending index, rather than snapping it to the nearest
safe one. The caller picked those indices from something they were looking
at, and a repaired span produces a valid history that summarised the wrong
messages with nothing to notice.

`COMPACTION_HEADER` and `isCompactionMessage` move to `compaction/summary.ts`
so the module below can reach them; the previous import path still works.
