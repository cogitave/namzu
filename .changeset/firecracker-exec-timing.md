---
"@namzu/sandbox": minor
---

Three additive declarations, no default changed and nothing removed:

- `MicroVMBackendConfig.onExecTiming` — the owned Firecracker tier's provider
  config gains an optional per-exec timing hook.
- `FirecrackerTransportTiming` — exported from the package entry point, the
  shape that hook is called with.
- `VsockTransportOptions.onExecTiming` — the same hook at the transport level,
  for a host that builds a `VsockAgentTransport` itself.

A host that sets none of them sends, receives and waits for exactly what it did
before: the timing accumulator is created only when the hook is set, and the
`undefined` checks that skip creating it skip every clock read that would have
filled it.

The hook reports one `exec()`'s wall clock as named phases — `dialMs`,
`reserveMs`, `executeMs` and `drainMs`, the four the Kubernetes tier's
`onTiming` already reports, plus `firstFrameMs`, `terminatorMs` and
`peerCloseMs` for the intervals inside the execute round trip. The three
sub-phases are absent, rather than zero, when their phase was never reached; the
four base phases are always present and use `0` for "this never happened" (a
call that failed at the dial reports `executeMs: 0`). The payload is durations
only: never the agent token, a command, its arguments, or any output.

One behaviour change worth naming, because it is the reason the hook is useful:
the transport's execution adapter and its `RemoteExecutionController` are now
built per call instead of once per transport. That controller holds no per-call
state, so nothing observable changes — but an adapter built once had nowhere
per-call to accumulate into, and a single accumulator on the transport would
have two concurrent `exec()` calls writing each other's phases. The Kubernetes
tier's own transport has been arranged this way since it was written.

`POST_RESPONSE_CLOSE_TIMEOUT_MS` (1 s) is unchanged and its behaviour is
unchanged; it is now documented as what it always was — a reject-only guard
that fails a socket whose peer never closes, never a wait a successful call
pays. If your host puts a relay between this process and the guest, `peerCloseMs`
is the number that tells you whether that relay holds the FIN: a hold **under**
a second is reported there on a call that resolved, and a hold **at or past**
a second fails the call with `vsock transport: exec peer did not close after
terminator`, reporting no `peerCloseMs` at all — the close in that case is the
one this transport causes itself when the guard fires, and its own constant is
not published as an elapsed time. So a resolved exec's fixed cost cannot be
hiding in that window: whichever way the window goes, it is either reported or
it is a rejection, and never a silent second.
