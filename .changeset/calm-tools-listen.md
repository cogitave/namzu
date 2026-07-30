---
"@namzu/sdk": minor
"@namzu/anthropic": minor
"@namzu/http": minor
---

Separate runtime tool validation from canonical model-facing JSON Schema,
propagate constrained-input hints through the agent loop, and map reviewed
schemas to Anthropic strict tool use with capability-aware overrides. The
built-in edit tool advertises only canonical arguments.
