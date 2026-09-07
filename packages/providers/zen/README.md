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

Zen includes public models that work without an account key or an OpenCode
installation. Namzu defaults anonymous Zen calls to Muse Spark 1.3 Contributor
Free (`muse-spark-1.3-contributor-free`). Zen Go still requires its own API key.

```bash
pnpm add @namzu/sdk @namzu/zen zod@^3
```

Requires Node.js 20+ and `@namzu/sdk >=36.0.0`. The optional package uses the
official AI SDK provider adapters directly through `LanguageModelV3.doStream`;
it does not depend on the `ai` orchestration package or another Namzu provider.

```ts
import { generateSessionId, runAgent } from '@namzu/sdk'
import { ZenProvider } from '@namzu/zen'

const sessionId = generateSessionId()
const provider = new ZenProvider({ sessionId })
const { output, run, identity } = await runAgent({
  provider,
  model: 'muse-spark-1.3-contributor-free',
  sessionId,
  prompt: 'Explain what an agent kernel does.',
  maxIterations: 4,
})

console.log(output)
console.log(run.stopReason)
console.log(identity)
```

This example makes a public model request without an account key. For paid
Zen models, pass `apiKey`. For Go, use `ZenGoProvider` with its API key.
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

The SDK defaults anonymous Zen calls to `muse-spark-1.3-contributor-free`;
Zen with a real key and Go default to `glm-5.3-flash`. The CLI's default Zen
model is the free Muse model. Routes are selected from the exact service
and model ID: `chat` uses Chat Completions, `responses` uses Responses,
`messages` uses Anthropic Messages, and `google` uses streaming
`generateContent`. The same model family can use different wires on Zen
and Go. Unknown IDs require an explicit `protocol` configuration; model
names are never used to guess a wire format. Anonymous access is restricted
to six explicitly supported public model IDs; a protocol override does not
grant access to paid or unknown models.

A missing, blank or `public` Zen `apiKey` selects anonymous access. Public
availability and service limits can change. For credentialed access, the CLI
uses the environment variables above first, then reads OpenCode API-key
entries from `OPENCODE_AUTH_CONTENT` when set, otherwise from
`$XDG_DATA_HOME/opencode/auth.json` for an absolute XDG path or
`~/.local/share/opencode/auth.json`. Without an absolute XDG override, WSL
can also reuse the paired Windows home's file. It maps `opencode` to Zen and
`opencode-go` to Go separately, ignores OAuth entries, and never changes the
owner's file. With no key, Zen remains available as a public provider and
does not require a login or key prompt.

`ZenConfig` accepts `apiKey`, `sessionId`, `model`, `baseURL`, `timeout`
and `protocol`, all optional. `ZenGoConfig` requires `apiKey` for Go.
Timeout defaults to 120,000 milliseconds. A missing
`sessionId` generates an ID once per instance. Every request carries
`x-opencode-session` plus Namzu's current attribution headers.

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
signatures retain native ordering in versioned replay state. Replay requires
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
bundled models and restricts anonymous results to the explicit public set.
Static limits and USD-per-million-token prices are a pinned
snapshot, not an invoice: context tiers, caches, Go peak/off-peak rates,
subscription allowances and promotions can change the effective charge.

Tests use the real provider adapters with local HTTP/SSE fixtures, including
tool continuations, signatures, cancellation and error classification.
An SDK kernel test executes a registered tool and feeds its result into the
next model request before completing the run.
On 2026-09-08, live text inference on `muse-spark-1.3-contributor-free`
succeeded without an account key through installed OpenCode and Namzu's
driver. A live Namzu `run-stream` call with low effort and production tools
also read `verification.txt`, then returned its exact nonce, absent from
the prompt, after two model requests. The read succeeded and the run ended
with `end_turn`. This validates that model's public text and file-tool path;
it does not establish every public or paid model, Go access, or billing.

FSL-1.1-MIT, converting to MIT two years after each release.
