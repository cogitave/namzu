---
"@namzu/anthropic": minor
---

A refusal now carries what the service said about it, and the driver can name a model to retry on. The final message delta's `stop_details` (`category`, `explanation`, `recommended_model`, any of which may be null) is passed on as `refusal` on the finish chunk, so a host can tell a declined request from an empty reply. New `AnthropicProvider.refusalFallbackFor(model, refusal)` answers with the service's recommended model when the account's own model list contains it, otherwise with the next family of the same generation (Sonnet to Opus, Opus to Sonnet, Haiku to Sonnet); it names nothing when the list cannot be read, so a retry never goes to a model the account cannot use. `@namzu/sdk` uses it to re-run a refused request once on that model; set `refusalFallback: 'off'` in the query options to keep the model unchanged.

Also fixed: an empty assistant entry in the history (a refused or interrupted reply with no text, reasoning or tool call) was sent as the literal text `"null"`. It is now left out of the request, as the OpenAI driver does. The stored history is not changed.
