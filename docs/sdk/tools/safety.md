---
uid: namzu.sdk.tools.safety
title: Tool Safety
description: Layered tool safety in @namzu/sdk, including tool metadata, availability states, the authorization rule vocabulary and its evaluation order, plan mode, and sandbox boundaries.
type: Guide
diataxis: explanation
owner: cogitave/namzu
status: active
timestamp: 2026-08-05T00:00:00Z
lastReviewed: 2026-08-27
tags: [computer-use, sdk]
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
| Authorization gate | Decide allow, deny, or review before execution |
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

## 5. Authorization Gate

`AuthorizationGate` is the SDK's rule-based pre-execution decision layer.

It evaluates a tool call into one of:

- `allow`
- `deny`
- `review`

A call that matches no rule is `review`. That is the fallback the whole design
rests on: widening it has to be something an operator wrote down.

### The rule vocabulary

| Rule | Decides on |
| --- | --- |
| `allow_read_only` | the tool declaring itself read-only for this input |
| `deny_dangerous_patterns` | the serialized input matching a catastrophic-command pattern |
| `allow_by_category` | the tool's `category` |
| `allow_by_tier` | the tool's `tier` |
| `allow_by_name` / `deny_by_name` | the tool's name |
| `argument_pattern` | one named argument of one named set of tools |
| `custom_pattern` | the tool name, the serialized arguments, or both concatenated |

### Order is the meaning

Rules are evaluated **first-match-wins**, and the gate assembles the list in a
fixed order that is not the order you wrote:

1. `deny_dangerous_patterns`, when `denyDangerousPatterns` is on. This is the
   floor. An operator rule cannot open what it closes.
2. **Your `rules`, in the order you gave them.**
3. `allow_read_only`, when `allowReadOnlyTools` is on.

The read-only allowance goes **last**, and the position is load-bearing. Ahead
of the operator's rules it made a rule like "prompt me before every read"
unreachable whenever the flag was on — not rejected, not warned about, just
never consulted. Someone who writes a control and is silently ignored gets the
worst outcome available: they believe it is in force and it is not. Last, it is
what it always was in substance — a default for tools nobody wrote a rule
about, rather than an override of the rules they did.

## 6. Authorization Gate Example

```ts
import { AuthorizationGate, createLogger, prettySink } from '@namzu/sdk'

// The gate's second argument. Passing nothing is legal and means the gate's
// decisions are not narrated anywhere — build a logger if you want to read
// them.
const log = createLogger({
  sink: prettySink(process.stderr),
  level: { current: 'info' },
  resource: { 'service.name': 'my-app' },
  scope: 'authorization',
})

const gate = new AuthorizationGate(
  {
    enabled: true,
    allowReadOnlyTools: true,
    denyDangerousPatterns: true,
    logDecisions: false,
    rules: [
      { type: 'deny_by_name', toolNames: ['write'] },
      {
        type: 'argument_pattern',
        toolNames: ['bash'],
        argument: 'command',
        pattern: '^git push',
        decision: 'deny',
      },
      { type: 'allow_by_category', categories: ['analysis'] },
    ],
  },
  log,
)
```

The important boundary is:

- verification decides whether the call should proceed
- sandboxing decides what the call can do if it proceeds

High-level agent helpers (`ReactiveAgent.run()`, `SupervisorAgent.run()`) accept `authorizationGate` directly via their config — both forward it through to `drainQuery`. Hosts that just need a sane default can pass the exported `defaultSandboxedGateConfig()` or `defaultSandboxedShellGateConfig()` preset.

### 6.1 Writing a pattern rule: which of the two

The two pattern rules look interchangeable and are not. Choosing wrong produces
a rule that decides nothing and says nothing about it.

**`argument_pattern` tests one argument's own value.** It names both the tools
it applies to and the argument it reads, so an anchored pattern means what it
looks like it means:

```ts
import type { AuthorizationRule } from '@namzu/sdk'

const noPushing: AuthorizationRule = {
  type: 'argument_pattern',
  toolNames: ['bash'],
  argument: 'command',
  pattern: '^git push',
  decision: 'deny',
}
```

It deliberately decides **nothing** in three cases — the tool was not called,
the argument is absent, or the argument holds an object or an array. No string
a pattern could match says anything true about a structured value, and
serializing one to try would put the rule back where `custom_pattern` already
is. To refuse a tool over the *shape* of its input, deny it by name. Numbers and
booleans **are** matched rather than skipped: they render unambiguously, and a
rule about a numeric argument is a reasonable thing to write.

#### A command line is not one string

The rule above reads the argument as the **commands it runs**, not as the text
it happens to be. That matters because a value and a command line are different
things: `git push origin main` is one command, and `true; git push origin main`
is two — of which the second is the one `noPushing` was written about. An
anchored pattern tested against the whole value sees only the first, so the rule
above would have missed every line in the left column:

