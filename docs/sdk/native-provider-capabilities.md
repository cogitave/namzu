---
type: Reference
title: Native structured output provider admission
description: Explicit driver support and route checks for native JSON Schema responses.
resource: packages/sdk/src/provider/capabilities.ts
tags: [sdk, providers, structured-output]
---

# Native structured output provider admission

`ProviderCapabilities.supportsNativeStructuredOutput` declares that a driver maps
`ChatCompletionParams.responseFormat` with `type: 'json_schema'` onto its native
request wire. Only an explicit `true` admits this request. Missing capabilities,
an omitted flag, and `false` all reject it before calling the provider.
The older capability resolver keeps its permissive defaults for existing flags;
ordinary requests and `json_object` requests retain their existing admission behavior.

The query streaming boundary checks the selected provider. `withProviderFallback`
also checks each actual member immediately before dispatch, preserving the schema
and the member's model. A supported primary failing over to an unsupported member
stops with `ProviderRequestError`, kind `bad_request`, code
`native_structured_output_unsupported`. An unsupported member is not silently
skipped. No network request is sent through that member.

The OpenAI API driver declares support because it sends `response_format`.
The Anthropic driver declares support because it maps JSON Schema onto
`output_config.format`; it rejects explicit `strict: false`.
The OpenAI subscription (Codex) driver maps schemas to Responses `text.format`.
OpenRouter, DeepSeek and the HTTP OpenAI dialect forward `response_format`.
The HTTP Anthropic dialect uses `output_config.format` and refuses schema-free
JSON mode or `strict: false`. These declarations describe wire mapping, not
model eligibility: a service/model that only accepts `json_object` can still
reject a JSON Schema request.
Zen exposes native schema mapping across chat, Responses, messages and Google.
Messages explicitly selects native output format instead of adapter tool fallback;
Google uses `generationConfig.responseJsonSchema` to preserve JSON Schema constraints
that the pinned adapter's OpenAPI conversion would drop. This driver-level declaration does not
guarantee that every model or compatible third-party endpoint accepts the schema;
provider model/schema errors still propagate normally.

Custom providers and wrappers must preserve the capability declaration and map
the actual schema onto their request wire before opting in. Direct calls to a
custom provider's own `chatStream` implementation remain its responsibility;
the SDK admission guards apply at query and fallback dispatch boundaries.

## Anthropic retry ownership

`AnthropicConfig.maxRetries` defaults to `0`. The first throttle/network failure
reaches the host without vendor retries hiding its status or Retry-After metadata.
Set `maxRetries: 2` to restore the previous vendor default. Explicit counts must
be nonnegative integers. This is separate from schema correction attempts and
host retry policies; a transport quota response is not a schema validation failure.

The rate-limit diagnostic reports provider delay without assuming retries occurred.
