---
"@namzu/sdk": major
"@namzu/openai": minor
"@namzu/anthropic": minor
---

Require explicit `ProviderCapabilities.supportsNativeStructuredOutput: true` for JSON Schema response-format requests at query and provider fallback dispatch. Custom providers previously forwarding `json_schema` through `withProviderFallback` without this declaration must now declare the flag after implementing the native schema wire mapping; otherwise dispatch fails before their network call. Ordinary requests and older capability defaults are unchanged.

OpenAI API and Anthropic declare their existing native schema mappings. Codex does not claim support. Every actual fallback member is checked, preventing an unsupported fallback from silently dropping the output contract.
