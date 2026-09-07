---
type: Guide
title: Zen and Zen Go
description: Use OpenCode services through Namzu's provider contract with native wire routing, stable conversation attribution, and validated reasoning replay.
resource: packages/providers/zen/src/index.ts
tags: [sdk, provider, opencode, reasoning, streaming]
status: stable
---

# Zen and Zen Go

`@namzu/zen` is an optional model driver. Its `ZenProvider` and
`ZenGoProvider` implement the same `LLMProvider.chatStream` contract as
other Namzu providers, connecting to OpenCode's Zen and Go services.
Install it alongside `@namzu/sdk >=36.0.0` and the
SDK's Zod v3 peer in a Node.js 20+ application.

Zen's public models work without an account key or an installed OpenCode
client. Anonymous access defaults to Muse Spark 1.3 Contributor Free.
Zen Go is a separate service and still requires its own API key.

```bash
pnpm add @namzu/sdk @namzu/zen zod@^3
```

The driver calls the official AI SDK provider adapters' low-level
`LanguageModelV3.doStream` method. It does not import `ai` or run an AI SDK
agent loop. Namzu owns tool execution, permissions, review, retries,
fallback, compaction, budgets and checkpoints. Transport dependencies are
pinned to `@ai-sdk/provider 3.0.15`, `@ai-sdk/openai 3.0.109`,
`@ai-sdk/openai-compatible 2.0.74`, `@ai-sdk/anthropic 3.0.116` and
`@ai-sdk/google 3.0.121`; these share the V3 contract and retain support for
Namzu's Node.js 20 floor. The installed [provider contract](https://www.npmjs.com/package/@ai-sdk/provider/v/3.0.15)
defines a single generation stream, not tool execution or a kernel.

## Run and continue a conversation

```ts
import { generateSessionId, runAgent } from '@namzu/sdk'
import { ZenProvider } from '@namzu/zen'

const sessionId = generateSessionId()
const provider = new ZenProvider({ sessionId })
const first = await runAgent({
  provider,
  model: 'muse-spark-1.3-contributor-free',
  sessionId,
  prompt: 'Describe an agent kernel in one paragraph.',
})

const second = await runAgent({
  ...first.identity,
  provider,
  model: 'muse-spark-1.3-contributor-free',
  prompt: [...first.run.messages, { role: 'user', content: 'Give one example.' }],
})

console.log(second.output)
```

These calls perform public inference without an account key. `runAgent` generates
the other missing native identity fields; a host with stored sessions
supplies their actual identities instead. Reusing an ID does not reload
history. Pass the durable messages, as above, or restore them through the
SDK's normal persistence APIs.

`sessionId` is a stable conversation label sent in `x-opencode-session`.
If omitted, the provider generates one once in its constructor. Preserve
it when rebuilding the provider after restart, and create separate provider
instances for independent conversations. This is especially relevant to
Go's conversation-based accounting. The CLI uses the actual Namzu session
across turns, resume, compaction and auxiliary model calls; delegated work
is attributed to its invoking conversation.

## Select a service and model

| Setting | Zen | Zen Go (Go service) |
| --- | --- | --- |
| Constructor | `ZenProvider` | `ZenGoProvider` |
| Registry type | `zen` | `zen-go` |
| Registration | `registerZen()` | `registerZenGo()` |
| Base URL | `https://opencode.ai/zen/v1` | `https://opencode.ai/zen/go/v1` |
| CLI key lookup | `OPENCODE_API_KEY`, then `OPENCODE_ZEN_API_KEY` | `OPENCODE_GO_API_KEY` |
| SDK default model | Public Muse without a key; `glm-5.3-flash` with a real key | `glm-5.3-flash` |
| CLI default model | `muse-spark-1.3-contributor-free` | `glm-5.3-flash` |

For `ZenProvider`, an omitted or blank `apiKey`, or the explicit `public`
sentinel, selects anonymous access. A real API key selects credentialed
access. `ZenGoProvider` requires a real key. SDK constructors do not read
environment variables or another application's credential store.
`new ZenProvider()` is valid; the Go constructor instead takes `ZenGoConfig`,
which requires `apiKey`. Registry configs use `ZenProviderConfig` and
`ZenGoProviderConfig` respectively.

The CLI checks the direct key environment variables above first, then
resolves OpenCode's credential store in this order:

1. If `OPENCODE_AUTH_CONTENT` is set, it supplies the complete JSON store.
   An invalid override supplies no credentials and does not fall back to disk.
2. Otherwise, an absolute `XDG_DATA_HOME` selects
   `$XDG_DATA_HOME/opencode/auth.json` exclusively.
3. With no absolute XDG override, Namzu reads
   `~/.local/share/opencode/auth.json` and, on WSL, the paired Windows home's
   corresponding file when available.

