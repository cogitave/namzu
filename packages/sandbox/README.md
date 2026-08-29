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

## Cancellation and worker compatibility

Pass `SandboxExecOptions.signal` to stop a command on the local-container or
standby-container backend. The host reserves the command before admission and
the worker confirms process-group termination over a separate cancellation
request; stopping the HTTP wait alone is never reported as stopping the
command. A stalled execution stream is bounded relative to the requested
command timeout and reconciled through that same control path. An unconfirmed
stop retires the worker; a confirmed stop with an incomplete terminal stream is
reported separately so callers do not mistake partial output for an unknown
process outcome.

The cancellation path requires a worker image built from the same release. A
current host and worker remain compatible with legacy no-signal execution, but
a signal sent to an older image is refused with a rebuild instruction. For a
standby pool, publish a new container group profile revision containing the
current worker before enabling cancellation. The framed microVM backend has a
separate guest protocol and does not yet honour this option.

## Documentation

- [The sandbox — tiers, backends, mounts and the egress boundary](https://github.com/cogitave/namzu/blob/main/docs/packages/sandbox.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
