# @namzu/zen

## 1.0.2

### Patch Changes

- 6551d15: Fix two error-classification bugs in the Zen driver that could misreport a genuine upstream failure (`overloaded`/`5xx`) as an unreachable-network one, or an unreachable-network one as an upstream server failure, depending on how the connection actually failed.

  - **A connection Zen's own SDK layer never got any HTTP response on (a transport failure such as `ECONNREFUSED`, or a proxy reset) is now classified `provider.network` ("could not reach the provider"), not `provider.unavailable` ("the provider is failing on its own side").** The driver used to default a missing status code to a fabricated `502`, which read as a genuine 5xx from the provider and pointed an operator at "resume once it recovers" for a request that in fact never reached the wire at all.
  - **A client-side timeout or aborted request (what a `fetch` call rejects with when `AbortSignal.timeout` fires — the shape behind Zen's free/anonymous models occasionally not answering in time) now keeps the platform's real reason in the error's `detail`** instead of the generic fallback "The model stream failed." (`message`/`name` on that rejection live on the prototype, not as own properties, and the driver's own fingerprinting was reading only own properties).
  - **Every classified failure from a `chatStream` call now names the model in its message and `detail`** (e.g. `model "big-pickle": …`), so a run juggling more than one model — or a log line read without the status line above it — still says which request failed. `providerId` (`"zen"` / `"zen-go"`) is unchanged; nothing keys on it differently.

  No public API changes. Nothing here indicates a Zen catalogue problem: `big-pickle` and every other listed model are unaffected by this fix, which only corrects how an already-thrown failure is classified and described.

## 1.0.1

### Patch Changes

- 2869fbe: Encode Responses requests with `toolChoice: 'none'` by omitting both tool definitions and the tool-choice field. This preserves the no-tools constraint while avoiding a Muse HTTP 400 during budget/time finalization. Required and named tool choices remain explicit, and other protocol routes retain their encoding.

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