| Command | Decision |
|---|---|
| `git push origin main` | `deny` |
| `echo hi && git push origin main` | `deny` |
| `true; git push origin main` | `deny` |
| `cd /tmp && git push origin main` | `deny` |
| `bash -c "git push origin main"` | `deny` |
| `echo "git push is only mentioned"` | not decided |

Chain operators (`&&`, `||`, `;`, `|`, `&`, newline), subshell grouping and a
nested `sh -c` payload are all read. Quoting is respected, so the last row is
one command that prints a string and no rule fires on it.

**The two decisions read that decomposition differently, and the asymmetry is
deliberate.**

- A **`deny`** matches when *any* command on the line matches. One prohibited
  command poisons the line it rides on.
- An **`allow`** matches only when *every* command on the line matches.
  Permission is a claim about the whole line — granting it because the first
  command matched is what would let `git status && rm -rf ~` through a rule
  written for `^git status`.

An `allow` additionally declines any line that runs something the decomposition
cannot see: command substitution (`$(…)`, backticks, `<(…)`) executes text that
is not in the line, and `eval` runs a string assembled at runtime. A `deny`
still tests what *is* visible there, because a deny that matches too much costs
a prompt and a deny that matches too little costs the thing it was written to
prevent.

A value with no chain operator, no nested shell and nothing opaque is matched
exactly as it always was, byte for byte — so a rule about a path, a URL or a
number is unaffected by any of this.

**`custom_pattern` tests text, and `target: 'args'` is the trap.** The subject
is `JSON.stringify(toolInput)` — the JSON *text of the whole argument object* —
not any single argument. So against a `bash` call the subject looks like

```
{"command":"git push origin main"}
```

and the natural, anchored thing to write, `^git push`, can never match. The rule
then decides nothing, silently. `target: 'both'` **prefixes** the tool name to
that text rather than requiring it, so it is not a tool scope either: a rule
written with one tool in mind still sees every other tool's arguments.

`custom_pattern` is not deprecated, because matching anywhere in the serialized
input without caring where is a real use — searching for a credential-shaped
string across every argument of every tool, for instance. Use it for that, and
use `argument_pattern` when you mean "this tool, this argument".

### 6.2 Reading a verdict back

`evaluateRule` answers whether a rule matched. `describeRule` gives you the
sentence for it, and both are exported:

```ts
import { describeRule, evaluateRule } from '@namzu/sdk'
```

A host driving the rule primitives directly — rather than through
`AuthorizationGate` — was otherwise left holding a verdict with no words for it,
and the only way to say anything about a refusal was to switch on the rule's
`type`. That names the *kind* of rule and nothing about what it said: not which
tool, not which pattern, not whether a different input could ever help.

That difference is behavioural, not cosmetic. Told only that it was denied, a
model rewords the same call and tries again, because nothing says the retry is
pointless. Told that a pattern rule denies `git push*`, or that a by-name denial
is about the tool rather than the input, it can stop and say so. A refusal that
cannot be reasoned about produces thrashing; one that can produces a route
around it.

`GateEvaluationResult.reason` is `describeRule(matchedRule)`, so a host
rendering its own approval UI can show the same sentence the model got.

## 7. Sandbox Boundary

Several built-in tools are sandbox-aware:

- `read`
- `write`
- `edit`
- `bash`

When a sandbox is present in `ToolContext`, those tools route through sandbox APIs instead of touching the host environment directly.

This is why the sandbox is a real operational layer and not just a documentation concept.

The local sandbox launches a fresh child environment rather than copying the
host's. On POSIX it inherits only the existing path, home, shell, locale and
terminal plumbing. On Windows it additionally preserves the non-secret core
variables a working child needs for executable lookup, system DLLs, the command
interpreter, profile and temporary storage, including `PATHEXT`, `SystemRoot`,
`ComSpec`, and `WINDIR`. Windows names are compared case-insensitively, so an
explicit session or per-call `Path` replaces ambient `PATH` instead of reaching
`spawn` as a second, accidental winner. Explicit values still override ambient
core values; unnamed ambient variables, including credentials, remain absent.

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
import type { ToolResult } from '@namzu/sdk'

const failed: ToolResult = {
  success: false,
  output: '',
  error: 'tool_name failed: ...',
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
3. enable an authorization gate with `allowReadOnlyTools`
4. use sandboxed execution where possible
5. turn on stronger review only for tool categories that need it

That pattern gives the model useful autonomy without treating every tool equally.

## Related

- [SDK Tools](./README.md)
- [Built-In Tools](./built-in.md)
- [AuthorizationGate Source](https://github.com/cogitave/namzu/blob/main/packages/sdk/src/authorization/gate.ts)
