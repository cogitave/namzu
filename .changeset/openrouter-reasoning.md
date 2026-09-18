---
'@namzu/openrouter': minor
---

Send and surface reasoning.

The driver now carries the SDK's thinking controls onto OpenRouter's unified `reasoning`
object — `thinking: { type: 'enabled', budgetTokens }` becomes `{ enabled: true, max_tokens }`,
`adaptive` becomes `{ enabled: true }`, `disabled` becomes `{ enabled: false }`, and `effort`
becomes `{ effort }` — and streams the model's thinking back on the reasoning channel
instead of dropping it. `effort: 'max'` and `effort: 'ultra'` are refused rather than sent:
this wire cannot carry those levels, and an effort that arrives as a different depth is
indistinguishable from one that was honoured.

What a host observes: a caller that set `thinking` or `effort` used to get
`OpenRouterProvider does not implement thinking`; the request is now made. Reasoning blocks
arrive on the assistant message for every model that returns them (verified against
`nvidia/nemotron-3.5-lightning:free`, which returns both `reasoning` and `reasoning_details`),
and `usage.reasoningTokens` reports the thinking share of the completion tokens the vendor
already billed. The text is emitted once, not twice: OpenRouter sends it in both fields, and
the indexed `reasoning_details` form is the one used.
