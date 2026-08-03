---
title: Provider Operations
description: Direct provider usage in @namzu/sdk, including chat, streaming, tool-call inspection, model listing, health checks, and capability-driven routing.
last_updated: 2026-08-03
status: current
related_packages: ["@namzu/sdk", "@namzu/openai", "@namzu/anthropic", "@namzu/bedrock", "@namzu/openrouter", "@namzu/http", "@namzu/ollama", "@namzu/lmstudio"]
---

# Provider Operations

`ProviderRegistry` is not only an agent bootstrap tool. It also gives you a normalized direct-call surface for preflight checks, admin screens, streaming UIs, and lower-level orchestration that does not want to jump straight into `ReactiveAgent`.

## 1. When Direct Provider Calls Are the Right Tool

Use the provider directly when you need:

- a simple preflight request before enabling agent runtime
- streaming output without the full agent loop
- model catalogs for admin or setup UIs
- health probes or background readiness checks
- custom orchestration where you want to inspect tool calls yourself

Use agents when you want Namzu to own the iterative loop, tool execution, and final run assembly.

## 2. Create a Provider and Inspect Capabilities

```ts
import { ProviderRegistry } from '@namzu/sdk'
import { registerOpenAI } from '@namzu/openai'

registerOpenAI()

const { provider, capabilities } = ProviderRegistry.create({
  type: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o-mini',
})

console.log(capabilities.supportsStreaming)
console.log(capabilities.supportsTools)
console.log(capabilities.supportsFunctionCalling)
```

The returned `capabilities` object is the fastest way to branch UI or runtime behavior before the first call.

## 3. Use `chat()` for Synchronous Direct Calls

```ts
const response = await provider.chat({
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: 'Answer briefly.' },
    { role: 'user', content: 'Summarize what Namzu providers normalize.' },
  ],
  temperature: 0.2,
})

console.log(response.message.content)
console.log(response.finishReason)
console.log(response.usage.totalTokens)
```

`chat()` is the easiest path when you want one normalized response object and do not need incremental chunks.

## 4. Use `chatStream()` for Incremental Output

```ts
let text = ''

for await (const chunk of provider.chatStream({
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Count from one to three.' }],
})) {
  if (chunk.error) {
    throw new Error(chunk.error)
  }

  if (chunk.delta.content) {
    text += chunk.delta.content
    process.stdout.write(chunk.delta.content)
  }

  if (chunk.finishReason) {
    console.log('\nfinish reason:', chunk.finishReason)
  }
}

console.log(text)
```

The stream chunks are normalized across providers:

- `delta.content` carries text
- `delta.toolCalls` carries incremental tool-call deltas
- `finishReason` tells you why generation ended
- `usage` may appear near the end of the stream

## 5. Handle Classified Provider Failures

All published Namzu providers throw the same `ProviderRequestError` shape for
request-start and mid-stream provider failures. Use the structural guard rather
than `instanceof`; an application can load more than one copy of the SDK through
its dependency graph.

```ts
import { isProviderRequestError } from '@namzu/sdk'

try {
  for await (const chunk of provider.chatStream({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'Summarize this document.' }],
  })) {
    process.stdout.write(chunk.delta.content ?? '')
  }
} catch (error) {
  if (!isProviderRequestError(error)) {
    throw error
  }

  console.error({
    kind: error.kind,
    providerId: error.providerId,
    status: error.status,
    retryAfterMs: error.retryAfterMs,
  })
}
```

`kind` is one of:

| Kind | Meaning |
| --- | --- |
| `throttle` | The provider rate-limited the request |
| `network` | The provider could not be reached or its stream failed |
| `auth` | The provider rejected the credentials |
| `context_overflow` | The prompt exceeded the model context window |
| `bad_request` | The provider rejected the request as invalid |
| `server` | The provider failed while handling an otherwise valid request |

`status` and `retryAfterMs` are optional because not every transport exposes an
HTTP response or preserves retry headers. They are metadata only: Namzu does not
sleep or retry when constructing the error. In particular, the Ollama client
discards response headers before its driver sees an error.

Provider errors deliberately omit vendor messages, response bodies, URLs, and
`cause`. Those surfaces may contain credentials echoed by an upstream service.
The normalized message and structured fields are safe to record. A caller-owned
abort remains the caller's original abort error and is not converted into a
provider failure.

