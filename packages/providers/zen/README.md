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

```bash
pnpm add @namzu/sdk @namzu/zen zod@^3
```

Requires Node.js 20+ and `@namzu/sdk >=36.0.0`. The optional package uses the
official AI SDK provider adapters directly through `LanguageModelV3.doStream`;
it does not depend on the `ai` orchestration package or another Namzu provider.

```ts
import { generateSessionId, runAgent } from '@namzu/sdk'
import { ZenProvider } from '@namzu/zen'

const apiKey = process.env.OPENCODE_API_KEY ?? process.env.OPENCODE_ZEN_API_KEY
if (!apiKey) throw new Error('Set OPENCODE_API_KEY for OpenCode Zen.')

const sessionId = generateSessionId()
const provider = new ZenProvider({ apiKey, sessionId })
const { output, run, identity } = await runAgent({
  provider,
  model: 'glm-5.3-flash',
  sessionId,
  prompt: 'Explain what an agent kernel does.',
  maxIterations: 4,
})

console.log(output)
console.log(run.stopReason)
console.log(identity)
```

This example makes a model request when run with a real key. For Go, use
`ZenGoProvider` and `OPENCODE_GO_API_KEY`. Driver constructors receive
keys explicitly; environment lookup belongs to the application or CLI.
Keep one provider instance per conversation, and reuse its `sessionId`
after restart. The CLI passes the actual Namzu conversation ID, including
across resume and compaction; it does not import credentials from OpenCode.

## Service and protocol selection

| Service | Registry type | Default base URL | CLI environment |
| --- | --- | --- | --- |
| Zen | `zen` | `https://opencode.ai/zen/v1` | `OPENCODE_API_KEY`, then `OPENCODE_ZEN_API_KEY` |
| Zen Go (Go service) | `zen-go` | `https://opencode.ai/zen/go/v1` | `OPENCODE_GO_API_KEY` |

Both default to `glm-5.3-flash`. Routes are selected from the exact service
and model ID: `chat` uses Chat Completions, `responses` uses Responses,
`messages` uses Anthropic Messages, and `google` uses streaming
`generateContent`. The same model family can use different wires on Zen
and Go. Unknown IDs require an explicit `protocol` configuration; model
names are never used to guess a wire format.

`ZenConfig` accepts `apiKey`, `sessionId`, `model`, `baseURL`, `timeout`
and `protocol`. Timeout defaults to 120,000 milliseconds. A missing
`sessionId` generates an ID once per instance. Every request carries
`x-opencode-session` plus Namzu's current attribution headers.

Registry-based applications call `registerZen()` and/or
`registerZenGo()` once, then use `ProviderRegistry.create()` with the
corresponding discriminated config. The package also exports
`getZenModels(service)`, `findZenModel(service, id)`,
`ZEN_BASE_URL`, `ZEN_GO_BASE_URL`, and `ZEN_CAPABILITIES`.

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
bundled models. Static limits and USD-per-million-token prices are a pinned
snapshot, not an invoice: context tiers, caches, Go peak/off-peak rates,
subscription allowances and promotions can change the effective charge.

Tests use the real provider adapters with local HTTP/SSE fixtures, including
tool continuations, signatures, cancellation and error classification.
An SDK kernel test executes a registered tool and feeds its result into the
next model request before completing the run.
No live inference with an OpenCode account was performed for this change.

FSL-1.1-MIT, converting to MIT two years after each release.
