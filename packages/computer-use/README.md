<!-- okf
type: Reference
title: "@namzu/computer-use"
description: >-
  Screen capture, keyboard and pointer control behind one adapter interface.
  Which backend serves a call depends on the platform, and what a platform
  cannot do is reported as a capability rather than discovered as a failure.
tags: [readme, package, computer-use, adapters]
timestamp: 2026-08-20T00:00:00Z
status: active
diataxis: reference
-->

<div align="center">

<h1>@namzu/computer-use</h1>

**Screen, keyboard and pointer control for Namzu agents.**

[![npm](https://img.shields.io/npm/v/@namzu/computer-use.svg)](https://www.npmjs.com/package/@namzu/computer-use)
[![build](https://github.com/cogitave/namzu/actions/workflows/ci.yml/badge.svg)](https://github.com/cogitave/namzu/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-FSL--1.1--MIT-blue.svg)](https://github.com/cogitave/namzu/blob/main/LICENSE.md)

[Install](#install) · [Usage](#usage) · [Documentation](#documentation)

</div>

---

Screen capture, keyboard and pointer control, behind one adapter interface.
Which backend serves a call depends on the platform, and what a platform
cannot do is reported as a capability rather than discovered as a failure.

## Install

```bash
pnpm add @namzu/sdk @namzu/computer-use
```

`@namzu/sdk` is a peer dependency. Install both.

## Usage

```ts
import {
  SubprocessComputerUseHost,
  type SubprocessComputerUseHostOptions,
} from '@namzu/computer-use'
import { createComputerUseTool, ToolRegistry } from '@namzu/sdk'

const options: SubprocessComputerUseHostOptions = {
  env: process.env,
  platform: process.platform,
}
const host = new SubprocessComputerUseHost(options)
await host.initialize()

console.log(host.capabilities)
// {
//   displayServer: 'darwin',
//   screenshot: true,
//   mouse: true,
//   keyboard: true,
//   cursorPosition: false,  // unless `cliclick` is installed
//   clipboard: true,
// }

const registry = new ToolRegistry()
registry.register(createComputerUseTool(host))
```

If a click, drag, scroll, text entry or key subprocess starts but does not
report a clean completion, the host throws
`ComputerUseOutcomeUnknownError`. The desktop may already have changed; the
SDK returns that state to the model with `retrySafety: 'unsafe'` instead of
inviting an automatic replay.

When Namzu runs inside WSL, the host selects the paired Windows desktop and
uses `powershell.exe` through WSL interop. This takes precedence over WSLg's
`DISPLAY`/`WAYLAND_DISPLAY`, which describe Linux GUI applications rather than
the Windows desktop containing the terminal.

## Documentation

- [Computer use — the platform matrix, capability flags and error surface](https://github.com/cogitave/namzu/blob/main/docs/packages/computer-use.md)
- [Namzu docs](https://github.com/cogitave/namzu/tree/main/docs)

## License

FSL-1.1-MIT, converting to MIT two years after each release.
