---
type: Reference
title: Compaction circuit breaker and output limits
description: When the kernel gives up on compacting, and what it does when a reply is cut at its output limit.
resource: packages/sdk/src/compaction/context-window.ts
tags: [sdk, compaction, context, output-limit]
status: stable
generated:
  by: claude/sonnet-5.5
  at: 2026-10-19
---

# Compaction circuit breaker and output limits

These rules follow Claude Code 2.1.302, read from its code.

## The circuit breaker

`compactionConfig.circuitBreaker: true` (off unless set) adds two stops, per
turn:

- Three passes in a row that ran and shed nothing switch automatic compaction
  off for the rest of the turn. A pass the provider forces by rejecting the
  prompt is never gated. A `compaction_failed` event with `cause:
  'breaker_open'` says so once; its `error` is the line to show.
- Three compactions in a row, each followed by the context reaching the
  trigger again within three iterations, stop the turn with stop reason
  `error` and a `compaction_failed` event with `cause: 'refilling'` (sent once;
  `error` is the line to show, and it is the turn's last error). A file read
  or tool output too big for the window is the usual cause.

The reference keeps these counts across the session; here they are per turn.

## Output limits

`query({ maxOutputContinuations })` caps how many times in a row the loop
nudges the model to carry on after a reply was cut at its output limit; the
count restarts after any call that finishes on its own. Unset keeps the
earlier behaviour (nudge every time, bounded by `maxIterations`). Past the cap
the turn stops with stop reason `output_limit` and a last error naming the limit. A
cut that happens while the model is still reasoning, before any text or tool
call, gets a different nudge (think much more briefly) and counts against the
same cap. The Namzu CLI sets the cap to 3.

When a provider says the prompt fits but prompt plus the requested output cap
does not ("input length and `max_tokens` exceed context limit: A + B > C"), the
loop retries that call once with `max_tokens = C - A - 1000`. It does not retry
when that leaves under 3,000 tokens, or when the new cap is not smaller than
the one just tried.

## `compactNow` instructions

`CompactNowInput.instructions` (and `CompactSessionParams.instructions`) carries
what the person asked the summary to keep. It is added to the verifier model's
prompt, and naming it runs that step even when `llmVerification` is off.
Blank text is ignored; it is cut to 2,000 characters.
