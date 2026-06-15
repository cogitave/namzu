---
'@namzu/sandbox': minor
---

Add the owned-Firecracker microVM backend (`microvm:self-hosted`) and its
host-side vsock transport.

The `MicroVMBackendConfig` `self-hosted` arm gains the owned-platform seam:
`orchestratorEndpoint` + `getToken` (the ACI `getArmToken` closure pattern, so
the package keeps zero Azure-SDK deps) route to a new `backends/firecracker/`
backend instead of throwing `SandboxBackendNotImplementedError`; `template`
selects the golden snapshot revision and `agentVsockPort` /
`readyTimeoutMs` / `readyPollIntervalMs` tune the agent dial. The legacy local
`firecracker-containerd` shape (the three image fields alone) still throws.

The backend is a sibling of `docker/` and `aci-standby-pool/` and a
remote-copy backend like ACI (workspace seeded by archive-sync over the control
channel, no host bind-mounts). It speaks the SAME NDJSON exec-stream + base64
file-IO wire as the docker/ACI HTTP worker — only the transport differs:

- One wire contract, factored into `backends/firecracker/protocol.ts`
  (`ExecRequest`, the `stdout_delta`/`stderr_delta`/`result`/`error` `ExecEvent`
  union, `ReadFileRequest`/`WriteFileRequest` + responses, the
  `ExecResultAccumulator` and `parseExecLine` the docker loop inlines today).
- Two transports: HTTP for docker/ACI (UNCHANGED), and a NEW framed-over-vsock
  transport for FC (`backends/firecracker/transport.ts`), because across an FC
  snapshot resume a TCP control channel is dead-on-arrival while the vsock
  LISTEN socket survives (FC `snapshot-support.md`). Node `fetch` cannot dial
  AF_VSOCK, so the dialer, length-framing, heartbeat, and the
  reconnect-on-resume hardening (per-attempt connect/handshake timeout + retry
  budget to survive the FC #4713 `TRANSPORT_RESET`-not-delivered hang) are new.

New public exports from `@namzu/sandbox`: `VsockAgentTransport`,
`SandboxAgentHandle`, `VsockTransportOptions`, `FirecrackerBackendInternalConfig`,
`OrchestratorTokenProvider`. The in-VM agent source (`agent/agent.cjs`, a vsock
server reusing the worker spawn/jail + NDJSON shapes verbatim with the mandatory
pre-ready entropy reseed) ships in the repo as a golden-rootfs build input,
mirroring how `worker/server.js` is baked into the docker image — it is not a
published runtime dependency.
