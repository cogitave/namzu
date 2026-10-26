---
type: Reference
title: Compaction trigger, overflow recovery, circuit breaker and output limits
description: When the kernel summarises, how it recovers from a context overflow, when it gives up on compacting, and what it does when a reply is cut at its output limit.
resource: packages/sdk/src/compaction/context-window.ts
tags: [sdk, compaction, context, output-limit]
status: stable
generated:
  by: claude/sonnet-5.5
  at: 2026-10-19
---

# Compaction trigger, overflow recovery, circuit breaker and output limits

## Where the window goes

`analyzeContextUsage(input)` splits a window into categories for a host that
draws "where did my context go": System prompt, System tools, MCP tools, MCP
server instructions, Custom agents, Memory files, Skills and Messages (in that
order, empty ones left out), then the compaction buffer and Free space. The
host passes the size of each fixed part and `contextTokens`, the whole prompt
as the provider counted it or as estimated; Messages is that figure minus the
fixed parts, clamped to the room left, so the categories add up to the window.
Without `contextTokens` it is estimated from `messages`. `totalTokens` can
exceed the window, and `overflowTokens` says by how much.

The buffer is `min(maxOutputTokens, 20,000) + 13,000` (the same two figures as
the trigger above) and is drawn only when `windowSource` is not `auto`, that is
when the window was configured or assumed. With `autoCompact` off the buffer is 3,000 tokens and named `Compact buffer`; a host draws it as an ordinary legend line while still marking its squares as buffer. `messageBreakdown` sizes tool calls and tool results by tool name,
matching each result to its call by id. `describeToolCatalogTokens(tools)` sizes
a rendered tool catalogue tool by tool, and `estimateTextTokens(text)` is the
characters-per-token estimate for a string.

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

## Recovering from a context overflow

When the provider rejects a prompt as too long, the loop recovers on its own,
in at most two reactive compactions per stuck point (the count restarts after a
call that goes through):

1. **First relief.** A forced compaction pass: the configured recent window
   stays verbatim, stale tool results are cleared, the older history becomes a
   summary. A pass that sheds under 500 estimated tokens and under 2% of the
   prompt counts as no relief.
2. **Deeper pass.** If the first relief shed too little, or the retry
   overflowed again, one more pass runs with two changes. Tool results are
   cleared even inside the recent window (the same placeholder, head, tail and
   spill pointer a stale result gets, so a huge file read or command output
   that sits in the newest messages no longer blocks relief), and, when at
   least three round-groups remain, only the newest round-group is kept
   verbatim. A round-group is an assistant message and everything up to the
   next one, so a tool result stays with its call.

The overflow is recognised from the provider's wording as well as its code:
"prompt is too long", "input is too long for requested model", a sentence that
says the request is larger than, exceeds or is too long for the "context
window", and "input length and `max_tokens` exceed context limit" all count
(the last one first tries a smaller `max_tokens`, below). The two newer
wordings are only believed on a 400, a 413 or a failure with no status: a 429,
5xx or 401 that mentions the window stays a rate limit, a server fault or an
auth failure, and a 400 that merely names the window (an unsupported parameter
with the "1M context window beta") stays an invalid request.

The summary call, when `llmVerification` or `/compact` instructions use one, has
its own ladder: an overflow of its request is retried with the older half of
the excerpt dropped behind "[earlier conversation truncated for compaction
retry]", at most three times, and then the extracted state stands alone. A
failed summary call of any other kind no longer replaces the overflow as the
turn's error: the pass carries on with the extracted state, which the model
step only adds to. Only `compactNow` and `/compact`, which the person asked for,
still raise it.

When both rungs are spent the turn ends with the provider's overflow error,
settled exactly as before. If compaction itself errored along the way, the
error's message ends in ` · automatic compaction failed: <cause>` (at most 300
characters of the cause). The conversation is kept; nothing here asks the
person to start a new one.

The summary is the extracted working
state, so there is no media-stripping retry (the verifier excerpt carries text
and attachment captions only), and the token-gap-guided growth step becomes the
halving of the excerpt. An oversized user message or attachment has no clearing
mechanism and stays: only tool results are cleared.

## The circuit breaker

`compactionConfig.circuitBreaker: true` (off unless set) adds two stops, per
turn:

- Three passes in a row that ran and shed nothing switch off *proactive*
  compaction for the rest of the turn. It is silent for the person, as in the
  reference: a log line and one `compaction_failed` event with `cause:
  'breaker_open'`, which carries no `error`. A pass the provider forces by
  rejecting the prompt is never gated, so the recovery above still runs.
- Three compactions in a row, each followed by the context reaching the
  trigger again within three iterations, stop the turn. A relief of a context
  overflow counts as a compaction, including one that only cleared tool
  results, and the check runs before the first relief of each overflow (the
  deeper rung of the same overflow is not counted again). A tool that fills the window on every call is stopped on the third
  overflow, not after the cleared placeholders fill the window. The turn stops with stop reason
  `error` and a `compaction_failed` event with `cause: 'refilling'` (sent once;
  `error` is the line to show, and it is the turn's last error). The line names
  the cause (a file being read or a tool output too large for the window) and
  suggests reading it in smaller parts; it never suggests starting over.

Here the counts are per turn, not kept across the session.

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

## What the summary keeps

The summary is all the next step has, so it keeps what is still open and the
exact values that step needs. Alongside the sections it already had, it ends
with `## Open Items and Next Step`: the assistant notes that say what is still
to do ("I will implement the loader next in src/loader.ts and then add tests"),
filed apart from the narration so the next step is the last thing read. The
newest operator request is marked `Latest request:` inside the existing
`## User Requirements` list rather than repeated. Unresolved errors stay in
`## Errors & Failures` with their exact text, and a note that only says the
code was looked at is dropped. The summary check asks the verifier model for
unresolved errors, bugs and open questions, open items and the next step, and
the specific names, values and commands that step needs, and to list everything
missing, because trimming can happen later and a gap cannot be recovered.

## `compactNow` instructions

`CompactNowInput.instructions` (and `CompactSessionParams.instructions`) carries
what the person asked the summary to keep. It is added to the verifier model's
prompt, and naming it runs that step even when `llmVerification` is off.
Blank text is ignored; it is cut to 2,000 characters.
