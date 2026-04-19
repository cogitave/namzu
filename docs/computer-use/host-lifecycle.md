---
title: Host Lifecycle
description: Lifecycle of SubprocessComputerUseHost, including detection, initialization, capabilities, direct execution, and disposal.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/computer-use", "@namzu/sdk"]
---

# Host Lifecycle

`SubprocessComputerUseHost` is the concrete host implementation published by `@namzu/computer-use`. This page explains how it behaves over time so integrations can initialize it correctly and recover from host-level problems without guesswork.

## 1. Lifecycle Stages

The host has four practical stages:

1. construction
2. initialization
3. execution
4. disposal

Understanding these stages matters because capabilities are not fully available until initialization completes.

## 2. Construction

```ts
import { SubprocessComputerUseHost } from '@namzu/computer-use'

const host = new SubprocessComputerUseHost()
```

At construction time:

- the host detects the display server
- no adapter is loaded yet
- feature flags stay false except for the detected `displayServer`

That means `host.capabilities` is only partially meaningful before `initialize()`.

## 3. Initialization

```ts
await host.initialize()
```

Initialization does the real environment binding:

- loads the platform-specific adapter
- probes what actually works on the current machine
- freezes the capability map for the current host session

If initialization fails, the failure is usually operational:

- required CLI is missing
- the display server is unsupported
- permissions are missing

## 4. Capabilities Are Frozen

After initialization, `host.capabilities` becomes the contract the tool wrapper uses.

Example shape:

```ts
{
  displayServer: 'darwin',
  screenshot: true,
  mouse: true,
  keyboard: true,
  cursorPosition: false,
  clipboard: true,
}
```

Important behavior:

- the map is frozen for that host instance
- if you install missing binaries mid-session, the host does not re-probe automatically
- recreate the host when the underlying environment changes

## 5. Direct Host Usage

You can execute actions directly against the host:

```ts
await host.initialize()

const result = await host.execute({ type: 'screenshot' })
if (result.type === 'screenshot') {
  console.log(result.result.width, result.result.height)
}
```

This is useful for:

- host diagnostics
- adapter tests
- building wrappers around the SDK tool surface

## 6. SDK Tool Integration

Most applications should wrap the host as a tool:

```ts
import { ToolRegistry, createComputerUseTool } from '@namzu/sdk'
import { SubprocessComputerUseHost } from '@namzu/computer-use'

const host = new SubprocessComputerUseHost()
await host.initialize()

const tools = new ToolRegistry()
tools.register(createComputerUseTool(host))
```

That gives you:

- capability-aware tool descriptions
- standard `ToolResult` mapping
- destructive action flags
- integration with the runtime's tool pipeline

## 7. Disposal

```ts
await host.dispose()
```

Disposal clears the active adapter reference. In long-lived apps, this matters when:

- shutting down workers cleanly
- rotating host instances
- rebuilding after environment changes

## 8. Optional Constructor Options

`SubprocessComputerUseHost` also supports optional constructor inputs:

| Option | Purpose |
| --- | --- |
| `env` | Override environment during display-server detection |
| `platform` | Override platform during detection |
| `adapter` | Inject a prebuilt adapter, mainly for tests |

Most production code should use the default constructor plus `initialize()`.

## 9. Common Failure Modes

| Problem | Typical cause |
| --- | --- |
| `adapter not initialised` error | `initialize()` was never awaited |
| no adapter for `displayServer="unknown"` | current environment is unsupported |
| capabilities unexpectedly false | required CLI or permission is missing |
| actions start working only after reinstalling a binary | recreate the host so capabilities are re-probed |

## 10. Recommended Production Pattern

For long-lived services:

1. create one host instance during startup
2. await `initialize()`
3. log the final capability map
4. register the wrapped tool
5. recreate the host on major environment changes or fatal adapter-level errors

## Related

- [Computer Use](./README.md)
- [Action Reference](./action-reference.md)
- [Platform Support](./platform-support.md)
- [SubprocessComputerUseHost Source](https://github.com/cogitave/namzu/blob/main/packages/computer-use/src/SubprocessComputerUseHost.ts)
- [detectDisplayServer Source](https://github.com/cogitave/namzu/blob/main/packages/computer-use/src/detect/index.ts)
