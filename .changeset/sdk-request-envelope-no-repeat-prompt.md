---
"@namzu/sdk": minor
---

A turn's session log no longer writes the system prompt twice. A `request_envelope` record whose system text is the turn's own prompt carries `systemPromptFrom: 'turn_started'` and no `systemPrompt`; read the text from the turn's `turn_started`. A request whose prompt a step rewrote keeps its `systemPrompt`, and logs written before this read unchanged. The live `request_envelope` event still carries the text. If you read `systemPrompt` from `request_envelope` records, fall back to the turn's `turn_started` record when it is missing.
