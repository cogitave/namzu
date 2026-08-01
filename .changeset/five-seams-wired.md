---
'@namzu/sdk': patch
---

Fix five wiring defects found by auditing the previous wave rather than
trusting it. All five had passing unit tests, because those tests
constructed the internal class directly and so proved the helper worked
while proving nothing about whether `query()` ever reached it.

- **`query({ repairToolCall })` was a no-op.** The field was spread into
  `ToolingBootstrap.init`, whose config type has no such field and whose
  `init` enumerates what it forwards. Object spread bypasses excess-property
  checking, so it type-checked and did nothing.
- **A truncated tool-input stream never reached the repairer** — the case
  the hook exists for. `executeSingle` answered `inputTruncated` with a
  generic hint and returned before repair ran. The partial buffer is now
  preserved (`ToolCall.metadata.partialArguments`) and offered to the
  repairer, because one handed an empty object has nothing to work from.
- **`{action:'retry'}` from `post_tool_use` was silently discarded.** It was
  read inside a loop bounded by the tool's `maxRetries`, which defaults to
  0, so the loop body never ran. Hook-requested retries now get their own
  bounded budget (`HOOK_RETRY_BUDGET`): the hook is host code reacting to
  one specific result, a more specific signal than the tool's blanket
  idempotency declaration.
- **A cross-process HITL resume never cleared the park.** The approved batch
  executed and the checkpoint kept `pending` with no `resolvedAt`, so an
  approval queue re-served a destructive call that had already run — the
  exact failure recording the park exists to prevent.
- **Configuring an output guardrail rewrote the run's outcome.** The branch
  called `markCompleted()` purely to materialize the produced text, so a
  cancelled run reported `completed` merely because a safety check was
  present. Reading and settling are now separate (`materializeResult`), and
  `setResult` is sticky so the later `resolveResult` cannot re-expand a
  redaction back to the raw model output.
