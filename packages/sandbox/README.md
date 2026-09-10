<!-- okf
type: Reference
title: "@namzu/sandbox"
description: >-
  Container and process isolation for Namzu runs. Two isolation tiers over
  four backends, a bounded filesystem view, and an egress boundary the run
  cannot talk its way past.
tags: [readme, package, sandbox, isolation]
status: stable
generated: { by: human:bahadirarda, at: 2026-08-30T00:00:00Z }
-->

<div align="center">

<h1>@namzu/sandbox</h1>

**Container and process isolation for Namzu runs.**

[![npm](https://img.shields.io/npm/v/@namzu/sandbox.svg)](https://www.npmjs.com/package/@namzu/sandbox)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Runs a tool call somewhere that is not your process. Two isolation tiers
over four backends, a bounded filesystem view, and an egress boundary the
run cannot talk its way past.

## Install

```bash
pnpm add @namzu/sdk @namzu/sandbox
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import { createSandboxProvider } from '@namzu/sandbox'

declare const taskId: string

const provider = createSandboxProvider({
  backend: {
    tier: 'container',
    runtime: 'docker',
    image: 'namzu-sandbox:latest',
    network: 'namzu-tasks',
    labels: { 'example.task-id': taskId },
  },
  layout: {
    outputs: { source: { type: 'hostDir', hostPath: `/srv/tasks/${taskId}/outputs` } },
    uploads: { source: { type: 'hostDir', hostPath: `/srv/tasks/${taskId}/uploads` } },
  },
  defaultEgress: { kind: 'static', allowedHosts: ['api.example.com'] },
  defaultMemoryLimitMb: 1024,
  defaultMaxProcesses: 128,
})
```

## Protocol readiness and cancellation

Pass `SandboxExecOptions.signal` to stop a command on any shipped backend. A
remote host reserves every command before admission and the container worker or
microVM guest confirms process-group termination over a separate cancellation
request; stopping the data-stream wait alone is never reported as stopping the
command. A stalled execution stream is bounded relative to the requested
command timeout and reconciled through that same control path. An unconfirmed
stop fences the handle and retires the whole container, container group, or
microVM; a confirmed stop with an incomplete terminal stream is reported
separately so callers do not mistake partial output for an unknown process
outcome.

Remote peers retain terminal ids briefly for idempotent cancellation, but evict
the oldest terminal history before refusing new work. If a command leader exits
while descendants remain, the peer fences itself and retires the whole sandbox
instead of signalling a numeric process-group id that the kernel could reuse.
Concurrent destroy and automatic-retirement calls share one checked teardown;
Docker removal is never reported as accepted after a non-zero or aborted
`docker rm -f`.

Every worker and microVM guest publishes its wire-protocol version in the
readiness response. The host admits only the exact version implemented by its
release; missing, older, and newer versions fail before a sandbox handle or
command is returned. There is no identity-less legacy execution path. For a
standby pool, publish a new container group profile revision containing the
matching worker before deploying the host; for a microVM deployment, rebuild
and validate its golden guest image from the same release. Firecracker hosts
can import `FIRECRACKER_AGENT_PROTOCOL_VERSION` to apply the same admission
check in their own warm-pool probe.

Roll the coupled Firecracker artifacts in this order: build the guest agent
from the target Namzu release, publish and canary a golden image containing
that agent, then deploy hosts that require its protocol version. Keep the
previous host and golden-image pair available together for rollback. Rolling
back only one side is intentionally rejected at readiness, so a mismatched
guest never accepts work under an unverified wire contract.

## Firecracker workspace channels

The Firecracker backend exposes two optional same-sandbox channels. Call
`sandbox.openTerminal()` for an interactive pseudo-terminal whose process tree
is owned by the guest. The returned `TerminalSession` supports input, output,
resize and close without substituting host pipes for terminal semantics. Call
`sandbox.openTcpConnection()` to reach an IPv4 or IPv6 loopback service inside
that same guest. Its `SandboxTcpConnection` exposes bounded write/backpressure,
incoming-data pause and resume, half-close and final closure. This channel can
publish a development server or WebSocket preview without moving the checkout
to another runtime or widening guest egress.

Both methods are capability-checked. A backend that cannot preserve the same
isolation and ownership boundary omits them; callers must not fall back to a
host process or a different sandbox.

## Firecracker network policy

At microVM creation, the Firecracker backend maps the resolved egress decision
to an explicit orchestrator policy: deny-all becomes `none`, allow-all becomes
`open`, and a static or resolved host list becomes `allowlist` with the exact
allowed hosts. An omitted egress setting retains the orchestrator's legacy
no-interface behavior. In particular, an empty resolved allowlist remains an
explicit deny-all decision rather than collapsing to an absent policy.

`sandbox.setNetworkPolicy()` remains the live-sandbox contract for backends
that can change egress after admission. A backend must throw when it cannot
enforce a requested live policy; accepting without applying it would erase the
security boundary the host relied on.

## Documentation

- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
