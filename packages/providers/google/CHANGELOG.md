# @namzu/google

## 1.1.1

### Patch Changes

- 49491b9: The drivers now report more accurately how a response ended. The runtime uses this to tell a tool call the output limit cut off from one the model wrote badly.

  - `@namzu/anthropic`: a tool call whose JSON does not parse no longer fails the whole stream with "the provider stream returned malformed data". The block close and the finish reason now reach the runtime. `model_context_window_exceeded` is reported as `length`, and `refusal` as `content_filter`. Both used to read as a normal `stop`.
  - `@namzu/bedrock`: `model_context_window_exceeded` is reported as `length`, and `guardrail_intervened` as `content_filter`. A tool call opens with the id the driver keeps, so its arguments never arrive before an id.
  - `@namzu/http`: the OpenAI dialect maps `finish_reason` instead of passing the server's string through. `function_call` becomes `tool_calls`; `max_tokens` and `max_output_tokens` become `length`; `model_length`, `context_length`, `context_length_exceeded` and `model_context_window_exceeded` become `length` with `finishDetail: 'context_window'`; `eos`, `eos_token`, `end_turn` and `stop_sequence` become `stop`. `error` fails the stream with a `ProviderRequestError` (`kind: 'server'`), as OpenRouter's does. A value it does not know reports no finish reason at all, which the runtime reads as a response that did not say how it ended, rather than as a normal finish. The Anthropic dialect gets the Anthropic mapping above and opens a tool call with the id its arguments carry.
  - `@namzu/openrouter`: `finish_reason` is mapped the same way. `error` (the upstream model failed mid-generation) now fails the stream with a `ProviderRequestError` (`kind: 'server'`).
  - `@namzu/deepseek`: `insufficient_system_resource` now fails the stream with a `ProviderRequestError` (`kind: 'server'`). It used to read as a finished answer.
  - `@namzu/openai`: Codex's `response.incomplete` is reported as `length`, or as `content_filter` when that is the stated reason, with its usage. The stream used to end with no finish reason, so auto-continuation never ran.
  - `@namzu/anthropic`, `@namzu/bedrock` and `@namzu/http`'s Anthropic dialect: a `model_context_window_exceeded` stop also carries `finishDetail: 'context_window'`, so the runtime does not ask the model to continue a reply that filled the whole context window.
  - `@namzu/anthropic`, `@namzu/google` and `@namzu/openai` (Codex): the list of sources a driver appends after a hosted search now carries `contentOrigin: 'driver'` on its stream chunk. The text is unchanged. Without the mark, a tool call the output limit cut off before that list would be reported as malformed.

  If you branch on `finishReason`, expect `length` or `content_filter` where you saw `stop` for these cases.

## 1.1.0

### Minor Changes

- 4375e72: A provider-hosted web search now says what it searched for. `StreamChunk.delta.hostedTool`, and so the `hosted_tool` session event and the `hosted.tool` SSE event, may carry `query` (the search query), `url` (a page the provider opened instead of running a query) and `results` (how many sources it reported). Codex fills them from the search call's action, Anthropic from the search block's streamed input and its result list, Google from the grounding metadata. Each field is optional and absent when the provider does not say; nothing that already reads `id`, `name` and `status` changes. A custom driver can start emitting them whenever it knows them.

## 1.0.0

### Major Changes

- e83dfe5: `listModels()` omits `inputPrice` and `outputPrice` for a model this driver has no rate for, instead of reporting the rate as `0`.

  The returned `ModelInfo[]` is the published signature that moved: both fields are optional on it now, so read them as `number | undefined`. Their runtime values changed too, and that half is not caught by a type — a key that used to be present is now absent, and code that defaulted it with `?? 0` will keep doing exactly what this release stopped doing for you.

  What each driver does now:

  - **`@namzu/anthropic`** — the live listing from `models.list` carries no rates, so it omits both. The bundled offline catalogue still carries its real published prices, unchanged.
  - **`@namzu/openai`** — `client.models.list` publishes no rates, so both are omitted. `codex` likewise.
  - **`@namzu/deepseek`** — the account listing and the bundled known-model list are unrated here, so both are omitted.
  - **`@namzu/google`** — the two-row price table still prices `gemini-2.5-flash` and `gemini-2.5-pro`; every other model the API returns is now unpriced rather than free.
  - **`@namzu/openrouter`** — a model whose listing carries no `pricing` block is unpriced. A model the vendor prices at `"0"` is still free and still reports `0`, which is the distinction this release is about.

  An absent rate means unknown, and a consumer that shows one should say so rather than `$0.00`. `@namzu/sdk`'s `ModelInfo.inputPrice` carries the reasoning.

## 0.3.1

### Patch Changes

- 8d5223b: Nothing a consumer installs or calls changes, and that is the whole of this
  release. `vitest` moves from `^3.2.6` to `^4.1.11` in the `devDependencies` of
  all nineteen packages that declared it, and `@vitest/coverage-v8` moves with it
  in `@namzu/sdk`. Every occurrence is a devDependency — checked, not assumed —
  so `dependencies`, `peerDependencies`, exports, types, defaults and the wire
  shape are untouched, and the published tarballs differ from the previous
  release only in `package.json#devDependencies`.

  The reason is a security fix with no 3.x backport. `GHSA-82fw-gwwq-j7x9`
  ("Path Traversal / Arbitrary File Read via `@vitest/mocker` Redirect Mock")
  covers `vitest` and `@vitest/mocker` from `2.1.0` up to `4.1.11`, so `^3.2.6`
  can only be resolved by leaving the 3.x line. `4.1.11` is the first patched
  release and is what the lockfile now resolves for both.

  What this costs anyone who works on the repository rather than with it: the
  upgrade was not a version bump. Vitest 4 changed test discovery, coverage
  configuration, mock construction and reporter output, and each of those broke
  something here that had to be migrated rather than worked around. Those fixes
  are all under `__tests__/`, `vitest.config.ts` files and `scripts/`, none of
  which is published, which is why this is a patch and not a major.

  You do not need to do anything. If you pin `vitest` yourself to run this
  project's own suites, note that the config files it ships are now written for
  `>= 4.1.11` and will not run under 3.x.

## 0.3.0

### Minor Changes

- 64d9b9b: CLI auto search now selects native live search for supported direct Anthropic and Google API-key models instead of Exa. Native requests use provider quotas and execute without local tool approval. Set `web.backend: exa` to keep the previous common-search behavior on these routes. Unsupported model/endpoint combinations retain common search under auto; cached mode is never silently changed to live.

  Add model/mode-aware hosted-search capability checks, preserve them through provider wrappers, and forward hosted search through ReactiveAgent and delegated runs. Anthropic retains encrypted search blocks and citation indices for unchanged matching-route continuation; Google retains grounding source links. Common search previews omit internal provenance framing while preserving raw results for the model and history.

## 0.2.0

### Minor Changes

- 7785cb4: Add Google model access with a native SDK provider and CLI model selection. Reuse an existing Gemini CLI Google sign-in from this device, including the paired Windows home under WSL, without requiring a new API key. Explicit Gemini or Google API keys remain an alternative and take precedence when configured. Borrowed sign-ins are refreshed in memory without rewriting their owner file; Google account access retains the Code Assist route rather than being sent to the API-key endpoint.

Initial native Gemini API and existing Gemini CLI OAuth transport.
