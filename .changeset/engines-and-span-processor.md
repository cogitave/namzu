---
'@namzu/sdk': minor
'@namzu/sandbox': minor
'@namzu/telemetry': minor
'@namzu/files': minor
'@namzu/computer-use': minor
'@namzu/lsp': minor
'@namzu/evals': minor
'@namzu/anthropic': minor
'@namzu/bedrock': minor
'@namzu/http': minor
'@namzu/lmstudio': minor
'@namzu/ollama': minor
'@namzu/openai': minor
'@namzu/openrouter': minor
---

Declare the Node floor these packages already had, and export a type `TelemetryConfig` already required.

**`engines.node: ">=20.0.0"`.** Only `@namzu/cli` declared one; the other fourteen published without any, so npm could not warn a consumer installing onto an unsupported runtime — they got a crash at some later import instead. The floor is not new: `@namzu/cli` has declared it since it shipped and `install.sh` has enforced it since it existed. This makes the other fourteen say the same thing.

If you install with `engine-strict=true` on Node 18, an install that previously emitted nothing will now fail. Upgrade to Node 20 or newer, which the code already assumed. Everyone else sees no change, or an `EBADENGINE` warning that replaces a later crash.

Worth stating plainly: CI verifies Node 22 and 24. The 20 floor is a declared minimum, not a tested one.

**`SpanProcessorLike` is now exported from `@namzu/telemetry`.** `TelemetryConfig.spanProcessors` takes `readonly SpanProcessorLike[]`, and the type had no export — a field on the public surface whose type was not on it, so a host supplying the value had to inline the shape or reach for `any`.
