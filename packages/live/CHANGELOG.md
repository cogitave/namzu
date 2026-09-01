# @namzu/live

## 1.0.0

### Minor Changes

- 4c5728f: Add the independent `@namzu/live` runtime with live agents and sessions,
  pluggable VAD/STT/turn-detection/TTS/audio-output drivers, continuous bounded
  audio ingress, barge-in cancellation, and a `NamzuModel` bridge that keeps SDK
  tools, policy, run stores and telemetry authoritative. Public turn/listening
  handles are created and tracked by their session, and independent speech
  drivers correlate final transcripts to VAD intervals by their shared source
  timestamp instead of callback order. The initial package supports
  `@namzu/sdk` versions from 33.1.1 through the 33.x line.

### Patch Changes

- ad1bab9: Document the supported SDK range, process-local history, custom-model
  ownership, driver lifecycle and session-tracked turn and listening handles.
- Updated dependencies [ad1bab9]
- Updated dependencies [7347b8d]
- Updated dependencies [4c31053]
  - @namzu/sdk@34.0.0

All notable changes to this package are documented through repository Changesets.
