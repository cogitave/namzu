---
"@namzu/sandbox": minor
---

`SandboxAgentHandle` (re-exported from the package's public entry point)
gains a fourth arm: `{ kind: 'tcp', host, port, token }`. `VsockAgentTransport`
(also public) gains a new `executeStreamed()` method, and its
`VsockTransportOptions` gain an optional `onDial` callback. All three
changes are additive and backward compatible — existing `unix`/`vsock`/`mtls`
handles, existing `VsockAgentTransport` callers, and the guest protocol are
untouched (`firecracker/__tests__/transport.test.ts` passes unmodified) — but
they are genuinely new surface in the compiled `.d.ts`, not yet constructible
by anything outside `packages/sandbox/src/backends/` until a later workstream
wires the kubernetes backend up to them.

Alongside this, a new (package-internal, not yet exported) `KubernetesAgentTransport`
in `src/backends/kubernetes/transport.ts` dials the guest agent (`agent/agent.cjs`)
directly over a routed pod network for the upcoming kubernetes backend.

The `tcp` dialer is a plain `net.connect({ host, port })` per call — no
routing preamble, no ack, no cached socket or IP — so a `host` that is a
Kubernetes Service FQDN is re-resolved on every request and a resumed
pod's new address costs nothing extra. The handle's optional `token`
rides in each request envelope (the credential field the guest agent
already accepts); a wrong token surfaces as a named
`KubernetesAgentUnauthorizedError` rather than a generic protocol error.

Because every `tcp` request dials a fresh connection, that connection's
first frame is also the one the guest agent has not authenticated yet,
so it is bound by the agent's pre-auth frame ceiling (8 MiB by default)
on every call, not just on first use. This transport now checks an
outgoing envelope's size against that ceiling BEFORE dialing and throws
a named `AgentPreauthFrameTooLargeError` naming the limit, instead of
opening a connection the agent would refuse anyway. Chunking a large
`write-file` body across multiple frames is a documented follow-up, not
implemented here.

`KubernetesAgentTransport` also accepts an optional `onTiming` callback
reporting a completed `exec()` call's dial/reserve/execute/drain
durations (never the token, command, or output), so the kubernetes
backend's sub-second warm-acquire target can be measured rather than
assumed.
