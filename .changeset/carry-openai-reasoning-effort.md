---
'@namzu/sdk': minor
'@namzu/openai': minor
---

Expand `ReasoningEffort` with `none`, `minimal`, and `ultra`, while making the vocabulary explicitly model-specific rather than a universal capability claim. The OpenAI Chat Completions driver now carries a requested effort to `reasoning_effort`, refuses levels outside each recognized model family's published set before transport, and exposes `openAIReasoningEffortLevels()` with an honest `undefined` result for unknown compatible-endpoint model ids.
