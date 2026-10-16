---
type: Guide
title: Desktop voice input
description: Voice input in Namzu Desktop - the on-device Turkish speech recognition engine, microphone capture and consent, how speech becomes a normal message, stop words, barge-in, and what stays on the computer.
resource: packages/desktop/src/main/local-listening.ts
tags: [cli, desktop, voice, speech]
status: draft
---

# Desktop voice input

Voice input turns what you say into a normal message. The microphone is captured in the window,
turned into Turkish text in Desktop's main process, and sent exactly as typed text would be.
No audio, transcript or model request leaves the computer. The engine (below) is an optional
download; the sections after it cover capture, consent, how speech becomes a message, and
what voice can never do.

## What it downloads

Listening is **never installed implicitly**. The download starts only from an explicit action
(`LocalListeningService.install()`), reports progress, can be cancelled, and can be removed again.

| File | Size | Role |
|---|---|---|
| `turbo-encoder.int8.onnx` | 674,716,297 bytes | speech model, encoder |
| `turbo-decoder.int8.onnx` | 361,080,764 bytes | speech model, decoder |
| `turbo-tokens.txt` | 816,730 bytes | speech model vocabulary |
| `silero_vad.onnx` | 643,854 bytes | voice-activity model |

The total is 1,037,257,645 bytes (about 989 MiB). The three speech files come from a pinned
revision of the speech model host; the voice-activity file comes from the engine's release page.
`packages/desktop/src/main/local-listening-assets.ts` pins every URL, size and SHA-256.

A file is streamed to a temporary name, checked for exact size and digest, and only then
renamed into place. A partial, oversized or mismatched file is deleted and never used. An
interrupted install resumes at file granularity: finished files that still hash correctly are
kept. Removing listening deletes only the files the installer wrote.

## Where it is stored

`<userData>/local-listening/models/` holds the four files, and `installation.json` beside it
records the pinned revision, sizes and digests. At startup the service reads sizes only, so a
damaged or incomplete copy shows as failed and asks for a new download.

## How it runs

Inference uses `sherpa-onnx-node` (pinned to an exact version) loaded in-process, with no Python.
It runs in two `worker_threads` workers, so a decode of about a second never blocks the main
process: one thread holds the voice-activity streams and answers while the other thread decodes.
Each loads its model lazily on first use. The speech model unloads after an idle time (five
minutes), and the whole engine after the last open audio session closes and the same idle time
passes. Zero keeps it loaded.

Bounds: one voice-activity piece is at most one second; a recognition input is at most 33
seconds (a 30-second utterance plus roll and tail); at most eight recognitions wait behind the
running one; at most four audio sessions are open. A native decode cannot be interrupted, so an
aborted decode finishes in the background and its text is dropped; a queued one is never sent.

The speech language is Turkish. Numbers stay as the model writes them (digits).

## The live-session adapters

`LocalVoiceActivityDetector` and `LocalSpeechRecognizer` are structural implementations of the
live package's `VoiceActivityDetector` and `SpeechRecognizer`, the way `LocalSpeechSynthesizer`
is for output, so Desktop takes no new runtime import.

