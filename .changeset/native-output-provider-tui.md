---
"@namzu/cli": minor
"@namzu/sdk": patch
"@namzu/anthropic": major
"@namzu/openai": minor
"@namzu/openrouter": minor
"@namzu/deepseek": minor
"@namzu/http": major
"@namzu/zen": major
---

Use `namzu --output-schema /absolute/path/schema.json` for native schema-constrained TUI answers. Unsupported or lossy schema conversion fails at launch; normal conversations remain unchanged. Supply the flag again on resume.

Enable native query admission for Codex, OpenRouter, DeepSeek, HTTP and Zen wire mappings. Codex forwards Responses text.format; HTTP maps schemas for both dialects. Zen messages requests use native format instead of hidden tool fallback, and Google requests preserve JSON Schema constraints. Endpoint/model support is still required and vendor errors remain errors.

Breaking for direct HTTP/Zen callers: an Anthropic-dialect response format can no longer be silently ignored or fall back to an output tool. Schema-free JSON and explicit strict:false are rejected. Use strict native JSON Schema on a capable model, or choose SDK structuredOutput.mode="tool" when native schema output is unavailable.

Anthropic transport retries now default to zero instead of the vendor SDK default of two. The host immediately receives classified HTTP 429 responses with Retry-After metadata instead of waiting invisibly inside the vendor client. Set AnthropicConfig.maxRetries to 2 to retain the former transport retry behavior.

Rate-limit guidance no longer claims automatic retries were exhausted when retry policy may have disabled them or refused the requested delay.
