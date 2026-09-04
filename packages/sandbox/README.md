<!-- okf
type: Reference
title: "@namzu/sandbox"
description: >-
  Container and process isolation for Namzu runs. Two isolation tiers over
  four backends, a bounded filesystem view, and an egress boundary the run
  cannot talk its way past.
tags: [readme, package, sandbox, isolation]
timestamp: 2026-08-30T00:00:00Z
status: active
diataxis: reference
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

## Documentation

- [The sandbox — tiers, backends, mounts and the egress boundary](https://github.com/cogitave/namzu/blob/main/docs/packages/sandbox.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
