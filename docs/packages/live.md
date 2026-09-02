---
title: Live sessions — lifecycle, media contracts and cancellation
description: Reference for @namzu/live: the independent live-session lifecycle, PCM and speech-driver contracts, semantic turn handling, barge-in, bounded queues, terminal events and Namzu model bridge.
type: Reference
status: stable
resource: packages/live/src
tags: [live, voice, realtime, reference]
generated: { by: human:bahadirarda, at: 2026-08-31T00:00:00Z }
---

# Live sessions — lifecycle, media contracts and cancellation

`@namzu/live` is Namzu's transport-agnostic live-agent runtime. It does not
wrap or require another agent framework. It composes caller-supplied media
drivers around a `LiveModel`. Its supplied `NamzuModel` implementation sends
each language-model turn through the SDK's ordinary `query()` runtime.

The dependency direction remains one way:

```text
@namzu/sdk ← @namzu/live ← caller media and transport adapters
```

When `NamzuModel` is used, the SDK owns that turn's model run, tools, permission
policy, budgets, stores and telemetry. A custom `LiveModel` is allowed, and its
caller owns those concerns instead. The live package always owns its process-
local conversation history, turn lifecycle, continuous audio ingress, barge-in,
phrase segmentation and its separate `LiveSessionEvent` stream. It does not
project SDK `RunEvent`s or persist/resume the live session itself.
The current peer contract supports SDK 33.1.1 through the 33.x line
(`>=33.1.1 <34`); SDK 34 is outside the declared compatibility range until the
package explicitly widens it.

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

## Session-owned handles

`LiveSession.run()` returns `LiveTurn`, and `LiveSession.listen()` returns
`LiveListening`. They are exported as TypeScript interfaces only, not as
runtime constructors. The session creates and tracks each returned handle
together with its owned turn or ingress task. A structurally matching
caller-created value is not attachable to, or recognized by, a session.

`LiveTurn` exposes its turn id, `wait()` and `interrupt()`. `LiveListening`
exposes `wait()` and `stop()`. Call those methods on the value returned by the
session; there is no independent or reattachable handle lifecycle. A turn wait
resolves with `completed` or `interrupted` and rejects on failure. A listening
wait resolves after clean EOF or manual stop and rejects when ingress, a media
driver, turn detection or an audio-originated response fails.

## Session lifecycle and entry points

A session starts in `idle`. `start(agent)` moves it to `ready` and can succeed
only once. `close()` is idempotent but terminal: a closed session cannot restart.
Only one listening pump may be active. `state` is the current presentation
state, not proof that audio ingress stopped: it can move from `listening` to
`thinking`, `responding` or `speaking` while the pump continues, then return to
`listening` when the response settles.

| Entry point | Default | Required composition | Concurrent work |
|---|---|---|---|
| `run({ userInput })` | `responseMode: 'text'`; `interrupt: true` | A started session; speech mode additionally needs TTS and `AudioOutput`. | A new turn interrupts the active turn by default. Set `interrupt: false` to refuse with `turn_in_progress`. |
| `listen(frames)` | `responseMode: 'speech'` | VAD, STT and `TurnDetector`; speech mode additionally needs TTS and `AudioOutput`. | Continues ingesting while response turns run. A second pump is refused. |

`LiveListening.stop()` stops new audio ingress and asks the source/VAD/STT
iterators to clean up; it does not cancel a response turn already launched.
Natural input EOF flushes VAD/STT, settles turn detection and waits for every
audio-originated response. `LiveSession.close()` is the operation that stops
listening and interrupts all active turns.

## Session options

| Option | Default | Contract |
|---|---:|---|
| `audioBufferMs` | 1,000 | Per-consumer realtime audio queue duration. Overflow is an error. |
| `closeTimeoutMs` | 2,000 | Finite wait used for predecessor settlement, iterator cleanup, EOF flush, synthesis and close. |
| `endOfTurnTimeoutMs` | 2,000 | Maximum wait for a final transcript after `speech_end`. |
| `maxFrameDurationMs` | 100 | Maximum duration represented by one PCM frame. |
| `maxSpeechDurationMs` | 30,000 | Maximum VAD speech interval without `speech_end`. |
| `speechBufferChars` | 1,024 | Maximum queued text waiting for synthesis. |
| `speechChunkChars` | 240 | Forced phrase boundary when punctuation does not arrive. |
| `speechMinimumChars` | 24 | Minimum phrase size before punctuation can flush it. |

Every numeric option must be finite and positive. The phrase values must obey
`speechMinimumChars <= speechChunkChars <= speechBufferChars`.

## Audio frame contract

Every frame declares its wire shape:

| Field | Contract |
|---|---|
| `format` | Interleaved `pcm_s16le` or `pcm_f32le`. |
| `sampleRateHz` | Integer from 8,000 through 192,000. |
| `channels` | Integer from 1 through 8. |
| `samplesPerChannel` | Positive integer; together with the fields above it determines exact byte length and duration. |
| `data` | Exact PCM byte count for the declared shape; drivers treat it as immutable. |
| `sequence` | Optional non-negative safe integer forwarded as source metadata. The runtime does not reorder frames. |
| `timestampMs` | Optional finite source time forwarded as metadata. The caller owns monotonicity and continuity. |

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
   response. A second start before the matching end is refused. VAD owns
   pre-roll and hangover policy.
