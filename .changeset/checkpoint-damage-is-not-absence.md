---
'@namzu/sdk': patch
---

A damaged checkpoint is refused instead of skipped.

A checkpoint file is the **only** durable record of a park — there is no
separate approval store. So an unreadable one that gets logged and skipped
does not merely lose a resume point: `findPendingCheckpoint` reports "not
parked" and drops an approval a human already granted.

`listCheckpoints` wrapped every per-file read in a `catch` that warned and
continued, returning a silently short list that four callers treat as
complete:

- `'latest'` resolution and `newest()` quietly resume from an **older**
  checkpoint, so the run re-executes a full iteration of tool calls;
- `findPendingCheckpoint` loses the park, as above;
- `prune` under-deletes, because a file the keep-count cannot see is
  immortal.

The only signal was a `log.warn` on a line nobody watches — and the by-id
read next door was already strict. Two read paths disagreeing about whether
damage matters is how the lenient one gets trusted.

Both paths now refuse. Both also **check** the parsed shape rather than
casting it: `JSON.parse(content) as IterationCheckpoint` let `{}` through
and failed much later at the point of use, where the message names a
missing property rather than a damaged file.

Absent stays distinguishable from damaged: no checkpoints still returns an
empty list, and an unknown id still returns `null`.
