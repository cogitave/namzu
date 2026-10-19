---
type: Reference
title: Compaction trigger, circuit breaker and output limits
description: When the kernel summarises, when it gives up on compacting, and what it does when a reply is cut at its output limit.
resource: packages/sdk/src/compaction/context-window.ts
tags: [sdk, compaction, context, output-limit]
status: stable
generated:
  by: claude/sonnet-5.5
  at: 2026-10-19
---

# Compaction trigger, circuit breaker and output limits

These rules follow the reference terminal agent (version 2.1.302), read from its code.

## The summary trigger

`compactionConfig.triggerThreshold` is optional. Set, it is the fraction of the
context window at which older history is summarised, exactly as written.
Absent, `resolveTriggerThreshold(undefined, windowTokens, maxOutputTokens?)`
derives it:

```text
trigger = window - min(model output cap, 20,000) - 13,000
```

so 167,000 tokens (83.5%) of a 200,000-token window and 967,000 (96.7%) of a
1,000,000-token one. The output cap is the driver's declared `maxOutputTokens`
for the model; unknown, the full 20,000 is reserved. A derived trigger never
drops below half the window (0.5): on a window under about 66,000 tokens the
two subtractions would otherwise leave nothing, and a summary on every
iteration is not a trigger. Before this the default was a flat `0.7`; pass
`triggerThreshold: 0.7` to keep it.

The `salience` strategy still starts shortening content at its soft target
(`softTarget`, default 0.5, never above the trigger) and summarises only at the
trigger. `resetThreshold` (0.4) is a diagnostic after a pass and is unchanged.

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
