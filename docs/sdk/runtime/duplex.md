---
title: Duplex Sessions
description: Run a conversation with no turn boundary in @namzu/sdk — the driver contract, the session loop, tool execution that does not stall the stream, and interruption.
last_updated: 2026-08-03
status: current
related_packages: ["@namzu/sdk"]
---

# Duplex Sessions

Every other seam in this kernel is turn-based by construction: a run has
iterations, an iteration sends a complete message list and reads a stream
back, and a checkpoint is taken between two of them. That shape is
load-bearing everywhere it appears and it cannot describe a conversation
where input keeps arriving while output is still being produced.

So this is a **second contract**, not a widening of the first. Bending
`chatStream` to accept a live input channel would put a half-duplex
assumption inside every consumer of the turn-based path in exchange for a
duplex path that still would not fit.

## 1. The Loop

```ts
import { startBidiRun } from '@namzu/sdk'
import type { BidiProvider, ToolRegistry } from '@namzu/sdk'

declare const provider: BidiProvider
declare const tools: ToolRegistry

const run = await startBidiRun({
  provider,               // a BidiProvider
  tools,                  // the ordinary ToolRegistry
  connect: { model: 'realtime-model', tools: tools.toLLMTools() },
  workingDirectory: process.cwd(),
})

await run.send({ type: 'text', text: 'what is on my calendar?' })

for await (const event of run.events()) {
  if (event.type === 'text') process.stdout.write(event.text)
}
```

## 2. Two Properties the Turn-Based Loop Never Needs

**A tool must not block the stream.** The model keeps producing while a
tool runs, and the human keeps talking. Awaiting a tool inline would stall
the events an interruption arrives on — so the loop would only notice it
had been interrupted after finishing work the interruption made
pointless. Tool calls therefore start and are not awaited; their answers
are sent back when they arrive.

**An interruption invalidates work in flight.** When the human speaks over
the model, a tool the model asked for is answering a question nobody is
asking. A call that was still running when `interrupted` arrived is
**abandoned** — reported as `tool_abandoned` and never sent back — because
delivering it would put a stale answer into a conversation that has moved
on. A call that had already finished is unaffected.

A driver that cannot detect interruption simply never emits it, and the
loop behaves as though the model always finished what it started.

## 3. What Is Not Here

- **Audio capture and playback.** `BidiInput` and `BidiEvent` carry audio
  as base64 with a media type; getting it to and from a device belongs to
  whatever owns the microphone.
- **Checkpoint and resume.** A duplex session's state lives on the far
  side of a socket, and there is no defined boundary to take a snapshot
  at. Pretending otherwise would produce checkpoints that cannot restore.
- **A driver for a live service.** The contract ships with a scripted
  driver (`createMockBidiProvider`), which is how the turn-based path is
  developed and regression-tested too. A real driver implements
  `BidiProvider` the same way a real model driver implements
  `LLMProvider`.
