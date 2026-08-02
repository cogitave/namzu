---
title: Safety and Operations
description: Sandboxing, verification, bus coordination, telemetry, and operational guardrails inside @namzu/sdk.
last_updated: 2026-08-03
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
| `sandbox/isolation.ts` | What each detected tier actually enforces, and the refusal when it cannot |

The local provider is responsible for:

- sandbox root creation
- safe path resolution inside the sandbox
- process execution with timeouts and output limits
- atomic writes inside the sandbox filesystem
- environment filtering for safe env propagation

### What a tier actually enforces

The detected environment does not enforce a uniform amount of isolation,
and the provider used to report the same `id` and `name` at every tier —
so a host that deliberately turned isolation **on** got a tier-dependent
amount of it under one undifferentiated name.

| Environment | filesystem | network | process |
| --- | --- | --- | --- |
| `macos-seatbelt` | yes | yes | yes |
| `linux-namespace` | **no** | yes | yes |
| `basic` | no | no | no |

`linux-namespace` reports `filesystem: false` deliberately: the tier
unshares the mount namespace but never remounts anything, so the child
still sees the whole host filesystem. A private mount table is not
confinement.

Detection runs the flags it will actually spawn under, rather than checking
that a binary exists — a host with unprivileged user namespaces disabled by
sysctl answers `unshare --version` happily and then fails every spawn.

Constructing at the `basic` tier logs a **warning** naming it as
unconfined. The host-side controls that do survive there (env scrubbed to a
safe key set, cwd anchored, the SDK's own file helpers path-checked) are
not process confinement.

### Requiring a control

```ts
const provider = new LocalSandboxProvider(log, {
  requireIsolation: ['filesystem', 'network'],
})
// throws on a host that cannot enforce them
```

Also settable as `sandbox.requireIsolation` in runtime config. It defaults
to empty, so best-effort callers are unaffected — but a caller that states
a requirement gets it or gets an error. It is never silently downgraded: a
security control that is accepted and then not applied is worse than one
that was never offered, because the caller stops looking.

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
