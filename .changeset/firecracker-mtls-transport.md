---
'@namzu/sandbox': minor
---

Add an `mtls` arm to the Firecracker agent transport for the cross-host
client-proxy bridge.

`SandboxAgentHandle` gains a third variant —
`{ kind: 'mtls'; host; port; sandboxId; tls: { ca; cert; key; servername? } }` —
alongside the existing `unix` and `vsock` arms. When the orchestrator runs on a
different host from the caller (the owned-fleet production path), the host-local
`v.sock` is unreachable over the network, so the dialer instead `tls.connect()`s
to a per-FC-host mTLS relay, writes a `SANDBOX <sandboxId>\n` preamble, and then
runs the IDENTICAL length-framed NDJSON loop. The relay terminates mTLS and
bridges to the jailed `v.sock` (issuing the guest `CONNECT 1024` handshake
itself), so one inbound mTLS connection maps to one fresh local `v.sock`
connect — preserving the resume-survival property of opening a fresh connection
per request.

The change is purely additive: the `unix` and `vsock` arms and all framing,
heartbeat, and reconnect-on-resume code are byte-for-byte unchanged (single-host
deployments keep using `vsock`). The TLS material is injected by the consumer
(never returned by the orchestrator), keeping the package free of any key
management.
