---
"@namzu/sdk": major
"@namzu/cli": patch
"@namzu/anthropic": patch
---

Add `PrepareStepResult.context` for current observations carried after history in a labelled runtime message for this request only. It is separate from `system` authority, counted in subsequent stages' context estimates, and never replaces operator intent or accumulates in conversation history.

The emitted `RuntimeContextMessageKind` union now includes `step-context`. Consumers with exhaustive switches or records over that exported union must handle the new kind as runtime-generated context, not operator input. This is the SDK's breaking surface; existing `prepareStep.system` callers retain their behavior.

The CLI moves its changing context inventory into this field. OpenAI and Anthropic request conversion no longer moves that inventory ahead of conversation history as system text. This preserves history placement without promising cache hits or reduced billed tokens.

Anthropic message caching now places its breakpoint before request-only step context, so the cached boundary ends on stable history rather than the inventory that changes next step. Requests without step context keep their existing breakpoint.
