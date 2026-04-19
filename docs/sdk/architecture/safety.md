---
title: Safety and Operations
description: Sandboxing, verification, bus coordination, telemetry, and operational guardrails inside @namzu/sdk.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/computer-use"]
---

# Safety and Operations

The SDK has a distinct operational layer that exists to keep execution safe and inspectable. These modules are easy to overlook when reading only the public API, but they carry many of the runtime guarantees that make the package usable in real agent environments.

## 1. Sandboxing

The `sandbox/` folder owns execution containment:

| Module | Responsibility |
| --- | --- |
| `sandbox/factory.ts` | Build a `SandboxProvider` from config |
| `sandbox/provider/local.ts` | Local sandbox implementation with environment detection and filesystem safety |

The local provider is responsible for:

- sandbox root creation
- safe path resolution inside the sandbox
- process execution with timeouts and output limits
- atomic writes inside the sandbox filesystem
- environment filtering for safe env propagation

## 2. Verification Gate

`verification/gate.ts` is the rule-based pre-execution decision layer for tools:

- it expands built-in rules such as read-only allow and dangerous-pattern deny
- it compiles regex-based custom rules
- it evaluates a tool call into allow, deny, or review

Architecturally, this is separate from sandboxing:

- verification decides whether a tool call should proceed
- sandboxing decides what the process can do if it proceeds

## 3. Agent Bus

`bus/` owns coordination primitives for concurrent or multi-agent scenarios:

| Primitive | Responsibility |
| --- | --- |
| `FileLockManager` | Lock files or paths across runs |
| `EditOwnershipTracker` | Track which run currently owns an edit surface |
| `CircuitBreaker` | Stop repeated failure loops or noisy retry behavior |

The `AgentBus` composes these primitives and exposes cleanup and maintenance operations around them.

## 4. Telemetry

Observability is split between `telemetry/` and parts of `provider/telemetry/`:

- `telemetry/attributes.ts` defines shared attribute names and span naming helpers.
- `telemetry/metrics.ts` and related helpers centralize metrics behavior.
- runtime and iteration code create spans around runs and iterations instead of logging only ad hoc strings.

## 5. Constants and Config as Guardrail Infrastructure

Several folders support operational safety indirectly:

| Folder | Why it matters |
| --- | --- |
| `constants/` | Keeps thresholds and defaults centralized rather than scattered inline |
| `config/` | Gives runtime schema validation and typed defaults |
| `utils/logger.ts` | Keeps structured logging consistent across modules |

This is part of the SDK architecture even though these folders do not execute user work directly.

## 6. Safety Flow in Practice

A practical request can touch these layers in sequence:

```text
tool call requested
  -> verification gate decides allow/deny/review
  -> tool executes
  -> sandbox constrains filesystem and process behavior
  -> agent bus coordinates locks or ownership if needed
  -> telemetry records the run and iteration effects
```

## 7. Computer Use and Safety

`computer_use` is a good stress case for this layer:

- the SDK models it as a tool, so it can participate in review and runtime control
- the host package exposes capabilities explicitly
- unsupported actions fail fast instead of pretending to succeed

That makes desktop automation fit into the same operational model as any other tool surface.

## Related

- [SDK Tools](../tools/README.md)
- [Runtime Pipeline](./runtime-pipeline.md)
- [Extensions and Integrations](./extensions.md)
- [Sandbox Factory](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/sandbox/factory.ts)
- [Verification Gate](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/verification/gate.ts)
