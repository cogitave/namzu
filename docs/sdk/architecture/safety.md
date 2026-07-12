---
title: Safety and Operations
description: Sandboxing, verification, frame authentication, fail-closed policy, bus coordination, telemetry, and operational guardrails inside @namzu/sdk.
last_updated: 2026-07-12
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

Deny is a plane, not a position in the rule list: a `deny` rule matching a call
wins over an `allow` rule matching the same call regardless of which is written
first. Rule order only decides allow-versus-review among the calls no rule
denies. A rule that throws while evaluating denies the call — see
[Fail-Closed Policy](#3-fail-closed-policy).

The gate is not consulted once per call. `runToolReview` asks it about the
input the model proposed, to strip denied calls out before a human reviewer
sees the batch and to decide which survivors need review. `ToolExecutor` asks
it again, against the tool's *final* input, immediately before dispatch — see
[Safety Flow in Practice](#9-safety-flow-in-practice) for the full sequence.

Architecturally, this is separate from sandboxing:

- verification decides whether a tool call should proceed
- sandboxing decides what the process can do if it proceeds

## 3. Fail-Closed Policy

Two authorization layers changed from fail-open to **fail-closed**, because an authorizer that crashes and is read as an approval is worse than no authorizer at all.

| Layer | A throwing handler... |
| --- | --- |
| Probe veto (`probe/registry.ts`) | **denies**. Opt out per handler with `{ onError: 'allow' }` |
| Plugin hook (`plugin/lifecycle.ts`) | **blocks** the guarded operation. Opt out per hook with `onError: 'continue'` |
| Verification gate (`verification/gate.ts`) | **denies**, at both points it is consulted — in `runToolReview` and again in `ToolExecutor` against the final input. No opt-out. |

For vetoes, the `where` predicate is evaluated *inside* the same try boundary as the handler. It is half of the handler: a filter like `e => e.input.command.startsWith('rm')` throws on the first tool call whose input has no `command`, and evaluating it outside the boundary let that throw escape `queryVeto` and abort the run instead of producing the deny the policy promises.

A continued plugin-hook error stays visible on the `plugin_hook_completed` event's `error` field. A crashed hook must never be indistinguishable from a clean one.

The `ToolExecutor` wraps the veto query itself in the same posture: if the probe registry *machinery* throws — not one handler, the whole mechanism — the call is denied rather than allowed, and the run is not aborted.

## 4. Frame Authentication

Model-facing frames are **authenticated, not escaped**.

Sub-agent results and advisory blocks arrive as untrusted content — a sub-agent's output can contain anything, including text that looks like a framework tag. The old defense was to escape the payload. The current defense is to make the *boundary* unforgeable instead:

- Frames carry a per-run nonce in their tag name: `<task-notification-{nonce}>`, `<advisory-result-{nonce}>`.
- A `<frame-authentication>` block in the system prompt tells the model that **only** nonce-bearing tags were written by the framework, and that any unmarked `<task-notification>` or `<system>` tag is untrusted data to report on rather than instruction to act on.
- The nonce is generated per run and never appears in the model's input except on the framework's own tags, so it is not derivable from anything a sub-agent can see.

The payoff is fidelity. Because the boundary is now the thing an attacker cannot reproduce, the payload inside a frame is passed through **verbatim** — code, file paths, and ampersands reach the model byte-exact rather than HTML-escaped into something that no longer matches the filesystem.

Escaping stays where it does no harm: tool names and descriptions in the prompt catalogue are escaped, because they are metadata, not content the model has to reproduce. The working directory is likewise left unescaped, since the model builds absolute paths from it and an escaped `/Users/x/R&amp;D/app` would fail every file operation with ENOENT.

## 5. One Canonical Tool Name

Every name-keyed safety layer — probe vetoes, plugin `pre_tool_use` hooks, the verification gate — matches on the raw name the model supplied. A tool reachable under two spellings is therefore a privilege-escalation hole: a tool denied under one name is reachable under the other.

So there is exactly one canonical name per tool, and no alias resolution anywhere. The plugin namespace separator is `__` with no legacy `:` fallback, and composition is injective because no component may itself contain `__`. Names the SDK does not author (an MCP server's own tool names, connector methods) are canonicalized deterministically onto the provider-legal character set rather than aliased.

See [Tool Safety](../tools/safety.md#8-tool-names-are-canonical).

## 6. Agent Bus

`bus/` owns coordination primitives for concurrent or multi-agent scenarios:

| Primitive | Responsibility |
| --- | --- |
| `FileLockManager` | Lock files or paths across runs |
| `EditOwnershipTracker` | Track which run currently owns an edit surface |
| `CircuitBreaker` | Stop repeated failure loops or noisy retry behavior |

The `AgentBus` composes these primitives and exposes cleanup and maintenance operations around them.

## 7. Telemetry

Observability is split between `telemetry/` and parts of `provider/telemetry/`:

- `telemetry/attributes.ts` defines shared attribute names and span naming helpers.
- `telemetry/metrics.ts` and related helpers centralize metrics behavior.
- runtime and iteration code create spans around runs and iterations instead of logging only ad hoc strings.

## 8. Constants and Config as Guardrail Infrastructure

Several folders support operational safety indirectly:

| Folder | Why it matters |
| --- | --- |
| `constants/` | Keeps thresholds and defaults centralized rather than scattered inline |
| `config/` | Gives runtime schema validation and typed defaults |
| `utils/logger.ts` | Keeps structured logging consistent across modules |

This is part of the SDK architecture even though these folders do not execute user work directly.

## 9. Safety Flow in Practice

A practical request can touch these layers in sequence:

```text
tool call requested (by the name the model supplied)
  -> name resolves in the registry, or an error result goes back to the model
  -> verification gate evaluates the PROPOSED input (runToolReview):
       deny -> removed from the batch, answered now, before any human sees it
       otherwise -> allow-only survivors execute unasked; any review-decision
                    survivor sends the whole surviving set to a human
  -> human review, if reached (approve / modify / deny per call)
       -> a modify produces a new input, but does not skip the steps below
  -> plugin pre_tool_use hooks run (a throw blocks; a modify rewrites the input)
  -> verification gate evaluates the FINAL input again (ToolExecutor),
     immediately before dispatch — this is the one nothing downstream can bypass
  -> probe vetoes are queried (a throw denies)
  -> tool executes
  -> sandbox constrains filesystem and process behavior
  -> agent bus coordinates locks or ownership if needed
  -> telemetry records the run and iteration effects
```

The gate appears twice on purpose: the first pass decides what a human is
asked and what the review phase approves; the second decides what actually
runs, at the one point where every possible rewrite — human `modify`, plugin
hook — has already happened and nothing more will touch the input before
dispatch. Approving a batch in review never approves a call the gate denied
earlier, and a plugin hook can no longer rewrite a call into something the
deny rules match and have it execute.

Every deny in that chain returns to the model as a failed tool result rather than throwing out of the run, so one blocked call does not take the other calls in the batch down with it.

## 10. Computer Use and Safety

`computer_use` is a good stress case for this layer:

- the SDK models it as a tool, so it can participate in review and runtime control
- the host package exposes capabilities explicitly
- unsupported actions fail fast instead of pretending to succeed

That makes desktop automation fit into the same operational model as any other tool surface.

## Related

- [SDK Tools](../tools/README.md)
- [Tool Safety](../tools/safety.md)
- [Runtime Pipeline](./runtime-pipeline.md)
- [Plugins and MCP Servers](../integrations/plugins.md)
- [Extensions and Integrations](./extensions.md)
- [Migrating to 0.5.0](../../migration/0.5.md)
- [Sandbox Factory](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/sandbox/factory.ts)
- [Verification Gate](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/verification/gate.ts)
- [Probe Registry](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/probe/registry.ts)
