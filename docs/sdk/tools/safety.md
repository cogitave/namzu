---
title: Tool Safety
description: Layered tool safety in @namzu/sdk, including tool metadata, availability states, verification gates, probe vetoes, plan mode, and sandbox boundaries.
last_updated: 2026-07-13
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
| Probe veto | Let application code deny a specific call at execution time |
| Sandbox | Constrain what execution can do if it is allowed |

No single layer is expected to do all the work.

Every one of these layers matches on **the name the model supplied**. That is why
a tool is reachable under exactly one name — see [Tool Names Are Canonical](#8-tool-names-are-canonical).

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

### Deny is a plane, not a position in the list

Rule order decides allow-versus-review, and nothing else. A `deny` rule matching
a call always wins over an `allow` rule matching the same call, regardless of
which one is written first in `rules` — so an operator's explicit
`deny_by_name` is never dead config behind an earlier allow, including the
built-in `allow_read_only` rule that `allowReadOnlyTools` prepends. Only among
the calls no rule denies does list order pick the first matching `allow` or
`review` rule.

A rule that throws while evaluating denies the call it was evaluating. The
gate fails closed like the other authorization layers — see
[Fail-Closed Policy](../architecture/safety.md#3-fail-closed-policy).

### The gate is consulted twice, for two different questions

The gate is not a single checkpoint. It is asked about a tool call at two
points, and the two checks have two different jobs:

1. **Before a human is asked.** `runToolReview` evaluates the gate against the
   input the model proposed. Any call the gate denies is removed from the
   batch right there and answered immediately — a human reviewer never sees
   it, and no review decision, including approving the rest of the batch, can
   put it back. Calls the gate did not deny go to a human only if at least one
   of them needs review; if every survivor is `allow`, the batch runs without
   asking anyone.
2. **Immediately before dispatch.** A human `modify` decision, or a plugin
   `pre_tool_use` hook, can rewrite a call's input after the first check ran.
   `ToolExecutor` re-evaluates the gate's deny plane against that *final*
   input — after every hook has run, at the last point where the input is
   still observable and no longer changeable. A rewrite that turns an allowed
   call into one the deny rules match is denied here, not executed.

The first check decides what a human is asked and what the review phase
approves. The second decides what actually runs, and nothing downstream of it
can undo that decision. See
[Safety Flow in Practice](../architecture/safety.md#9-safety-flow-in-practice)
for the full sequence.

**And if no human is there to ask?** Nothing runs. A `query()` with no
`resumeHandler` does not auto-approve — it **parks the run durably**, persisting
the question so it can be answered out of process later. An absent reviewer and
an authorizing one must not be the same program. See
[Durable Pause](../runtime/durable-pause.md).

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

`write_file` is denied here even though `allow_read_only` and any `allow_by_category`
rule are evaluated too — deny wins regardless of order, so listing the deny rule
first or last makes no difference to the outcome.

The important boundary is:

- verification decides whether the call should proceed
- sandboxing decides what the call can do if it proceeds

Today, high-level agent helpers such as `ReactiveAgent.run()` do not expose `verificationGate` directly. If you want to turn this on in a real run, wire the config through `query()` or `drainQuery()` as shown in [Low-Level Runtime](../runtime/low-level.md).

## 7. Probe Vetoes

Where the verification gate is rule-based, a **probe veto** is application code
that gets asked, per call, whether an operation may proceed. `tool_executing` is
the vetoable event kind today.

```ts
import { probe } from '@namzu/sdk'

probe.veto(
  'tool_executing',
  (event) => (event.toolName === 'bash' ? { action: 'deny', reason: 'shell disabled' } : 'allow'),
  { name: 'no-shell' },
)
```

The first deny wins, and a denied call comes back to the model as a failed tool
result rather than throwing out of the run.

### Vetoes fail closed

**A veto handler that throws denies.** So does a `where` filter that throws — the
predicate is evaluated inside the same boundary as the handler, because it is
half of the handler.

This matters more than it looks. A filter like
`e => e.input.command.startsWith('rm')` throws a `TypeError` on the first tool
call whose input has no `command` field. Before this behavior existed, that throw
was logged and the call proceeded: a crashed authorizer silently waved through
exactly the operations it was written to stop.

A veto is an authorization decision, and an authorizer that cannot answer must
not be read as an allow.

A genuinely non-critical veto can opt out per handler:

```ts
probe.veto('tool_executing', handler, { onError: 'allow' })
```

A deny produced by a throwing handler carries `reason: PROBE_ERROR_REASON`
(exported), so you can tell it apart from a deliberate deny in your event stream.

> **Upgrading from `0.4.x`:** this is a behavior change. A handler that was
> quietly crashing was not enforcing anything; it will now start denying. See
> [Migrating to 0.5.0](../../migration/0.5.md#section-b--veto-handlers-fail-closed).

## 8. Tool Names Are Canonical

The registry key **is** the model-visible name. `defineTool()` names are
validated at registration against `[a-zA-Z0-9_-]{1,64}` — the intersection of
what strict providers accept for a function name — so an invalid name fails at
registration rather than as a 400 on the next model call. Registering a tool
under a key that differs from its `name` throws `ToolNameKeyMismatchError`: the
model is shown the name and calls it back, so a divergence produces a tool the
model can see but never invoke.

A tool is reachable under **exactly one** name. There are no aliases, and the
plugin namespace separator (`__`) has no legacy `:` fallback. This is a safety
property, not a naming preference: probe vetoes, plugin `pre_tool_use` hooks, and
the verification gate all match on the raw name the model supplied, so a second
spelling resolved further down in the registry would reach a tool those layers
had just denied under its other name.

### An unknown name is an error result, not a throw

A name the registry does not hold comes back to the model as a tool-level error
result. It is not a rejection.

Models mistype and invent tool names. One bad name in a batch must still let the
other calls return and let the model correct itself — a rejection here used to
escape the executor's `Promise.all` and abort the entire run.

## 9. Sandbox Boundary

Several built-in tools are sandbox-aware:

- `read_file`
- `write_file`
- `edit`
- `bash`

When a sandbox is present in `ToolContext`, those tools route through sandbox APIs instead of touching the host environment directly.

This is why the sandbox is a real operational layer and not just a documentation concept.

## 10. Built-In Tool Safety Signals

Some examples from the shipped built-ins:

- `ReadFileTool` is read-only and concurrency-safe
- `WriteFileTool` is destructive and not concurrency-safe
- `EditTool` is mutating but not marked destructive by default
- `BashTool` dynamically marks commands destructive when they match dangerous patterns
- `createComputerUseTool()` marks click, drag, scroll, typing, and key input as destructive

Those declarations make it easier to write policy that matches real behavior.

## 11. Failure Behavior

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

## 12. Practical Safety Pattern

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
- [Durable Pause](../runtime/durable-pause.md)
- [Low-Level Runtime](../runtime/low-level.md)
- [Plugins and MCP Servers](../integrations/plugins.md)
- [Safety and Operations](../architecture/safety.md)
- [Migrating to 0.5.0](../../migration/0.5.md)
- [VerificationGate Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/verification/gate.ts)
- [Probe Registry Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/probe/registry.ts)
