# Local Turkish speech verification

EMA Lightning is integrated as opt-in Desktop speech, not a second agent loop.
The model is pinned to Hugging Face revision
`7a6ba1ad216bb2f1da9863f80ac8770a6a807632` and the EMA 1.0.1 wheel to source
revision `129e39c7d9feb56de9c6830e94a630f04fc8aa03`. The production worker loads
verified weights with `weights_only=True` and runs on CPU without Hub access.

## Actual Windows evidence

- `artifacts/native-unicode-pipe-proof.json`: the original isolated Windows
  Python pipe used cp1252 and corrupted Turkish characters. Explicit `-X utf8`
  preserves the exact fixed sample. Environment-only Python flags are insufficient
  because the worker uses `-I` isolation.
- `artifacts/native-sample-rate-proof.json`: the restricted loader predicts
  86 frames / 3.44 seconds for the fixed sample; actual 48/24 kHz streams have
  exactly proportional sample counts. This checks resampling independently of
  the Desktop pipe and does not rate pronunciation.
- `artifacts/native-cpu-proof-corrected.json`: real corrected worker generation,
  19 bounded PCM frames, 3.44 seconds of speech. First audio took about 3.63 seconds
  from a cold worker on this device; timings are observations, not guarantees.
  Inference reused the approved installation. Its approximately 51.16-second
  initial download/install time is recorded separately from that verification.
- `artifacts/native-renderer-preview.json`: the updated native Desktop's **Preview
  voice** button drove real EMA generation and WebAudio. All 19 audio sources
  ended before the backend completed; the voice preference remained disabled.
  Message bodies, draft and selected model were preserved. The actual popup is
  `artifacts/native-voice-settings.png`.

The model files total 34,389,147 bytes. Retained runtime wheels total 159,434,971
bytes; the installed isolated environment occupies 933,877,163 bytes. Native
playback observed approximately 323 MiB worker RAM, excluding Desktop and system
Python. GPU memory is not used. CPU measurements are relative to one core and
include their measured sampling interval; they are not machine requirements.

The initial `artifacts/native-cpu-proof.json` is explicitly superseded because
its input crossed the faulty cp1252 pipe. It is retained as diagnostic evidence.
The first Node-only installation also encountered a certificate-trust failure;
its task-owned incomplete runtime was safely removed, preserving the completed
installation. Production downloads use Electron Chromium's native trust/proxy
policy with TLS verification enabled.

## Renderer/reference evidence

`renderer-proof.mjs` checks the actual renderer and WebAudio using synthetic PCM
at wide, narrow and small widths, including owner cancellation, played-frame
acknowledgements, errors outside a closed popover and unique split-pane labels.
See `artifacts/renderer-proof.json`. The speech popup alone fits 390 px; the full
native application has its separate 560 px minimum window contract.

`wai-reference-observation.mjs` inspected the existing WAI UI with its seeded
mock conversation. `artifacts/wai-reference.json` records measured work disclosure
and action-row geometry; it establishes UI behavior, not agent execution.
Transcript journal/browser/native evidence is tracked in
[the transcript verification](../transcript-search-timing-20261007/README.md).

## Scope

No provider prompt, user-message speech, guest computer action or paid model was
used in these speech checks. The only spoken content was the fixed preview:
“Merhaba! Ben Namzu. Türkçe seslendirme bu cihazda çalışıyor.” Actual audio nodes
played; speaker audibility and subjective Turkish pronunciation were not rated.
Microphone recognition and automatic voice conversation are outside this change.
Private authored transcripts and WAV files stay in the local Development folder.

Native helpers are specific to this approved Windows development installation.
They use fresh output receipts and keep their original evidence. Do not treat
them as a general installer or use them against another user's profile.
