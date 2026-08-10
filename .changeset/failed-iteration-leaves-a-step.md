---
'@namzu/sdk': major
---

A failed iteration now leaves a step, so the run ledger has no hole where the failure was

`recordStep` had two call sites and both were on success paths. An iteration
that threw recorded a span exception and re-threw with nothing written down, so
a ledger was complete except on the turns that failed — which reads as "nothing
went wrong" precisely where something did, and a reader could not tell
iteration N failing from iteration N never happening.

The failing turn now gets a `StepResult` like every other turn, from the same
writer, so failures and successes sort together. It carries what the iteration
got as far as knowing: the model asked for, the tokens actually spent, the tool
calls the model made, and what went wrong.

**Three breaking changes to `StepResult`, all on the read side.**

- `finishReason` gains `'error'` and `'cancelled'`. If you `switch` on it
  exhaustively, add the two cases. `'error'` means the iteration threw and
  `failure` says why; `'cancelled'` means a Stop tore the turn down.
- `messageId` is now optional. It is absent only on a step whose iteration
  failed before the model's message was announced — a lifecycle hook that
  threw, a transport error before the first chunk. If you read it
  unconditionally, guard it. It is still present on every turn that reached the
  provider, including a stream that died part-way.
- `toolResults` may now be shorter than `toolCalls` on a step that failed: only
  outcomes that came back are recorded, because `{output: '', isError: false}`
  for a tool that never ran reads as an empty success. Pair by `toolCallId`
  rather than by index if you handle failed steps.

New: `failure?: StepFailure` — `{ message, code, status?, retryable }`,
classified the same way `run.lastProviderError` is. `code` is `'unknown'` for a
failure that was not a provider failure at all, which is the honest reading
rather than a more specific-looking guess.

Also: an iteration records at most one step. A failure landing after the step
was already recorded — in the advisory phase, or a trailing lifecycle hook —
leaves that step's own verdict alone rather than adding a second entry that
would double-count the turn against `run.tokenUsage`.
