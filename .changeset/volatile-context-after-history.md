---
'@namzu/sdk': major
---

Working memory leaves the system messages of every model request, a new
`PromptPlacement` value `'context'`, and closing requests end with their
closing directive.

**What breaks.**

- **The working-memory slot is no longer a system message in a request.** The
  slot (pins, and a `workingMemoryProvider`'s block) keeps its place in the
  run's history, checkpoints and compaction: the last leading system message.
  Every request now takes it out of the system messages and sends it after the
  history as a user-role message with source
  `{ type: 'runtime-context', kind: 'step-context' }`. It is therefore missing
  from the system messages every provider receives, from the
  `request_envelope` event's `systemPrompt`, and from the system messages a
  `pre_llm_call` hook sees. There is no option to keep the old placement. The
  message's first line is the label every step-context message carries,
  `Current step context (runtime-generated; not a new user request):`, and the
  slot follows verbatim, so the content no longer *starts* with
  `WORKING_MEMORY_HEADER` and `isWorkingMemoryMessage(content)` answers `false`
  for it.
- **`PromptPlacement` gains `'context'`.** The union is also an output type:
  `PromptContribution.placement` and `PromptContributionRegistry.list()` can
  now hand back `'context'`, so a `switch` over it with an exhaustiveness
  check stops compiling.
- **The closing directive is last.** On the forced-final step at a resource
  limit and on the request after an empty completion, the
  `[SYSTEM] ...` message of kind `limit-finalization` now comes after every
  request-only context message (working memory, `context` contributions,
  step context, derived work context) instead of before some of them.

**What to do.**

- A host that finds the slot in a captured request by looking for a system
  message starting with `WORKING_MEMORY_HEADER` looks instead for a
  `step-context` message, drops its first line, and tests the rest with
  `isWorkingMemoryMessage`. A host that rewrites or strips the slot in a
  `pre_llm_call` hook does the same. Code reading the run's history or a
  checkpoint needs no change.
- Code that switches over `PromptPlacement` adds a `'context'` case.
- A test asserting the closing directive's position expects it last.

**Why, and what is new.** A driver may hoist every system message ahead of the
conversation (Anthropic renders tools, then system, then messages), so a slot
that changes whenever a pin does invalidated the cached conversation prefix and
re-read the whole history at full price. After the history, a caching driver
ends its breakpoint before it and a pin costs only its own tokens. A
`PromptContribution` registered with `placement: 'context'` is rendered before
every model request, with `iteration`, exactly as `turn` is, and delivered the
same way: one labelled `step-context` message after the history, never pushed
onto it. `turn` is unchanged and keeps system authority; use `context` for
observations, `turn` for text that must act as an instruction.
