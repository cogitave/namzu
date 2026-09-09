# @namzu/zen

## 1.0.0

### Major Changes

- c635b5a: Use `namzu --output-schema /absolute/path/schema.json` for native schema-constrained TUI answers. Unsupported or lossy schema conversion fails at launch; normal conversations remain unchanged. Supply the flag again on resume.

  Enable native query admission for Codex, OpenRouter, DeepSeek, HTTP and Zen wire mappings. Codex forwards Responses text.format; HTTP maps schemas for both dialects. Zen messages requests use native format instead of hidden tool fallback, and Google requests preserve JSON Schema constraints. Endpoint/model support is still required and vendor errors remain errors.

  Breaking for direct HTTP/Zen callers: an Anthropic-dialect response format can no longer be silently ignored or fall back to an output tool. Schema-free JSON and explicit strict:false are rejected. Use strict native JSON Schema on a capable model, or choose SDK structuredOutput.mode="tool" when native schema output is unavailable.

  Anthropic transport retries now default to zero instead of the vendor SDK default of two. The host immediately receives classified HTTP 429 responses with Retry-After metadata instead of waiting invisibly inside the vendor client. Set AnthropicConfig.maxRetries to 2 to retain the former transport retry behavior.

  Rate-limit guidance no longer claims automatic retries were exhausted when retry policy may have disabled them or refused the requested delay.

### Minor Changes

- 0795da3: Add optional Zen and Zen Go providers for OpenCode's services using Namzu's
  existing model contract. Exact service/model catalogue entries select Chat Completions,
  Responses, Anthropic Messages or Google streaming transport. Tool
  continuations, native reasoning metadata, conversation attribution,
  cancellation and classified provider errors remain part of the normal
  Namzu kernel lifecycle.

  The CLI exposes Zen (`zen`) and Zen Go (`zen-go`) in provider selection and
  headless runs. Zen supports anonymous public models and optional credentials;
  Go requires its own key. The actual Namzu
  conversation is retained for service attribution across turns and resume.
  The driver requires Node.js 20+ and a supported public model, or a real key
  with a known model or explicit protocol. Bundled prices are estimates;
  unsupported controls and content combinations are refused.

- 4cac9ca: Enable Zen's current public models without requiring an account key or an
  OpenCode installation. Anonymous SDK calls and the CLI's Zen default use
  `muse-spark-1.3-contributor-free`. Omitted, blank or `public` Zen keys select
  anonymous access, restricted to six explicitly supported free model IDs;
  paid or unknown models still require a real key. The SDK keeps
  `glm-5.3-flash` as the default for credentialed Zen and Go calls, and Go
  continues to require its own API key.

  The CLI uses environment keys first, then reuses separate `opencode` and
  `opencode-go` API-key entries from `OPENCODE_AUTH_CONTENT` or OpenCode's
  data-directory `auth.json`, including the paired Windows home on WSL when
  no absolute XDG override is supplied.
  It leaves that file unchanged and does not reinterpret OAuth records as
  API keys. Explicit `OPENCODE_API_KEY=public` selects anonymous access and
  suppresses secondary Zen key aliases and stored account keys. With no
  credential, Zen appears as public access without a login
  or key prompt. Public model availability and service limits remain under
  the upstream service's control.

  Expose `@namzu/zen/models` for catalogue functions and model types without
  loading the four native transport adapters during provider selection.

  Send `strict: false` for all Responses function tools so optional parameters,
  including nested read/edit fields, remain optional. This fixes HTTP 400
  schema rejection when a backend defaults omitted strictness to true.
  Responses also declines the capability-dependent `enforceToolInputSchema`
  hint for these general schemas; Namzu continues to validate inputs before
  tool execution. Other protocols retain their existing enforcement behavior.