Set `OPENCODE_API_KEY=public` to select anonymous Zen explicitly, even when
`OPENCODE_ZEN_API_KEY` or OpenCode's credential store contains a paid key.
The first applicable Zen key variable wins; a `public` value suppresses
later aliases and stored keys. For Go, `public` does not enable anonymous
access or fall back to a stored account.

Only
`type: "api"` entries with usable keys are admitted: `opencode` supplies Zen
and `opencode-go` supplies Go. OAuth entries are not treated as API keys,
and a Zen key is never reused for Go. The credential file is read only;
Namzu does not rewrite or refresh it. An installed OpenCode executable is
not required for public access.

With no usable key, Zen is discovered as a public provider rather than a
signed-in subscription. Selecting it does not request a key or start a
login flow; its picker label says `free models · no API key`. Public access
is ordered after existing credentials and reachable local providers,
including when selected by an explicit `public` environment value, so it
does not displace them when no provider preference is saved.
The CLI supports `--provider zen` and `--provider zen-go`; its
model picker uses live discovery.

Anonymous access is restricted to these explicit bundled model IDs:

- `muse-spark-1.3-contributor-free`
- `big-pickle`
- `mimo-v2.5-free`
- `ling-3.0-flash-fin-free`
- `nemotron-3-ultra-free`
- `nemotron-3.5-lightning-free`