When using `query()` or `drainQuery()`, the same safe metadata also appears on
failed runs and `run_failed` events; see
[Low-Level Runtime](../runtime/low-level.md#9-event-streaming-and-sse-mapping).

## 6. Direct Tool-Call Inspection

Direct provider calls do not execute tools for you. They only return normalized tool-call requests when the model chooses them.

```ts
import { ToolRegistry, defineTool } from '@namzu/sdk'
import { z } from 'zod'

const tools = new ToolRegistry()

tools.register(
  defineTool({
    name: 'echo_text',
    description: 'Return the provided text.',
    inputSchema: z.object({ text: z.string() }),
    modelInputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    enforceModelInput: true,
    category: 'analysis',
    permissions: [],
    readOnly: true,
    destructive: false,
    concurrencySafe: true,
    async execute({ text }) {
      return { success: true, output: text }
    },
  }),
)

const response = await provider.chat({
  model: 'gpt-4o-mini',
  messages: [
    {
      role: 'user',
      content: 'Call echo_text with the text direct provider flow.',
    },
  ],
  tools: tools.toLLMTools(),
  // Optional non-wire provider hint for tools with a reviewed
  // modelInputSchema. The agent runtime derives this automatically.
  // This OpenAI example ignores the hint; Anthropic transports map it
  // to strict tool use when the selected model supports that feature.
  enforceToolInputSchema: ['echo_text'],
  toolChoice: 'auto',
})

console.log(response.message.toolCalls)
```

Important boundary:

- providers return tool-call intent
- `ToolRegistry.execute()` or the agent runtime performs the actual tool execution
- `enforceToolInputSchema` is a Namzu provider hint, not a JSON request field;
  custom providers must map or strip it instead of spreading the whole params
  object into a wire payload

If you need automatic tool execution and iterative reasoning, move back up to `ReactiveAgent` or [Low-Level Runtime](../runtime/low-level.md).

## 7. Optional Provider Methods

Most published providers implement two optional utility methods:

- `listModels()`
- `healthCheck()`

Use them defensively because they are optional on the shared contract:

```ts
const healthy = await provider.healthCheck?.()
const models = await provider.listModels?.()

console.log(healthy ?? 'healthCheck not implemented')
console.log(models ?? 'listModels not implemented')
```

Typical uses:

- `healthCheck()` before accepting traffic
- `listModels()` when rendering setup forms or validating config choices

## 8. Capability-Driven Routing

The capability object returned by `ProviderRegistry.create()` is often enough to decide which runtime shape to use:

| Capability | Typical decision |
| --- | --- |
| `supportsStreaming` | Turn on token-by-token or chunk-by-chunk UI |
| `supportsTools` | Enable tool-enabled agents or direct tool-call inspection |
| `supportsFunctionCalling` | Prefer structured tool orchestration instead of plain-text prompting |
| `supportsVision` | Attach images to a user message |
| `supportsDocuments` | Attach documents to a user message |

This lets you branch behavior without hardcoding vendor names.

### Attaching a file to a user turn

A user message carries `attachments`. An attachment with no `type` is an
image — that is what every attachment was before documents existed, so the
discriminant stays optional and no existing caller changes:

```ts
query({
  messages: [
    {
      role: 'user',
      content: 'summarise this contract',
      attachments: [
        { type: 'document', data: base64Pdf, mediaType: 'application/pdf', name: 'contract.pdf' },
        { data: base64Png, mediaType: 'image/png' },
      ],
    },
  ],
})
```

Vision and document support are declared separately because they are
separate wire shapes and a driver can map one without the other. Sending a
document to a driver that declares `supportsDocuments: false` warns before
the request — or throws with `strictCapabilities: true` — instead of
letting the model answer about a file it never saw. Drivers that map
images only degrade a document to a named placeholder, so the transcript
says what was dropped rather than implying it arrived.

### Getting the passage back

Set `citations: true` on a document and the answer carries the passages
it rests on:

```ts
const run = await agent.run(...)
const answer = run.messages.at(-1)

for (const citation of answer?.citations ?? []) {
  console.log(citation.citedText, citation.location) // { kind: 'page', start: 4, end: 4 }
}
```

Citations land on the assistant message, not inside its text. The text is
what a human reads and the citations are what a checker follows; splicing
markers into the prose would make the answer worse to read in exchange for
making it machine-checkable. Absent and empty mean the same thing — the
model cited nothing.

`location` is a union rather than a page number, because providers segment
differently and the segmentation is theirs: `page` for a paginated
document, `char` for plain text, `block` for something already
structured. Flattening all three to a page number would invent one for the
two that have none.

Opt-in per document, because it is not free: the provider splits the
document into citable units and the answer carries the passages it leaned
on, which costs tokens on a turn that may not need them. A driver that
maps documents but not citations returns none.

Without this, "here is the contract, answer questions about it" was
reachable only by having a tool read the file and stringify it, which
loses the provider's native document handling — page structure, built-in
OCR, citations — and pays the text cost instead.

## 8. Direct Provider Calls vs Agent Runtime

| If you need... | Use |
| --- | --- |
| One request and one normalized answer | `collect(provider.chatStream(params))` |
| Incremental output | `provider.chatStream()` |
| Health or model discovery | `healthCheck()` / `listModels()` |
| Tool execution loop, safety policy, and final run assembly | `ReactiveAgent.run()` or `drainQuery()` |

## 10. Common Mistakes

| Mistake | Why it hurts |
| --- | --- |
| assuming `chat()` executes tools automatically | direct provider usage only returns tool-call intent |
| assuming every provider implements `listModels()` and `healthCheck()` | those methods are optional on the shared interface |
| ignoring `capabilities` and branching by vendor name instead | you lose the main benefit of the provider abstraction |
| jumping straight into agents before a direct preflight request | setup errors become harder to isolate |
| logging an unknown vendor error or its `cause` instead of the normalized fields | upstream error text may contain request data or credentials |

## Related

- [Provider Registry](./registry.md)
- [SDK Quickstart](../quickstart.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Providers Overview](../../providers/README.md)
- [Provider Interface Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/types/provider/interface.ts)
- [Provider Registry Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/provider/registry.ts)
