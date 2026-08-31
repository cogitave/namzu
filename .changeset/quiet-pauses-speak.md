---
'@namzu/sdk': minor
'@namzu/cli': minor
---

Carry structured failure, provider and remediation metadata on resumable
`run_paused` events. Current driver `ProviderRequestError` throttles now retain
their retryability, status and retry delay at the terminal run boundary instead
of being projected as unknown.

The CLI exposes a distinct `paused` AgentEvent with checkpoint identity,
renders actionable classified interruptions, holds dependent queued work, and
prevents `namzu run` or ACP from treating a resumable stop as silent success.
`run-stream` forwards the structured pause before its terminating `done` event.
