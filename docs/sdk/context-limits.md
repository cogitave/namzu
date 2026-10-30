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

`compactionConfig.autoCompactWindowTokens` optionally sets a smaller window for
automatic summaries, capped to the actual model window. The output reserve and
buffer are taken from that smaller window; an explicit `triggerThreshold`
fraction is applied to it too. The actual model context size and provider
capabilities remain unchanged. For a 1,048,576-token model with a 786,432-token
automatic-summary window and at least 20,000 output tokens, the derived summary
trigger is 753,432 tokens. Salience eviction may still begin earlier at its
soft target. Omitting the setting preserves the existing trigger.

`resolveTriggerThreshold` accepts the optional window as its fourth argument.

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
- Three compactions in a row, each followed by a full refill within three
  iterations, stop the turn. A full refill means the estimated history size
  has returned to at least its size before the previous compaction, and that
  compaction actually reduced it. The before, after and next-check sizes use
  the same history estimator, not a mixture of provider usage and estimates.
  For this refill check, runtime-provenance reminders and recorded context
  entries are excluded: compaction may shed them and the host may announce
  them again on the next request. They still count toward the request budget
  and compaction trigger. Operator messages and tool output count toward
  refills even if their text looks like a host note.
  A useful but insufficient reduction that leaves the context above the
  trigger is not itself a refill; neither is growth smaller than the space
  just shed. A relief of a context
  overflow counts as a compaction, including one that only cleared tool
  results, and the check runs before the first relief of each overflow (the
  deeper rung of the same overflow is not counted again). A tool that fills the window on every call is stopped on its third
  refill (the fourth overflow, including the initial one), not after the cleared placeholders fill the window. The turn stops with stop reason
  `error` and a `compaction_failed` event with `cause: 'refilling'` (sent once;
  `error` is the line to show, and it is the turn's last error). Small outputs
  can also refill the window when compaction frees little space. The line
  suggests checking the configured model window and limiting tool output or
  reading files in smaller parts; it does not diagnose a large file from the
  refill count alone and never suggests starting over. A family-name lookup
  for a custom gateway model is a fallback, not verified provider capacity.

Here the counts are per turn, not kept across the session.

## Output limits

Bounded model-output previews and tool presentation windows own their short
strings. Retaining a preview therefore does not keep a much larger source
string alive through a shared slice. This preserves UTF-16 text and existing
character/byte limits; it does not bound an entire turn's heap or change the
full outputs available through retained-output recovery.

`query({ maxOutputContinuations })` caps how many times in a row the loop
nudges the model to carry on after a reply was cut at its output limit; the
count restarts after any call that finishes on its own. Unset keeps the
earlier behaviour (nudge every time, bounded by `maxIterations`). Past the cap
the turn stops with stop reason `output_limit` and a last error naming the limit. A
cut that happens while the model is still reasoning, before any text or tool
call, gets a different nudge (think much more briefly) and counts against the
same cap. An empty cutoff with no exposed reasoning also receives that bounded
nudge when the host supplies a nonnegative safe-integer cap, including `0` to
stop immediately. An embedding that omits the cap retains the earlier empty
completion fallback. The Namzu CLI sets the cap to 3.

When the runtime collects a closing response after an empty completion, it
publishes the collected answer as `text_delta` events between `message_started`
and `message_completed`, using that response's durable message id. Streaming
hosts can display the closing answer without reconstructing it from completion
metadata; text-part ids and phases are retained when supplied.

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
newest operator request is restated under `## Current Goal` (left out when
nothing newer was asked or it only repeats the task), just before the open items, so the goal is in view
after a compaction. `## Files` gives one line per file, the path then what was
done to it ("read; changed"), and any additions from the summary check come
under `## Missing Details`. Unresolved errors stay in
`## Errors & Failures` with their exact text, and a note that only says the
code was looked at is dropped. The summary check asks the verifier model for
unresolved errors, bugs and open questions, open items and the next step, and
the specific names, values and commands that step needs, and to list everything
missing, because trimming can happen later and a gap cannot be recovered.

## A summary written by a model

A host can name the model that writes the summary: `QueryParams.compactionSummaryRoute`
(and `AgentConfig.compactionSummaryRoute`) for the passes inside a turn, `summaryRoute` on
`compactNow`, `compactRegion`, `compactSession` and `compactSessionRange` for host-triggered
ones. It is a function that resolves `{ provider, model, providerId? }`, or nothing, asked once
per pass. A host that passes none sees no change.

With a route, the model reads the span being replaced and writes the summary in eight sections:
the person's requests quoted in their own words (limits they set kept exactly), the current work,
the next step with a quote of the latest request, decisions and why, files, errors and open
problems, pending tasks and the exact details the next step needs. What it reads is rendered text,
not the raw messages: each message is labelled as the person's, the assistant's or a runtime note;
a tool result is cut to `modelSummaryToolResultChars` (default 1,500 characters, the start and the
end kept); and the whole transcript is held to `modelSummaryInputChars` (default 240,000), keeping
the first request and the newest entries behind a marked gap. The transcript, any earlier summary
this one replaces (its restored files left off) and the extracted notes go in tagged blocks closed
by a per-request marker, and the request asks for no tools and a reply of at most
`modelSummaryMaxTokens` (default 4,096). What `compactNow` was asked to keep goes in the same kind
of block as for the verifier. A request that overflows the model's window is retried with half the
transcript, up to three times. The whole call is also held to `modelSummaryTimeoutMs` (default
120,000 ms) from request to last chunk, so a model that streams slowly but steadily cannot hold the
pass; past it the extracted summary is used. Text from a tool, the assistant or an attachment that
has a line starting with `[` has a backslash put before it, so a line such as `[person]: ...` inside
a tool result cannot pass for the start of a request, and the prompt says only a label at the start
of an entry counts.

The extracted notes stay the fallback. With no route, a route that resolves nothing,
`modelSummary: false`, a call that fails, stalls (the shared stream idle bound applies) or runs past its total limit, or a
reply with no `<summary>` in it, the summary is built from the extracted state exactly as before,
with its verifier step where `llmVerification` or instructions call for it. The verifier does not
run on top of a model-written summary. A cancellation is passed on, never swallowed.

Cost: an automatic pass charges the call to the turn at the route's provider and model (the
turn's own provider when the route names none); a host-triggered pass returns the tokens in
`CompactionResult.usage` for the host to count. The files and skills a pass restores follow the
summary either way.

## What a pass puts back

Verbatim text the summary cannot carry is restored after it, under `## Restored after compaction`: the skills the conversation loaded (the `skill` tool's body, every page of it) and the files it read (the `read` tool's text), recorded as the calls finish in `WorkingState.restorable` and carried in the working-state snapshot. At most 8 skills at 5,000 tokens each (25,000 together) and 5 files at 5,000 tokens each (50,000 together), newest first, and no more than 5% (skills) and 10% (files) of the window. Instruction files and plan files (`plans/plan.md`) are skipped, a file written or edited after it was read is forgotten, and a failed call records nothing. A host adds a line of its own through `QueryParams.postCompactionContext` (asked once per pass; an error leaves it out) or, for a host-triggered pass, `CompactNowInput.restoreNote`; the CLI uses it for the plan. `compactNow` and `compactRegion` restore the same bodies from the span they summarise.

## `compactNow` instructions

`CompactNowInput.instructions` (and `CompactSessionParams.instructions`) carries
what the person asked the summary to keep. It is added to the verifier model's
prompt, and naming it runs that step even when `llmVerification` is off.
The text sits in a labelled block closed only by a per-request marker
(`<namzu-operator-request-<marker>>`), after a line that says it is the
operator's request, to count as important information and to read as a
description of what to keep, not a command to the verifier.
Blank text is ignored; it is cut to 2,000 characters.
