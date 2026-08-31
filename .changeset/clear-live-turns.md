---
'@namzu/live': minor
---

Add the independent `@namzu/live` runtime with live agents and sessions,
pluggable VAD/STT/turn-detection/TTS/audio-output drivers, continuous bounded
audio ingress, barge-in cancellation, and a `NamzuModel` bridge that keeps SDK
tools, policy, run stores and telemetry authoritative. Public turn/listening
handles are created and tracked by their session, and independent speech
drivers correlate final transcripts to VAD intervals by their shared source
timestamp instead of callback order. The initial package supports
`@namzu/sdk` versions from 33.1.1 through the 33.x line.
