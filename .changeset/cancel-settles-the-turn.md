---
'@namzu/sdk': patch
---

A cancelled turn records what it spent before it stopped.

Cancel re-threw from inside the chunk loop, so everything past that point
was unreachable — and everything past that point is the turn's bookkeeping.

- **Silent cost under-reporting**, the load-bearing one: the usage the
  stream had already merged was discarded wholesale, so `Run.tokenUsage`
  and `costInfo` under-reported every cancelled turn. A cancelled turn is
  not a free turn; the tokens were spent.
- The `chat {model}` span opened for the call was started and never ended,
  so it never exported at all.
- The message the turn announced never got a terminator, so a host
  consuming the message lifecycle saw a message begin and never end.
- The streamed text was absent from the run's messages and steps.

The stream-**error** path a few lines away already settled all of this.
Cancel was the one exit that skipped it, which is the opposite of what its
frequency deserves.

`MessageStopReason` gains `'cancelled'` so the terminator can be
well-formed. Settling is best-effort and never replaces the reason the turn
ended: the cancellation still propagates, so the run loop still settles as
cancelled.
