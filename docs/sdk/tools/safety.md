---
title: Tool Safety
description: Layered tool safety in @namzu/sdk, including tool metadata, availability states, verification gates, plan mode, and sandbox boundaries.
last_updated: 2026-04-18
status: current
related_packages: ["@namzu/sdk", "@namzu/computer-use"]
---

# Tool Safety

Namzu does not treat tool execution as a raw function call. The runtime uses several layers so that tools can be described, reviewed, activated, denied, and contained in a predictable way.

## 1. The Safety Layers

Tool safety in the SDK is intentionally layered:

| Layer | Responsibility |
| --- | --- |
| Tool definition metadata | Describe whether a tool is read-only, destructive, concurrency-safe, and what permissions it declares |
| Tool availability state | Control whether a tool is active, deferred, or suspended |
| Permission mode | Block mutating tools in plan-style execution |
| Verification gate | Decide allow, deny, or review before execution |
| Sandbox | Constrain what execution can do if it is allowed |

No single layer is expected to do all the work.

## 2. Safety Metadata in `defineTool()`

When you create a tool with `defineTool()`, you declare:

| Field | Why it matters |
| --- | --- |
| `permissions` | Describes the capability class such as file read, file write, shell execution, or network access |
| `readOnly` | Lets the runtime and verification logic treat non-mutating tools differently |
| `destructive` | Signals risky actions that may require stronger review |
| `concurrencySafe` | Signals whether parallel execution is safe |
| `category` | Lets policy group tools by domain such as filesystem, shell, network, or analysis |

That metadata is part of runtime policy, not just documentation.

## 3. Availability States in ToolRegistry

`ToolRegistry` tracks one of three states for each tool:

| State | Meaning |
| --- | --- |
| `active` | Tool can be shown and executed |
| `deferred` | Tool is known but intentionally hidden until activated |
| `suspended` | Tool is known but currently not executable |

This lets the runtime narrow the tool surface over time instead of always showing the full tool catalog.

## 4. `permissionMode`

The tool registry has built-in behavior for permission mode:

| Mode | Behavior |
| --- | --- |
| `auto` | Standard execution path |
| `plan` | Non-read-only tools are blocked at execution time |

That means `permissionMode: 'plan'` is not just a label. If a tool is not read-only, `ToolRegistry.execute()` will reject it in plan mode.

## 5. Verification Gate

`VerificationGate` is the SDK's rule-based pre-execution decision layer.

It evaluates a tool call into one of:

- `allow`
- `deny`
- `review`

Built-in rule types include:

- `allow_read_only`
- `deny_dangerous_patterns`
- `allow_by_category`
- `allow_by_name`
- `deny_by_name`
- `custom_pattern`
- `allow_by_tier`

## 6. Verification Gate Example

```ts
import { VerificationGate } from '@namzu/sdk'
import { getRootLogger } from '@namzu/sdk'

const gate = new VerificationGate(
  {
    enabled: true,
    allowReadOnlyTools: true,
    denyDangerousPatterns: true,
    rules: [
      { type: 'deny_by_name', toolNames: ['write_file'] },
      { type: 'allow_by_category', categories: ['analysis'] },
    ],
  },
  getRootLogger(),
)
```

The important boundary is:

- verification decides whether the call should proceed
- sandboxing decides what the call can do if it proceeds

Today, high-level agent helpers such as `ReactiveAgent.run()` do not expose `verificationGate` directly. If you want to turn this on in a real run, wire the config through `query()` or `drainQuery()` as shown in [Low-Level Runtime](../runtime/low-level.md).

## 7. Sandbox Boundary

Several built-in tools are sandbox-aware:

- `read_file`
- `write_file`
- `edit`
- `bash`

When a sandbox is present in `ToolContext`, those tools route through sandbox APIs instead of touching the host environment directly.

This is why the sandbox is a real operational layer and not just a documentation concept.

## 8. Built-In Tool Safety Signals

Some examples from the shipped built-ins:

- `ReadFileTool` is read-only and concurrency-safe
- `WriteFileTool` is destructive and not concurrency-safe
- `EditTool` is mutating but not marked destructive by default
- `BashTool` dynamically marks commands destructive when they match dangerous patterns
- `createComputerUseTool()` marks click, drag, scroll, typing, and key input as destructive

Those declarations make it easier to write policy that matches real behavior.

## 9. Failure Behavior

`defineTool()` catches thrown errors and converts them into structured failed `ToolResult`s:

```ts
{
  success: false,
  output: '',
  error: 'tool_name failed: ...'
}
```

This matters for:

- stable runtime behavior
- better event streams
- predictable MCP or UI error handling

## 10. Practical Safety Pattern

For a conservative agent:

1. activate read-only discovery tools by default
2. keep mutating tools deferred
3. enable a verification gate with `allowReadOnlyTools`
4. use sandboxed execution where possible
5. turn on stronger review only for tool categories that need it

That pattern gives the model useful autonomy without treating every tool equally.

## Related

- [SDK Tools](./README.md)
- [Built-In Tools](./built-in.md)
- [Run Configuration](../runtime/configuration.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Safety and Operations](../architecture/safety.md)
- [VerificationGate Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/verification/gate.ts)
