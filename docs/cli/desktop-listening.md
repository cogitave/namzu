---
type: Guide
title: Desktop local listening
description: The on-device Turkish speech recognition and voice-activity engine in Namzu Desktop - what it downloads, where it is stored, how it runs, and the adapters that plug it into a live session.
resource: packages/desktop/src/main/local-listening.ts
tags: [cli, desktop, voice, speech]
status: draft
---

# Desktop local listening

Local listening turns microphone audio into Turkish text on the machine. No audio, transcript
or model request leaves it. This page covers the engine in Desktop's main process. Microphone
capture, the settings page and the live session that uses it are later work, so nothing in
the interface calls it yet.

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
