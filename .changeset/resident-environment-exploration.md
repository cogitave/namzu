---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Learning hosts can supply an optional `explore` callback to run environment experiments before generating guidance. The SDK retains bounded observations and their digest, then provides them to `generate` as `context.exploration`. Missing usage, cancellation, stale state or evidence-journal failure prevents continuing to synthesis or activation.

The CLI forwards the callback, shows its exploration phase and retains evidence in SQLite. Hosts that omit it keep their current behavior. Event consumers opting into this feature should handle the new `explore` stage and `exploration` event kind. Exploration needs separately authorized tools and independent evaluation; enabling it does not automatically start learning in ordinary conversations.
