---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add `/orchestrate`, a session mode layered above reasoning effort rather than inside it.

`@namzu/cli`: `/orchestrate [on|off]` (no argument toggles) turns the mode on or off for the current session. It is deliberately not a `ReasoningEffort` value — typing `/effort orchestrate` still reports "unavailable for this model", exactly as `ultracode` does today. When the `/effort` picker can open, the mode also appears there as its own row below a rule, apart from the model's own levels. Turning the mode on pins reasoning effort to the model's highest published level and strengthens delegation guidance for future turns toward delegating by default; when the model publishes no exact effort menu the mode still turns on and still strengthens guidance, but pins nothing and says so. Like effort, the mode is in-memory and per-session — nothing is written to preferences. A model switch still resets an explicit effort override to the new model's default, but while the mode is on it re-pins to the new model's highest level instead. The status line shows the level and the mode together (`effort high · orchestrate`), or the mode alone when nothing is pinned — never a fabricated effort value.

`@namzu/sdk`: `codingAgentDoctrineContribution` gains an optional `orchestrate` field on `CodingAgentDoctrineOptions`, and a new exported `CODING_AGENT_ORCHESTRATE_DOCTRINE` constant. Passing `orchestrate: true` (and leaving `delegation` at its default) appends that text after the existing delegation doctrine. Leaving the new field unset — the only behavior any existing caller can observe — renders byte-identical output to before this field existed. No default changed and no export was renamed or removed, so this is additive for every current consumer.
