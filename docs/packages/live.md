---
uid: namzu.packages.live
title: Live sessions — lifecycle, media contracts and cancellation
description: Reference for @namzu/live: the independent live-session lifecycle, PCM and speech-driver contracts, semantic turn handling, barge-in, bounded queues, terminal events and Namzu model bridge.
type: Reference
diataxis: reference
owner: cogitave/namzu
status: active
timestamp: 2026-08-31T00:00:00Z
lastReviewed: 2026-08-31
resource: packages/live/src/index.ts
tags: [live, voice, realtime, reference]
---

# Live sessions — lifecycle, media contracts and cancellation

`@namzu/live` is Namzu's transport-agnostic live-agent runtime. It does not
wrap or require another agent framework. It composes caller-supplied media
drivers around the same `query()` runtime used by other Namzu applications.

The dependency direction remains one way:

```text
@namzu/sdk ← @namzu/live ← caller media and transport adapters
```

The SDK still owns the model run, tools, permission policy, budgets, stores and
telemetry. The live package owns conversation history, turn lifecycle,
continuous audio ingress, barge-in, phrase segmentation and live events.

## Complete composition

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

const session = new LiveSession({ vad, stt, turnDetector, tts, audioOutput })
await session.start(
  new LiveAgent({
    instructions: 'Answer naturally and briefly.',
    model: new NamzuModel({ createQueryParams: () => queryConfig }),
  }),
)

const listening = session.listen(microphoneFrames())
await listening.wait()
await session.close()
```

The caller converts its microphone or room track to
`AsyncIterable<AudioFrame>` and implements `AudioOutput` over its playback
transport. The package deliberately does not export a room abstraction it
cannot drive.

## Audio frame contract

Every frame declares its wire shape:

| Field | Contract |
|---|---|
| `format` | Interleaved `pcm_s16le` or `pcm_f32le`. |
| `sampleRateHz` | Integer from 8,000 through 192,000. |
| `channels` | Integer from 1 through 8. |
| `samplesPerChannel` | Positive integer; together with the fields above it determines exact byte length and duration. |
| `data` | Exact PCM byte count for the declared shape; drivers treat it as immutable. |
| `sequence`, `timestampMs` | Optional non-negative ordering and finite source time. |

The default maximum frame duration is 100ms. VAD and speech recognition each
receive the same continuous frame stream through their own queue, bounded by
1,000ms of audio by default. The ingress producer never queues waiting writes:
if either consumer falls behind the duration budget, listening fails with
`audio_buffer_overflow`. That keeps buffering inside the named boundary rather
than pushing an unbounded queue into the microphone adapter.

## Endpoint and turn flow

VAD and speech recognition run concurrently. Their outputs meet at one
utterance coordinator:

1. `speech_start` opens an utterance and immediately interrupts any active
   response. VAD owns pre-roll and hangover policy.
2. `speech_end` supplies the acoustic endpoint. A maximum speech timer refuses
   an utterance that never ends.
3. `final_transcript` supplies the recognizer's final hypothesis. Partial
   transcripts are observable but never submitted to the model as final text.
4. `TurnDetector.isTurnComplete()` receives both timestamps, the final text and
   conversation history. Returning `false` carries the text into the next
   utterance; it is not dropped.
5. A complete turn calls the same `LiveSession.run()` front door as a typed
   message. The ingress pump continues while model and synthesis work runs.

Input EOF flushes both driver iterators. A pending speech endpoint, unmatched
final transcript or semantic continuation at EOF is `incomplete_utterance`,
not silent data loss.

## Model and tool authority

`LiveModel` is a small stream contract: text deltas, optional usage, then
exactly one `completed` or `cancelled` terminal event. `NamzuModel` implements
it with public SDK `query()`.

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

const result = await session.run({ userInput: 'Summarize the change.' }).wait()
console.log(result.message?.content)
await session.close()
```

Register tools only in the `ToolRegistry` inside `NamzuQueryConfig`. The live
runtime has no parallel tool registry or executor, so a model-authored tool
call has one authority and one execution record.

Output guardrails, answer review and structured output are refused before
provider work. Those modes can rewrite or reject an answer after text has
already reached synthesis; a buffered integration is the honest surface for
them. A live run is speakable only when the SDK completes with `end_turn` or
`stop_condition`.

## Speech output and barge-in

Model deltas are accumulated into bounded phrase chunks. Sentence punctuation
flushes a phrase; the configured maximum forces a boundary for long text; end
of iterable is the synthesizer flush signal. This avoids one synthesis request
per token without allowing unlimited text buffering.

`AudioOutput.write()` resolves when the caller's output accepted a synthesized
frame. `AudioOutput.cancel(turnId, reason)` is required because accepting audio
is not the same as playing it. On interruption the session aborts model and
synthesis work, calls `cancel`, increments its generation fence and discards
every late chunk. It commits an assistant message to history only after the
model, synthesizer and output writes complete. The history therefore means
"generated and accepted", never "heard by a participant".

## Shutdown

Every driver receives an `AbortSignal`, but shutdown does not assume every
third-party driver behaves. Session close also requests iterator cleanup,
fences late yields and stops waiting after a finite deadline. A stale task can
no longer publish into a later turn.

The Namzu model stream is intentionally different: after abort it keeps
draining `query()` until the SDK returns its terminal cancelled `Run`. That
preserves run-store and telemetry truth instead of abandoning a run in the
`running` state.

## Deliberate boundaries

- Room/RTC transport, telephony, noise cancellation and worker deployment are
  caller adapters, not hidden dependencies.
- Local VAD/STT/TTS/model inference can implement the same driver contracts;
  no local model or checkpoint is bundled.
- Native speech-to-speech is a future `LiveModel`/media-driver shape, not a
  capability claimed by the text-turn bridge.
