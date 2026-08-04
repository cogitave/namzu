---
'@namzu/sdk': minor
'@namzu/bedrock': major
'@namzu/openrouter': major
'@namzu/http': major
'@namzu/ollama': major
'@namzu/lmstudio': major
---

Every driver that cannot think now says so instead of dropping the request.

`thinking` sits on `ChatCompletionParams`, so every driver accepts it. Five of
them — Bedrock, OpenRouter, HTTP, Ollama, LM Studio — implemented none of it
and dropped the field: the caller got an ordinary completion with an empty
`reasoning` array, which is indistinguishable from a model that simply chose
not to reason. The request looked honoured and the answer looked like an
answer.

The OpenAI driver already refused instead, with the reasoning written out
beside it. So the rule had been decided once and applied once, while five
siblings went on being silent. It moves to `@namzu/sdk` as
`assertThinkingUnsupported(driverName, params)`, and a new driver now inherits
it rather than re-deciding it.

The error names the driver, which in a multi-provider setup is the difference
between a bug report about the model and a one-line configuration fix.

**Turning thinking off stays a no-op** on all of them, because that is the
state a driver without thinking is already in — a config shared across
providers saying `{ type: 'disabled' }` should not fail on the ones that were
never going to think.

`assertThinkingSupported` in `@namzu/openai` is unchanged as an export and now
delegates to the shared helper. Its message changed: it no longer says
"extended thinking", because `adaptive` is refused too and calling that
extended would be wrong.

**Migration.** If you passed `thinking` to any of the five and relied on it
being ignored, remove it — you were receiving a non-thinking answer either way,
and now you find out at the call instead of by inspecting an empty array.

Not in this change: implementing thinking natively on Bedrock, which serves the
same Claude models through a different wire and deserves the per-model
resolution the Anthropic driver just gained. That needs the Converse request
and response shapes verified against the reference first, and is not something
to guess at.
