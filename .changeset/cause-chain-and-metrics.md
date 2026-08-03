---
'@namzu/sdk': minor
'@namzu/telemetry': minor
---

Retry works on a wrapped error, and the runtime actually emits metrics.

**Every error signal is now read across the whole cause chain.** It was read
off the error handed in, so one layer of wrapping hid it — and wrapping is
the normal case, not an edge one: a vendor SDK wraps its transport error and
the runtime wraps again on the way out. A rate limit wrapped **once**
classified as `unknown`, which is treated as non-retryable, so the retry
policy was dead for every failure that was not the outermost throwable. A
socket reset two levels down was likewise unknown — the one class of failure
where retrying is almost always right.

Status, transport errno, `Retry-After`, and message text are all searched
along the chain now, outermost first, with a `seen` set so a cause cycle
(easy to build by accident when errors are re-wrapped in a retry loop)
terminates instead of hanging. Precedence is unchanged — status, then errno,
then message — and an unwrapped error classifies exactly as before.

**The runtime emitted spans and not one measurement.** Metrics lived in a
bag a host was expected to construct, and nothing in the workspace ever
constructed one. Worse, the bag bound its instruments eagerly, so one built
before `registerTelemetry()` captured the no-op meter and discarded every
write for the rest of its life — silently, forever, from a line of call
order.

- The instruments now live beside the code that records them, and the
  runtime records token usage and model latency per call, tool outcomes per
  call, and run duration per run.
- Instruments resolve **lazily** and re-resolve when a real provider is
  installed, so registration order no longer decides whether anything is
  measured.
- One token metric split by `gen_ai.token.type`, not two under two names
  with the second invented — a dashboard aggregating the conventional name
  was getting input tokens only and under-reporting usage by roughly half.
- Cache reads and writes are recorded as their own token types. They bill
  differently, so a total that hides them cannot explain a bill.
- Tool calls carry an error type, so a broken tool can be told apart from
  one whose input the model keeps getting wrong.
- `createPlatformMetrics()` still works and now delegates to the same
  instruments, so host and runtime measurements aggregate instead of
  describing the same events under two names.