This is current public access, subject to upstream availability and limits.
The driver does not infer public admission from an arbitrary model name or
zero price: the bundled `ZenModel.supportsAnonymousAccess` flag must be
explicitly `true`. Paid and unknown models require a real key, even when a caller
supplies a `protocol` override. The public convention follows OpenCode's
[provider loader](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/provider/provider.ts#L172),
which filters its uncredentialed catalogue and supplies `apiKey: "public"`.
Credential entry types are defined in OpenCode's
[auth module](https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/auth/index.ts#L12).

`ZenConfig` accepts optional `apiKey`, `sessionId`, `model`,
`baseURL`, `timeout` and `protocol`. `timeout` is a positive request timeout
in milliseconds, defaulting to 120,000. `baseURL` permits an HTTP(S)
host-owned proxy and rejects embedded credentials, query strings and
fragments. Model calls receive the SDK's current attribution headers;
redirects are refused.

| `ZenProtocol` | Native request |
| --- | --- |
| `chat` | `/chat/completions` |
| `responses` | `/responses` |
| `messages` | `/messages` |
| `google` | `/models/{model}:streamGenerateContent?alt=sse` |

The catalogue maps exact service/model pairs to these protocols. Names and
prefixes are not routing heuristics: for example, a family served through
Chat Completions on Zen may use Messages on Go. Pass the wire model ID
without an OpenCode CLI provider prefix. An unknown ID is refused unless
the host supplies `protocol` explicitly; that override does not invent
context limits, pricing or effort support.

`getZenModels('zen' | 'go')` returns supported bundled metadata;
`findZenModel(service, id)` performs exact lookup. `listModels(signal?)`
requests the selected service's `/models` endpoint and intersects its IDs
with that metadata. A live model without a supported local entry is not
advertised as ready to use. Anonymous discovery additionally restricts the
result to the explicit public model set above.

Catalogue-only consumers can import `getZenModels`, `findZenModel` and the
model types from `@namzu/zen/models`. This lightweight subpath avoids loading
the four native transport adapters; the CLI uses it for provider selection.

The snapshot's `inputPrice` and `outputPrice` are documented USD per million
tokens at the base tier. They are estimates for SDK accounting, not exact
billing. Cache discounts, long-context tiers, subscription allowances,
Go peak/off-peak pricing and promotions can change actual charges. See
the service's current [Zen](https://opencode.ai/docs/zen/) and
[Go](https://opencode.ai/docs/go/) documentation when evaluating cost.

## Controls and message fidelity

The common SDK fields map to the selected wire: text and tools, tool choice,
output token limit, supported sampling controls, JSON output requests and
per-call cancellation. The default output allowance is 4096 tokens when a
call does not set `maxTokens`. On Messages, this is the total output limit,
including manual thinking tokens; a thinking budget must leave room for an
answer within that limit. Reasoning controls are explicit:

| Protocol | Thinking and effort behavior |
| --- | --- |
| `chat` | Sends compatible thinking mode and reasoning effort; refuses thinking token budgets and display selection |
| `responses` | Uses adaptive effort and requests encrypted reasoning for stateless continuation; refuses manual thinking budgets |
| `messages` | Maps manual/adaptive thinking, effort and parallel tool settings; display selection requires adaptive thinking |
| `google` | Maps thinking budget/level and thought display; refuses a parallel-tool switch |

Known models reject effort values outside their advertised `effortLevels`.
An empty list means no effort selector. The provider can still reject
model-specific combinations; selecting a wire does not promise that every
model supports every setting on it. `repetitionPenalty` is refused;
`topK` requires Messages or Google; frequency/presence penalties are refused
on Messages and Responses. Responses also refuses stop sequences. Sampling
settings that the native adapter would discard for a thinking model are
refused before the request. Messages requires a schema for JSON output.
Explicit ephemeral cache control requires Messages. Adapter
warnings about unsupported settings become failures instead of successful
responses that silently ignore requested behavior.

All Responses function tools explicitly send `strict: false`, preserving their
optional parameters and nested fields. This avoids backends interpreting
omitted strictness as strict generation and rejecting valid Namzu tool
schemas, such as an edit tool with optional `edits`. This also applies to
tools named in `enforceToolInputSchema`: that field is a capability-dependent
hint, and Responses strict generation cannot represent Namzu's general
conditional and optional tool schemas. The schemas remain unchanged, and
Namzu validates tool inputs before execution. Other protocols retain their
own enforcement behavior.

Tool call IDs remain unchanged. Tool result names are resolved from the
preceding assistant calls, and malformed JSON or orphan results are refused
before transport. Inline image/document bytes become native content, not
text containing base64. Stored attachment references must be resolved by
the SDK before model delivery. Valid persisted `modelOmission` verdicts
skip rejected images while leaving their durable bytes intact.

Rich successful tool results preserve content order on supported native
wires. Chat Completions refuses rich tool results; Messages accepts PDF
tool documents. Failed text results use native `is_error` on Messages and
an explicit failure marker on the other wires, whose adapters otherwise
serialize error text identically to successful text.
Failed rich results are refused because the V3 result union cannot retain
both rich content and failure status. Document citation requests,
provider-executed tools, tool approval requests and generated-file outputs
are unsupported.

Completed native assistant parts are saved as lossless JSON in the SDK's
opaque `source.replayState`. This retains Anthropic thinking signatures and
redacted blocks, Responses encrypted reasoning, and Google thought
signatures on text/reasoning/tool parts. Reuse requires the exact configured
provider route and fallback index, service, protocol, model, preceding
history, and unchanged durable assistant text, ordered calls and reasoning.
The saved content is also checked for modification. Compacted or changed
history and foreign routes fall back to portable assistant/tool history
without replaying native reasoning metadata.

Native cancellation reaches the request and stream body, and iterator
cleanup cancels the remaining reader. HTTP and streamed errors use Namzu's
provider error classification without retaining credentials or raw provider
response text. Retry and fallback remain kernel policy.

## Evidence and source snapshot

The implementation uses Namzu's own conversion, replay and lifecycle code
around the official provider adapters. Protocol routes and prices were
checked against OpenCode revision
[`ecbc6ccac85b3e8087b6445e584318419b9e2b34`](https://github.com/anomalyco/opencode/tree/ecbc6ccac85b3e8087b6445e584318419b9e2b34),
including its [Zen documentation](https://github.com/anomalyco/opencode/blob/ecbc6ccac85b3e8087b6445e584318419b9e2b34/packages/web/src/content/docs/zen.mdx),
[Go documentation](https://github.com/anomalyco/opencode/blob/ecbc6ccac85b3e8087b6445e584318419b9e2b34/packages/web/src/content/docs/go.mdx)
and [provider integration](https://github.com/anomalyco/opencode/blob/ecbc6ccac85b3e8087b6445e584318419b9e2b34/packages/opencode/src/provider/provider.ts).
Limits, modalities, tool support and effort options use models.dev revision
[`1a84fdd72ad6c7f507af96aafbcc59a2f818f9fd`](https://github.com/anomalyco/models.dev/tree/1a84fdd72ad6c7f507af96aafbcc59a2f818f9fd).

Automated tests exercise the actual installed adapters with local HTTP/SSE
fixtures: native request bodies, tool continuations, signed metadata replay,
route changes, cancellation, usage and error classification. A full SDK
kernel fixture executes a registered tool and checks its result in the next
model request and the run's completed answer. These tests do not
establish live account access, inference quality or current billing.

On 2026-09-08, a live public-access check found installed OpenCode 1.18.29 with zero stored
credentials and successfully requested `muse-spark-1.3-contributor-free`.
Namzu's real driver also completed a text-only request through that model
using public access and its own attribution headers.

A live Namzu `run-stream` call then used the same model with low effort,
no account key, and the production tool set. Its `read` tool opened
`verification.txt` containing a nonce absent from the prompt. The tool
completed with `isError: false`; after two model requests, `done` returned
the exact nonce with `end_turn`. This validates that model's public text
and file-tool continuation path. It does not establish every public model,
paid-account access, Go inference, or billing: the run reported 13,749
unpriced tokens, which are not a verified charge.
