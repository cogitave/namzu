---
'@namzu/sdk': patch
---

A span closes however its work leaves.

Two sites had the same shape: `end()` called at every exit the author could see. The iteration loop had seventeen of them; the tool executor had three early returns plus a `finally` that opened below them. That makes span closure a rule every future edit has to remember, and it was already broken in both places.

In the iteration loop, the span was created and then four statements ran before the `try` — attaching the tool parent span, stamping attributes, emitting `iteration_started`, draining pending events. A throw from any of those left the span open. The loop body is also an async generator, so a consumer that abandons it reached no exit at all.

In the tool executor, `getOrThrow(toolName)` sat outside the `try` that owned the `finally`. The path where a model invents a tool name — the most likely way that throw happens — opened a span and never closed it.

An iteration span that never ends is a trace that never closes, so the export is incomplete for exactly the run that failed and is hardest to debug from the outside.

Both now end in a single `finally`. No status or exception recording moved; only the moment of closing.
