<!-- okf
type: Reference
title: "@namzu/live"
description: >-
  Namzu's transport-agnostic live agent runtime. Compose continuous audio
  ingress, VAD, speech recognition, semantic turn detection, Namzu model
  turns, speech synthesis and cancellable audio output without another agent
  runtime.
tags: [readme, package, live, voice, realtime]
timestamp: 2026-08-31T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/live</h1>

**Namzu-native live sessions with caller-owned media drivers.**

[![npm](https://img.shields.io/npm/v/@namzu/live.svg)](https://www.npmjs.com/package/@namzu/live)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Compose a live session](#compose-a-live-session) · [Session-owned handles](#session-owned-handles) · [Boundaries](#boundaries)

</div>

---

`@namzu/live` is an optional leaf package. It owns live-session lifecycle,
conversation history, barge-in, media-driver orchestration and events. Its
`NamzuModel` sends every language-model turn through `@namzu/sdk`, so tools,
policy, budgets, cancellation, stores and telemetry keep one owner.

`LiveAgent` can instead receive a custom `LiveModel`. In that composition the
caller, not the live package, owns model tools, policy, budgets, persistence and
telemetry. Live history itself is process-local in both cases.

The package contains no room, RTC, speech-provider or deployment dependency.
Callers adapt their audio source and supply VAD, speech recognition, semantic
turn detection, speech synthesis and a cancellable audio output.

## Install

```bash
pnpm add @namzu/sdk @namzu/live
```

`@namzu/sdk` is a peer dependency. Install both. This release supports SDK
33.1.1 through the 33.x line (`>=33.1.1 <34`) and requires Node.js 20 or newer.

## Compose a live session

```ts
import {
  type AudioFrame,
  type AudioOutput,
  LiveAgent,
  LiveSession,
  type NamzuQueryConfig,
  NamzuModel,
  type SpeechRecognizer,
  type SpeechSynthesizer,
  type TurnDetector,
  type VoiceActivityDetector,
} from '@namzu/live'

declare const queryConfig: NamzuQueryConfig
declare const vad: VoiceActivityDetector
declare const stt: SpeechRecognizer
declare const turnDetector: TurnDetector
declare const tts: SpeechSynthesizer
declare const audioOutput: AudioOutput
declare function microphoneFrames(): AsyncIterable<AudioFrame>

const model = new NamzuModel({ createQueryParams: () => queryConfig })
const agent = new LiveAgent({
  instructions: 'Answer naturally and briefly.',
  model,
})
const session = new LiveSession({ vad, stt, turnDetector, tts, audioOutput })

await session.start(agent)
const listening = session.listen(microphoneFrames())
await listening.wait()
await session.close()
```

`listen()` continuously drains the audio source while response work runs. A
new `speech_start` interrupts the previous model/synthesis task, calls
`audioOutput.cancel(turnId, reason)`, and fences every late text or audio chunk.

For a text turn, speech drivers are not required:

```ts
import { LiveAgent, LiveSession, type NamzuQueryConfig, NamzuModel } from '@namzu/live'

declare const queryConfig: NamzuQueryConfig

const session = new LiveSession()
await session.start(
  new LiveAgent({
    instructions: 'Be concise.',
    model: new NamzuModel({ createQueryParams: () => queryConfig }),
  }),
)

const result = await session.run({ userInput: 'What changed?' }).wait()
console.log(result.message?.content)
await session.close()
```

## Session-owned handles

`run()` returns a `LiveTurn`; `listen()` returns a `LiveListening`. Both are
exported as TypeScript interfaces rather than runtime constructors. The session
creates and tracks the handles returned by these calls together with their work
and completion promises. A structurally matching caller-created object is not
attachable to, or recognized by, a session.

Use `LiveTurn.wait()` to await a result and `interrupt()` to stop that turn. Use
`LiveListening.wait()` to await the ingress pump and `stop()` to stop new audio
ingress. Natural input EOF flushes the media drivers and waits for audio-originated
turns; `stop()` does not cancel a response already launched. `session.close()` is
the operation that interrupts listening and every active turn.

## Driver contracts

| Driver | What the live runtime drives |
|---|---|
| `VoiceActivityDetector` | Continuously consumes PCM frames and emits explicit speech start/end events. |
| `SpeechRecognizer` | Continuously consumes the same frames and emits partial/final transcripts. |
| `TurnDetector` | Decides whether a VAD endpoint plus final transcript completes the semantic turn. |
| `LiveModel` | Streams text, usage and one terminal result for the response turn. |
| `SpeechSynthesizer` | Consumes bounded phrase chunks; iterable EOF is the flush boundary. |
| `AudioOutput` | Acknowledges accepted audio frames and cancels queued playback per turn. |

Audio is explicit interleaved PCM: `pcm_s16le` or `pcm_f32le`, with sample
rate, channel count and samples per channel on every frame. Oversized frames,
realtime-buffer overflow, missing requested drivers and unresolved utterances
are errors; they are never accepted and dropped.

A final transcript timestamps the end of its recognized speech on the same
source timeline as VAD. The runtime matches it to the containing VAD interval,
so independently scheduled drivers cannot swap two utterances merely because
their callbacks arrive in a different order. Interval endpoints are inclusive,
so a final exactly on a boundary shared by two utterances is ambiguous and is
refused.

## Boundaries

- Conversation history is in memory. It records each accepted user submission
  immediately and assistant text only after a completed turn. It does not claim
  that a participant heard audio after an output driver accepted it.
- VAD pre-roll and hangover, noise cancellation, room transport, telephony and
  worker deployment belong to caller adapters.
- Local inference and native speech-to-speech can be implemented as drivers;
  they are not bundled or claimed by this package.
- When using `NamzuModel`, register tools in Namzu's `ToolRegistry`. There is no
  second tool executor in the live runtime. Custom `LiveModel` implementations
  own their tool semantics themselves.

## Documentation

- [Live sessions — lifecycle, media contracts and cancellation](https://github.com/cogitave/namzu/blob/main/docs/packages/live.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
