<!-- okf
type: Reference
title: "@namzu/zen"
description: Zen and Zen Go model drivers for the Namzu kernel, with native protocol routing and conversation attribution.
tags: [readme, package, provider, opencode]
status: stable
-->

# @namzu/zen

Zen and Zen Go model drivers for [Namzu](https://github.com/cogitave/namzu),
connecting to OpenCode's Zen and Go services.
Both implement the SDK's existing `LLMProvider` interface. Namzu continues to
own the agent loop, tools, permissions, budgets, retries, persistence and
delegation.

Zen publishes a free-model catalogue. Namzu defaults requests without a key to
`space-bunny-free`. Every Zen model the catalogue prices at zero can be selected
without a key through an experimental request path that reproduces the OpenCode
client the free-tier gateway admits: an OpenCode User-Agent at 1.18 or newer, a
descending `ses_` session id, and the four tool names `bash`, `glob`, `grep` and
`read` in every request body (injected only where the caller has not registered
them). The Zen gateway may still refuse a model. Models that need an API key are
listed after the free ones, under their own "Free" and "API key" headings in the
pickers (a list with only one group keeps an "(API key)" note on those rows
instead). Zen Go requires its own API key.

```bash
pnpm add @namzu/sdk @namzu/zen zod@^3
```

Requires Node.js 20+ and `@namzu/sdk >=36.0.0`; the example below uses the
`turn` field `runAgent` returns from `@namzu/sdk` 44 on (earlier versions call
it `run`). The optional package uses the
official AI SDK provider adapters directly through `LanguageModelV3.doStream`;
it does not depend on the `ai` orchestration package or another Namzu provider.

```ts
import { generateSessionId, runAgent } from '@namzu/sdk'
import { ZenProvider } from '@namzu/zen'

const sessionId = generateSessionId()
const provider = new ZenProvider({ sessionId })
const { output, turn, identity } = await runAgent({
  provider,
  model: 'space-bunny-free',
  sessionId,
  prompt: 'Explain what an agent kernel does.',
  maxIterations: 4,
})

console.log(output)
console.log(turn.stopReason)
console.log(identity)
```

This example uses the direct keyless path verified for `space-bunny-free` on
2026-09-28. Gateway admission can change. For Go, use `ZenGoProvider` with its
API key.
SDK constructors do not read environment variables or credential files;
that lookup belongs to the application or CLI.
Keep one provider instance per conversation, and reuse its `sessionId`
after restart. The CLI passes the actual Namzu conversation ID, including
across resume and compaction.

## Service and protocol selection

| Service | Registry type | Default base URL | CLI environment |
| --- | --- | --- | --- |
| Zen | `zen` | `https://opencode.ai/zen/v1` | `OPENCODE_API_KEY`, then `OPENCODE_ZEN_API_KEY` |
| Zen Go (Go service) | `zen-go` | `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_API_KEY` |

The SDK defaults anonymous Zen calls to `space-bunny-free`;
Zen with a real key and Go default to `glm-5.3-flash`. The CLI's default Zen
model is also Space Bunny Free. Routes are selected from the exact service
and model ID: `chat` uses Chat Completions, `responses` uses Responses,
`messages` uses Anthropic Messages, and `google` uses streaming
`generateContent`. The same model family can use different wires on Zen
and Go. Unknown IDs require an explicit `protocol` configuration; model
names are never used to guess a wire format. Every zero-price Zen model,
including `space-bunny-free`, uses the experimental OpenCode-shaped request
identity on the official Zen endpoint. Installing OpenCode is recommended for
comparison, and its installed version supplies the advertised User-Agent when
one is found; Namzu sends its own requests and does not invoke the installed
binary. A protocol override does not grant access to paid or unknown models.

A missing, blank or `public` Zen `apiKey` selects anonymous access. Public
availability and service limits can change. For credentialed access, the CLI
uses the environment variables above first, then reads OpenCode API-key
entries from `OPENCODE_AUTH_CONTENT` when set, otherwise from
`$XDG_DATA_HOME/opencode/auth.json` for an absolute XDG path or
`~/.local/share/opencode/auth.json`. Without an absolute XDG override, WSL
can also reuse the paired Windows home's file. It maps `opencode` to Zen and
`opencode-go` to Go separately, ignores OAuth entries, and never changes the
owner's file. With no key, Zen remains selectable as an anonymous option, but
its model listing does not verify inference access or prompt for a key.

`ZenConfig` accepts `apiKey`, `sessionId`, `model`, `baseURL`, `timeout`
and `protocol`, all optional. `ZenGoConfig` requires `apiKey` for Go.
Timeout defaults to 120,000 milliseconds. A missing
`sessionId` generates an ID once per instance. Every request carries
`x-opencode-session` plus Namzu's current attribution headers, except on the
official Zen host where an anonymous free-model call replaces them with the
OpenCode identity described above.

Registry-based applications call `registerZen()` and/or
`registerZenGo()` once, then use `ProviderRegistry.create()` with the
corresponding discriminated config. The package also exports
`getZenModels(service)`, `findZenModel(service, id)`,
`ZEN_BASE_URL`, `ZEN_GO_BASE_URL`, and `ZEN_CAPABILITIES`.
The `@namzu/zen/models` subpath exposes the catalogue functions and model
types without loading the native transport adapters.

## History, controls and limits

Text, ordinary tools, inline images and documents use the SDK message
contract. Signed reasoning, encrypted Responses items and Gemini thought
signatures retain native ordering in versioned replay state, except that Muse
Spark Responses requests do not ask for encrypted reasoning and do not replay
its native reasoning items: the gateway cannot round-trip that ciphertext.
Replay requires
the original configured route, service, protocol, model, history prefix,
and unchanged durable assistant text, calls and reasoning. A changed route
or compacted history uses portable text/tool history without foreign native
reasoning.

Unsupported controls and histories are refused. In particular, unresolved
stored attachments must be materialized first, document citation requests
are unsupported, Chat Completions cannot carry rich tool results, and a
failed rich tool result cannot preserve both visual content and failure
status through this adapter API. Messages tool documents must be PDFs.
Images explicitly marked with a valid durable `modelOmission` are omitted.
Failed text results retain a native error flag on Messages and an explicit
failure marker on the other wires.
Provider-executed tools and generated-file output are unsupported.

Reasoning effort levels come from the selected model's catalogue entry;
an empty list means no selectable effort control. Thinking and sampling
controls also depend on the wire. See the [SDK guide](../../../docs/sdk/zen.md)
for configuration and refusal details.

`listModels(signal?)` intersects the live service catalogue with supported
models and restricts anonymous results to Zen models priced at zero. A model the page
routes and prices but models.dev has not described yet is listed with
conservative limits and `limitsVerified: false`; the field is absent otherwise.
Static limits and USD-per-million-token prices are derived from the
services' own documentation pages, models.dev and the services' `/models`
answers, and are estimates rather than invoices: context tiers, caches, Go
peak/off-peak rates, subscription allowances and promotions can change the
effective charge.

The package ships a bundled snapshot of that catalogue and never reaches the
network for it on its own. A host that wants a fresher roster opts in:

```ts
import { ZenProvider } from '@namzu/zen'
import { fetchZenCatalogue } from '@namzu/zen/catalogue'

const { catalogue, report } = await fetchZenCatalogue({ timeoutMs: 10_000 })
const provider = new ZenProvider({ apiKey: process.env.OPENCODE_API_KEY, catalogue })
console.log(report.servedUndocumented)
```

`fetchZenCatalogue` reads the five sources with per-source deadlines and byte
limits, applies the same rules the snapshot is generated with, and either
returns a whole catalogue or rejects — never a partial list. A runtime
catalogue takes precedence over the bundled snapshot; an id the service serves
with no known wire is listed as `<id> (no known wire format)` and is callable
only with an explicit `protocol`. `parseZenCatalogue` re-admits a stored copy
with the same strictness. The Namzu CLI refreshes it this way in the
background on every launch. The bundled snapshot is regenerated by hand with
`scripts/generate-zen-models.mjs`.

Tests use the real provider adapters with local HTTP/SSE fixtures, including
tool continuations, signatures, cancellation and error classification.
An SDK kernel test executes a registered tool and feeds its result into the
next model request before completing the turn.
On 2026-09-08, live text inference on `muse-spark-1.3-contributor-free`
succeeded without an account key through installed OpenCode and Namzu's
driver. A live Namzu `run-stream` call (the command is now `namzu exec --json`) with low effort and production tools
also read `verification.txt`, then returned its exact nonce, absent from
the prompt, after two model requests. The read succeeded and the turn ended
with `end_turn`. This validates that model's public text and file-tool path;
it does not establish every public or paid model, Go access, or billing.

On 2026-09-28, direct keyless Namzu requests to `space-bunny-free` completed
text inference and a tool continuation. Minimal direct requests to the other
seven bundled free models returned HTTP 403 `FreeTierError`. A later probe with
the full Namzu request body and experimental OpenCode-shaped identity returned
HTTP 200 for six more; Ling returned HTTP 400 `Endpoint is unavailable`, as it
also did in installed OpenCode. Namzu's real CLI completed text requests for
Big Pickle and Muse Spark, plus a Big Pickle file-tool continuation.

On 2026-10-13 the gateway was re-probed and it had moved: `space-bunny-free`
now answered `FreeTierError` too, and ablation pinned what it actually reads —
`stream: true`, the four tool names `bash`, `glob`, `grep` and `read` in the
request, a User-Agent at `opencode/1.18` or newer (below that, HTTP 426), and a
descending `ses_` session id. With all four, ten of the thirteen bundled
models completed text inference (two of them also answered a transient HTTP 429
on a later run); `exo-free` and `mimo-v2.5-free` answered HTTP
410 `ModelDeprecated` and `ling-3.0-flash-fin-free` answered HTTP 400, and
those three stay in the catalogue because their pages still route them.
Gateway admission can change again.

FSL-1.1-MIT, converting to MIT two years after each release.
