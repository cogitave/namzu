---
title: Testing Agents
description: Script the model with MockLLMProvider to test tools, the agent loop, retries and failure recovery without calling a real provider.
last_updated: 2026-07-31
status: current
related_packages: ["@namzu/sdk"]
---

# Testing Agents

`MockLLMProvider` is a model you script. It emits the same stream frames a
real driver produces — per tool: `index`, then id and name, then argument
fragments, then the block-close signal — so a test written against it
exercises the real consumer path rather than a shortcut through it.

That fidelity is the point. A mock that shortcut the framing would let a
driver regression through, which is the opposite of what it is for.

## 1. Script a Tool Call

```ts
import { MockLLMProvider, query } from '@namzu/sdk'

const provider = new MockLLMProvider({
  turns: [
    { toolCalls: [{ name: 'read', args: { path: 'a.txt' } }] },
    { text: 'The file says hello.' },
  ],
})
```

A script shorter than the run **repeats its last turn**, so a loop bug
surfaces as repetition rather than a crash in the harness.

## 2. Turn Shape

| Field | |
| --- | --- |
| `text` | assistant text for the turn |
| `toolCalls` | `[{ name, args?, id?, argChunkSize?, truncateArguments? }]` |
| `finishReason` | defaults to `tool_calls` when there are calls, else `stop` |
| `usage` | partial `TokenUsage` merged over zeros |
| `chunkSize` | text fragment size |
| `error` | fail the request outright: `{ message, status? }` |
| `throwAfterChunks` | fail mid-stream after N text chunks |

## 3. Failure Injection

Retry policy, stream recovery and truncation handling are all testable
without a network.

```ts
import { MockLLMProvider } from '@namzu/sdk'

// A 429 the runtime should retry.
new MockLLMProvider({ turns: [{ error: { message: 'rate limited', status: 429 } }] })

// A stream that dies after two chunks.
new MockLLMProvider({ turns: [{ text: 'abcdefgh', chunkSize: 4, throwAfterChunks: 2 }] })

// A tool call the provider cut off mid-JSON at max_tokens.
new MockLLMProvider({
  turns: [{ toolCalls: [{ name: 'write', args: { content: 'x' }, truncateArguments: true }] }],
})
```

## 4. Assert on What the Runtime Sent

```ts
import { MockLLMProvider } from '@namzu/sdk'

// Your test framework's, whichever it is.
declare const expect: (actual: unknown) => {
  toContain: (expected: unknown) => void
  toEqual: (expected: unknown) => void
}

const provider = new MockLLMProvider({ turns: [{ text: 'ok' }] })

// … run the agent …

expect(provider.requests[0]?.tools?.map((t) => t.function.name)).toContain('read')
expect(provider.requests[0]?.cacheControl).toEqual({ type: 'auto' })
```

`requests` is `ChatCompletionParams[]`, so the request the runtime built is
checked as a typed value: `tools` is `LLMToolSchema[]` (hence
`t.function.name`) and `cacheControl` is `{ type: 'auto' | 'ephemeral' }`.

`onRequest(params)` is the callback form. `provider.reset()` rewinds the
script and clears captured requests between cases.

## 5. Decide Each Turn From the Request

```ts
import { MockLLMProvider } from '@namzu/sdk'

new MockLLMProvider({
  nextTurn: (params, i) =>
    params.messages.some((m) => String(m.content).includes('error'))
      ? { toolCalls: [{ name: 'diagnose' }] }
      : { text: `turn ${i}` },
})
```

## 6. Inspect What the Loop Did

Pair the mock with `onStepFinish` and `Run.steps` (see
[Loop Control](./loop-control.md)) to assert on tool sequences, per-step
usage and timings — the trajectory, not just the final answer.

## Related

- [Loop Control and Resilience](./loop-control.md)
- [SDK Runtime](./README.md)
- [SDK Tools](../tools/README.md)
- [Replay and Checkpoints](./replay.md)
