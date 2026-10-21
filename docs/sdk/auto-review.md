---
type: Reference
title: The auto-review classifier
description: The model behind the classify review mode — createAutoReviewClassifier, its two passes, what it is shown (never tool results), the rule lists and "$defaults", failing closed, retries, block limits and logging.
resource: packages/sdk/src/runtime/query/auto-review/classifier.ts
tags: [sdk, hitl, permissions, classifier]
status: stable
generated: { by: process:claude-code, at: 2026-10-21T00:00:00Z }
---

# The auto-review classifier

`classify` is a [review mode](review-policy.md#bypass-and-classify) in which a model, not a person, answers the question "may this call run?" for calls that `prompt` would have asked about. The review policy decides which calls are put to it. `createAutoReviewClassifier` decides what happens to one. The SDK owns the mechanism; the host supplies the provider, the model, the operator's rules and what to do when it stops being trusted.

```ts sketch
import { createAutoReviewClassifier, createReviewPolicy } from '@namzu/sdk'

const classifier = createAutoReviewClassifier({
  provider,                 // any LLMProvider
  model: 'a-strong-model',  // the session's own model is the sensible default
  rules: { environment: ['Our organisation is Acme.'], softDeny: ['$defaults', 'Anything that touches the billing service.'] },
  log,                      // a Logger; decisions are logged without any model text
  onUsage: (usage, stage) => charge(usage, stage),
})

const policy = createReviewPolicy({
  mode: 'classify',
  classifier,
  prompt,                   // who to ask for what the classifier must not decide
  registry,                 // so tools can describe their own calls
  roots: () => [cwd, ...addedDirectories],
  onClassifierLimit: ({ limit, reason }) => fallBackToPromptMode(limit, reason),
  onClassifierTranscriptTooLong: () => compactSoon(),
})
```

A host that mounts `classify` must also answer `QueryParams.reviewAllowedCalls` with `modeReviewsAllowedCalls(mode)` while in it, and pass the second argument it receives on if it wraps the policy's handler (see `ResumeContext` below).

# What it reviews

`classifier.review({ call, transcript, tools?, signal? })` takes one call and the conversation so far, and returns one of:

| Decision | Meaning |
| --- | --- |
| `{ verdict: 'allow', stage, latencyMs }` | Run it. |
| `{ verdict: 'block', cause, stage, reason, rule?, latencyMs, limitReached? }` | Do not run it. `cause` is `rule` (judged unsafe), `unavailable` (the check could not be completed), `unreadable` (the answer was not a verdict) or `aborted` (the turn was cancelled). |
| `{ verdict: 'too_long' }` | The conversation is too long to read. Nothing was judged. |

It never throws for a provider failure. A failure is a block.

# Two passes

1. **A short verdict**, at most 64 output tokens, stopping at the closing tag. It is told to answer `block` when in doubt and does not weigh the person's authority. `allow` ends the review.
2. **A reasoned pass**, at most 8192 output tokens, on `block` or on an answer it cannot read. It reasons in a `<thinking>` element, weighs the allow exceptions and what the person said, and the verdicts outside the thinking must agree: an answer that both blocks and allows has no verdict, and no verdict at this pass is a block. It names the rule and gives one plain sentence as the reason.

Both passes send the same system message (marked `cacheHint: 'cache'`, with `cacheControl: { type: 'auto' }` on the request) so a provider that caches a prefix reuses it. Each pass has a deadline (60 and 120 seconds by default), enforced by racing the provider call, so a provider that ignores the abort signal is cut off too; a pass that outlives it is retried like a transient failure. `temperature` defaults to 0.

# What it is shown

A compact transcript, one line of JSON per entry, in order:

- the person's own messages (a user-role message the kernel wrote, such as project instructions or a reminder, is left out);
- the agent's prose;
- one line per tool call, in the words the tool chose for itself. `ToolDefinition.classifierInput(input)` returns a short string; `defineTool({ classifierInput })` declares it. `bash` and `monitor` give the command, `edit` gives the path and a short change, `write` the path and size, `web_fetch` the address and what is asked of it. A tool without one is shown as its input in compact JSON.

It is never shown a tool **result**, the agent's reasoning, or any kernel-written context. A result is whatever a command printed or a page said, which is where an injected instruction would sit; a classifier that read it could be argued out of a block by the text it guards against. The classifier is told so, and that it cannot see what the agent saw. The call under review is the final entry, once (it is not repeated from the history). `<` is escaped inside every entry, so text in the conversation cannot close or open an element of the prompt around it. History entries are clipped to 2000 characters. The action under review is not clipped: a shell or monitor command, or an input shown as JSON, up to 8000 characters is sent whole, and a longer one is **blocked as `unreadable` without a question**, because a prefix of a command says nothing about the rest; the prompt also tells the model that an action marked as cut short means block. Some tools summarise on purpose, and the summary is all the classifier sees: `write` shows the path, the size and the first 300 characters of the body, `edit` the path and the first 200 characters removed and 300 added, `web_fetch` the address and 300 characters of the prompt. Nor does it see a `<file>` block inside a user message (a file pulled in with `@path`): the CLI sends those as a separate host-supplied message, and the transcript strips them from a user message as a second guard. It never sees a tool result.

The transcript comes from `ResumeContext.transcript()`, the second argument every `ResumeHandler` now receives, with `signal`. It is in memory only: the review request that is written to the session log when a decision is slow does not carry it.

# The rules

The built-in lists are `DEFAULT_AUTO_REVIEW_HARD_DENY`, `DEFAULT_AUTO_REVIEW_SOFT_DENY` and `DEFAULT_AUTO_REVIEW_ALLOW`, written for this kernel.

- **Hard** blocks are harms the person's consent does not clear: sending secrets out, disabling security controls, acting against third parties, destroying data outside the project that was not asked about.
- **Soft** blocks (force pushes, deleting outside the project, production changes, publishing, credential use, sending local data out, system configuration, system packages, running downloaded code, persistence, permission grants, bypassing review, infrastructure destruction, self-modification, real-world transactions, and the like) are cleared only when the person's own messages name both the action and its risky detail, or the person clearly said yes to the agent's plain proposal. A general instruction does not clear one; silence does not.
- **Allow** exceptions are ordinary work that is not to be blocked even where a soft rule's wording could be stretched to cover it: local build, test and lint; project-local file changes; reads; declared dependencies; local git and pushing to the branch the work came from; scratch files in the temp directory; a dev server the task started.
- The **environment** list says what is trusted here. It has no defaults.

`rules: { allow, softDeny, hardDeny, environment }` (`AutoReviewRules`) adds to or replaces them. A list left out keeps the built-ins. A list that is given replaces them, and the entry `"$defaults"` stands for the built-ins at that position, so `["$defaults", "my rule"]` adds one and `[]` removes the built-ins for that list. `resolveAutoReviewRules` returns the merged lists. The default stance, whatever the lists say, is to allow.

# Failing closed

Every path from "could not check" leads to a block:

- a provider error, or one that is not a provider error at all, blocks (`cause: 'unavailable'`);
- a retryable error (rate limit, overload, server error, timeout, network, or a pass past its deadline) is retried at most twice, waiting 2 s then 4 s (up to 10 s) with a quarter of jitter. `sleep`, `random` and `now` are injectable so a test never waits;
- an action longer than the 8000 characters it can read blocks (`cause: 'unreadable'`) without a provider call;
- a first answer that cannot be read goes to the second pass; a second that cannot be read, or that both blocks and allows, blocks (`cause: 'unreadable'`);
- a second pass that fails blocks on the strength of the first;
- a cancelled turn blocks (`cause: 'aborted'`) and is not counted.

A conversation over `maxTranscriptChars` (default 400,000), or a provider that says the request is too long, gives `too_long`. The review policy then blocks the call once, tells the model to try again, and calls `onClassifierTranscriptTooLong` so the host can compact. If it is still too long next time, a person decides, or an unattended turn ends.

# What the model is told

A block reaches the model as a refused tool result:

> Blocked by auto mode: *reason*. Do not try to work around this; if the action is needed, tell the user what you want to do and why, so they can approve it or switch modes.

(`autoReviewBlockedFeedback(reason)`.) A call the classifier blocks also refuses the rest of its batch, as every policy refusal does.

# Block limits

The classifier counts blocks (`classifier.denials`): three in a row, or twenty over the session (`limits`). The block that brings a counter to its limit carries `limitReached: 'consecutive' | 'total'`, and both counters start over. The review policy calls `onClassifierLimit` and then asks a person about that call; with nobody to ask it ends the turn with an `abort` decision naming the reason. The SDK does not change the mode: the host owns the mode and how it is shown, so falling back to `prompt` is its callback's job. `reset()` zeroes the counters, for a host that re-enters `classify`.

# What is logged

One `info` record per review, named `auto review decision`, with `gen_ai.tool.name`, `namzu.auto_review.verdict`, `.stage`, `.latency_ms`, and for a block `.cause` and `.limit_reached`. The reason, the rule and the transcript never reach a log. `onUsage(usage, stage)` reports what each pass cost so a host can charge it to the session.

# Instructions, in outline

The system message has these sections, in order: Role; What can go wrong; What you are shown; Default stance; The person's authority; Reading an action; Environment; Hard blocks; Soft blocks; Allow exceptions; How to decide; Answer format. The answer is a `<verdict>` element (`block` or `allow`) with, for a block, `<rule>` and `<reason>`.