2. `speech_end` supplies the acoustic endpoint. A maximum speech timer refuses
   an utterance that never ends.
3. `final_transcript` supplies the recognizer's final hypothesis. Its timestamp
   is the end of recognized speech and must fall inside the matching VAD
   inclusive start/end interval. Finals are paired by that shared source
   timeline, not by callback arrival order; overlapping intervals or a shared
   endpoint matching two utterances are ambiguous and refused. Partial
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

`LiveModel` is a small stream contract. It emits text deltas, may emit usage,
and ends with exactly one `completed` or `cancelled` terminal event. The
terminal event must be last. A completed turn needs at least one non-empty text
delta; `completed.result` is terminal metadata and does not replace streamed
text. The model receives the turn signal and must stop or reach a terminal
event when it is aborted. Protocol violations reject the turn with
`model_protocol_error`.

`NamzuModel` implements that contract with public SDK `query()`. A custom
`LiveModel` does not implicitly gain SDK tools, policy, stores, budgets or
telemetry; its host must supply those semantics itself.

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

When using `NamzuModel`, register tools only in the `ToolRegistry` inside
`NamzuQueryConfig`. The live runtime has no parallel tool registry or executor,
so a model-authored tool call has one authority and one execution record.

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

`SynthesizedAudio.final` and `text` are driver metadata passed through to
`AudioOutput` and live events. They do not close synthesis; iterable EOF is the
lifecycle boundary. An `assistant_audio` event is emitted only after the
awaited `AudioOutput.write()` accepts the frame.

`AudioOutput.write()` resolves when the caller's output accepted a synthesized
frame. `AudioOutput.cancel(turnId, reason)` is required because accepting audio
is not the same as playing it. On interruption the session aborts model and
synthesis work, calls `cancel`, increments its generation fence and discards
every late chunk. If output cancellation fails, the turn fails instead of being
reported as cleanly interrupted when that rejection arrives before the bounded
cleanup deadline. Once the deadline force-settles interruption, later driver
failures stay fenced. The session commits an assistant message to history only
after the model, synthesizer and output writes complete. The history therefore
means "generated and accepted", never "heard by a participant".

## History, events and errors

`history` returns a snapshot of process-local state. A valid user submission is
appended before model work, so it remains present even if the turn is later
interrupted or fails. Assistant text is appended only on a completed turn; in
speech mode that is after synthesis and output acceptance. There is no built-in
live-session persistence, checkpoint or resume store.

`onEvent(listener)` observes subsequent events synchronously and returns an
unsubscribe function. Listener exceptions are isolated from the realtime
pipeline. Events cover state changes, turn start/text/usage/audio, exactly one
turn terminal outcome (`turn_completed`, `turn_interrupted` or `turn_failed`),
VAD/transcript observations and listening failure. This is a live-package
event contract, not the SDK `RunEvent` protocol.

| Error group | Public `LiveErrorCode` values |
|---|---|
| Session and call state | `session_not_started`, `session_already_started`, `session_closed`, `already_listening`, `turn_in_progress`, `turn_interrupted`, `invalid_user_input` |
| Missing composition | `missing_voice_activity_detector`, `missing_speech_recognizer`, `missing_turn_detector`, `missing_speech_synthesizer`, `missing_audio_output` |
| Media and driver boundary | `audio_frame_invalid`, `audio_buffer_overflow`, `invalid_driver_event`, `speech_too_long`, `transcript_timeout`, `driver_close_timeout`, `incomplete_utterance` |
| Model bridge | `model_protocol_error`, `query_failed`, `run_not_speakable`, `unsafe_query_config` |

Synchronous configuration/call errors throw immediately. Turn and listening
failures reject their handle's `wait()`. A third-party driver may reject with
its own `Error`; not every failure is rewritten as `LiveError`.

## Shutdown

Model, VAD, STT, turn-detection and TTS calls receive an `AbortSignal`, but
shutdown does not assume every third-party driver behaves. Session close asks
the source, VAD and STT iterators to return, aborts model/synthesis work, fences
late yields and stops waiting after `closeTimeoutMs` (2,000ms by default). It
then resolves without claiming a hostile third-party task actually cleaned up.
A stale task can no longer publish into a later turn.

The Namzu model stream is intentionally different: after abort it keeps
draining `query()` until the SDK returns its terminal cancelled `Run`. That
preserves run-store and telemetry truth instead of abandoning a run in the
`running` state.

`close()` is idempotent and makes the session permanently closed. A close that
reaches its deadline settles unresolved turn handles as interrupted and the
listening handle as stopped; late text or audio remains fenced.

## Deliberate boundaries

- Room/RTC transport, telephony, noise cancellation and worker deployment are
  caller adapters, not hidden dependencies.
- Local VAD/STT/TTS/model inference can implement the same driver contracts;
  no local model or checkpoint is bundled.
- Native speech-to-speech is a future `LiveModel`/media-driver shape, not a
  capability claimed by the text-turn bridge.