- Both accept only 16 kHz mono frames (`pcm_s16le` or `pcm_f32le`) and say so plainly otherwise.
- The detector emits `speech_start` and `speech_end` with `timestampMs` on the source timeline
  (the first frame's `timestampMs`, then the sample count).
- The recognizer cuts one utterance per segment with about 400 ms before and up to 500 ms after,
  adds 500 ms of silence at the tail (the decoder otherwise drops the end of short audio), and
  emits one `final_transcript` with `language: "tr"`. Its `timestampMs` is the middle of the
  segment, so it falls inside the detector's interval, which the session requires to match them.
  Blank results emit nothing. There are no partial transcripts.
- Both honour the context's abort signal.

## Packaging

The installer carries the Windows x64 runtime package. The worker script and both engine
packages are unpacked from the app archive (`asarUnpack`), because a native addon and a worker
thread cannot start from inside it. `scripts/stage-installer.mjs` selects the platform package
with `--os=win32 --cpu=x64` and fails if the addon is missing.

## Using it

The microphone is a quiet icon in the composer. It is unavailable, with the reason on hover,
until voice input is downloaded (pressing it then opens Settings, Speech, Voice input) and until
the conversation has a first message. States: off; starting; listening (a dot shows the
microphone is open); hearing you (the dot pulses); writing down what you said. A line under the
composer always says so while the microphone is open.

**Voice input** in Settings, Speech, sits beside the read-aloud voice: Turkish, the download size
("about 1 GB"), progress, Cancel download, Remove, a plain sentence with Try again on failure, and
a switch for the microphone agreement.

## Consent

Pressing the microphone for the first time shows a short in-app agreement: Namzu listens only
while the microphone is on; audio stays on this computer; what you say is sent as a message, the
same as typing it; voice cannot approve actions. Accepting is saved as `voiceInputAccepted` in
`desktop-settings.json` (default `false`) and is withdrawn from the same switch in Settings.

Electron grants every page permission by default, so Desktop installs
`session.setPermissionRequestHandler` and `setPermissionCheckHandler` that change **only** the
microphone (`media`): it is granted solely to Desktop's own main windows (their main frame, on
the app's own page), for audio only (any request that includes video is refused), and only after
the agreement above. Every other permission is answered exactly as before. The logic is in
`packages/desktop/src/main/media-permissions.ts`.

## Capture

The window asks for audio with echo cancellation, noise suppression and automatic gain, one
channel, and routes it through an `AudioWorklet` loaded from a real file
(`public/voice-capture-worklet.js`, copied beside the page by the build). The page's script policy
(`script-src 'self'`) therefore already allows it; no `eval`, string or `blob:` source is used. The
worklet only hands 20 ms blocks of samples to the window, which resamples them to 16 kHz mono
with a windowed-sinc low-pass (a tone above 8 kHz is removed, not folded into the speech band),
regroups them into about 100 ms chunks and sends them to main. The tracks are stopped and the
audio context closed whenever listening stops.

Main checks every chunk: a `Float32Array` of 1 to 8,000 samples, every value finite and within
range, at most about real time (a two-second burst budget refilling at 1.5 times real time),
from the window that owns the conversation, for the conversation that is listening. A bad chunk
is refused and a flood ends the session.

## From speech to a message

The chunks feed the voice-activity detector and the recognizer side by side. The final
transcripts of consecutive speech segments are collected; once the last segment ends and no new
speech starts within **800 ms** (**1600 ms** when the text so far ends with `ve`, `ama`, `fakat`,
`sonra`, `ile`, `veya`, `ya da`, `çünkü`, `ki`, `da` or `de`), the message is complete. It also
waits for a transcript still being worked out. Both delays are options.

Then, in order:

1. **Stop words alone** (`dur`, `durdur`, `iptal`, `vazgeç`, `stop`, ignoring case, accents and
   punctuation, Turkish-aware) stop the running reply and send nothing. They work even while a
   question is waiting.
2. While that conversation has a **permission or decision prompt waiting**, nothing is sent and
   the window says plainly that the question must be answered on screen. **Voice never answers a
   permission or decision prompt.**
3. Otherwise it is sent as the composer sends typed text with nothing attached (`Operator.sendSpoken`):
   the conversation's saved model choice and message settings, a new turn when idle, and
   current-turn input (or the queue) while a reply runs. Permissions, Pals and model routing
   apply unchanged. No field marks the message as spoken.

## Speaking back

When a reply that was started by voice finishes, and the local read-aloud voice is installed and
switched on, the window reads the final answer aloud through the same read-aloud the message
button uses. Otherwise nothing extra happens. **Barge-in:** speech that lasts 300 ms while a reply
is being read aloud stops the reading at once. It never stops the agent's work; only a stop word does.

## When listening stops

Per window and conversation, listening stops on: the microphone button, a switch to another
conversation, the window closing or reloading, the app quitting, the computer sleeping or being
locked, removing voice input, and any capture error (a plain sentence says why). The microphone is
closed every time.

## Privacy

Audio is never written to disk and never sent anywhere; models run in this process's worker
threads. Transcripts are not logged. Diagnostics record only the name of a failed operation.
