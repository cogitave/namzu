---
type: Reference
title: Tool-result screening
description: Where a tool result is judged before anything reads it, what the four verdicts mean, the two screens namzu ships, the scope and the per-tool exception, and how a turn, a registry and the CLI each choose them.
resource: packages/sdk/src/registry/tool/screen.ts
tags: [sdk, tools, guardrails, security]
status: stable
generated: { by: process:claude-code, at: 2026-09-18T00:00:00Z }
---

# Tool-result screening

A tool result is the one thing a turn reads that no input gate has seen. The
prompt was screened before the turn started; the tool's arguments were validated,
authorized and reviewed before it ran; what came back was not examined at all.
That is the shape of an indirect injection — the turn is legitimate, the call is
legitimate, and the payload arrives riding on an answer the model asked for.

Result screening happens at the registry boundary.

## Why the boundary is where it is

Position is structural rather than incidental. The registry returns to the
executor, the executor applies the output budget and spills what is over it, and
compaction summarises later still — so a screen here is upstream of both by
construction, not by ordering. It matters because a summariser does not
distinguish trusted text from untrusted, and content carried into a summary
outlives the result it came from.

## What a screen receives

| Field | Why it is there |
| --- | --- |
| `toolName` | A refusal has to be routable: "a result was refused" is not something a model can act on. |
| `input` | The validated arguments, so a screen can compare the answer against what was asked. |
| `output` | The text the model would read. |
| `success` | Whether the tool reported success. A failure's text is model-visible too, and comes from the same place its output does. |
| `provenance` | Who produced it, when it was not this process — the connected server's name, as the MCP adapter sets it. A screen reading only the value cannot tell a connected server's words from a first-party tool's, and the `server:tool` spelling an exemption list accepts is derived from it. |

## The four verdicts

`pass` leaves the result alone. `rewrite` replaces the text and is **for
redaction** — a credential removed at the last boundary before it enters
context — and not for neutralising an attack: editing a payload presumes you
understood it well enough to defang it.

The two refusals are deliberately distinct. `refuse` is recoverable: the
`tool_use` fails carrying the reason, and the model chooses something else.
`halt` is terminal and throws. It throws because the registry's failure path
turns every exception into a result the model reads and works around — which is
what `refuse` already is — so a `halt` that returned rather than threw would be
silently demoted to one.

A screen that throws fails closed as `refuse`, matching the turn-level
guardrails: one broken screen means this result's safety is unknown, not that
the turn is unsalvageable.

## `toolResultInjectionGuardrail()`

Screens the result against a list of known instruction-override phrases. It is
the same list the input-side screen uses, applied at the boundary an indirect
injection actually crosses.

**Its detection is partial and the docblock says so.** An injection phrased as
ordinary prose, or written in a language the list does not cover, passes.
Pattern-matching and delimiting both measure poorly against an attacker who
adapts. It raises the cost of the lazy attack; it is not a boundary, and nothing
here should be described as one.

## `toolResultCorrespondenceGuardrail()`

Screens the result against the request that produced it — the pairing the
context carries `input` for.

What it decides is one thing, and it is the failure that needs no domain
knowledge: **the result restates the request**. A tool handed a question and
returning that question has answered nothing, whatever it is a tool for. The
comparison is exact equality after whitespace normalisation against each string
the call carried, so a result that says anything extra passes — quoting the
request inside a larger answer is an answer. Request strings under sixteen code
points are not compared at all: a one-word echo cannot be told from a one-word
answer.

A connector's result reaches a screen already wrapped by `wrapUntrusted`, so the
comparison runs on the body inside that frame as well as on the whole output.
Without that it would never match the case it is most worth having. The body is
read back with `untrustedEnvelopeBody`, which is exported for hosts that write
their own screens against the same context.

### It judges framed results, and that is deliberate

`scope` defaults to `'framed'`: results that carry the untrusted envelope,
which is the only marker in this codebase that means *this process did not
write this*. `wrapUntrusted` is what applies it, and a connector's tool result
reaches a screen already framed because the adapter frames it
(`frameServerResult`) — the same frame a host tool gets if it decides its own
answer is not this process's to vouch for.

An earlier version of this screen judged results whose tool DEFINITION carried
`provenance`, and it was wrong for the reason a screen's scope should never be
an accident of registration: the CLI's own remote search frames its answer with
this envelope and registers as a host tool, so a search that restated its query
passed while a connected fetch that did was refused. On every result the
comparison can act on, the frame is a superset of that predicate — the only
tool definition carrying `provenance` is the MCP adapter's, and the adapter
frames every non-empty text it returns. It costs exactly one case: a connected
result with an EMPTY output is no longer in scope, and the comparison skipped
those anyway.

What `'framed'` leaves alone is this process's own unframed tools. `web_fetch`
returns a page body, and a page whose body IS the URL it was fetched from is a
true result from a working tool. So is a validator's echo, and so is any tool
whose answer is what it was handed. A test drives `getBuiltinTools()`,
`web_fetch` and `structured_output` through real calls, both on the default
scope and with the scope widened so the comparison actually runs on every one of
them, and asserts none is refused.

`scope: 'all'` adds the unframed tools too. That is the host's call, and it
costs an exemption list: under `'all'`, `web_fetch` is refused until the fetch
is named in `passthroughTools`.

`passthroughTools` accepts the names a tool actually goes by, and the set
depends on how it was registered — `passthroughToolNames(toolName, server)` is
the one implementation:

| Registered as | Also accepts |
| --- | --- |
| `mcp_weather-co_lookup` (server `weather-co`) | `lookup`, `weather-co:lookup` |
| `myplugin__mcp__weather__lookup` (server `weather`) | `lookup`, `weather:lookup` — not `mcp_weather_lookup` |
| `web_fetch` (a tool of this process's own) | nothing else |

The names are not interchangeable: an exemption written for the direct shape
does not exempt a plugin-qualified registration, which is why the table is
worth reading before writing the list. A name that matches no tool is a
question for the caller, not for the screen — the CLI reports it on
`configNotices` rather than letting it look like an exemption in force.

### What it does not decide, and why

The mismatch the issue that asked for this screen named first — a lookup for one
subject answering about another — **is not decidable here**, and this screen
does not guess at it. It needs a declaration of which argument names the
subject, and none can be inferred: for a file read the answer is the file's
contents, which do not name the path, so the natural rule — an answer mentions
its subject — would refuse every ordinary read. A host that knows a tool's
subject can write that screen against the same context.

Three more things it deliberately does not touch, each for a reason rather than
for lack of time:

- **An empty result for a non-empty request.** Real, and not a signal: a search
  that matched nothing and a file with nothing in it both return nothing, and
  refusing either tells the model to stop looking when there was nothing to
  find.
- **A shape contradicting `ToolDefinition.outputSchema`.** The schema is not on
  the context and is documented as shown to the model, never validated.
  Carrying it and enforcing it are changes to that contract.
- **A failed call.** On `success: false` the text is a diagnostic, and a refusal
  replaces the output — so screening it would trade an echo nobody needs caught
  for the error message the model needs to read.

A result that is not a string is left alone rather than refused: a screen that
throws fails closed, so a screen that assumed a string would turn its own bug
into a refusal.

### The refusal says what it did and whose result it was

The reason names the tool the result came from (`the result from "lookup"`) or,
when the match was inside the envelope, says which comparison matched (`the
text inside the untrusted frame from "lookup"`) — and describes the comparison
as whitespace-normalised, which is what it is. A caller reading a transcript is
the person who can exempt that tool, and an earlier wording claimed the result
restated the request "verbatim and on its own" for a case the comparison only
reached after normalising whitespace.

## Who chooses the screens

**A turn installs the default.** `DEFAULT_TOOL_RESULT_GUARDRAILS` is one
correspondence screen, and the executor puts it on the tool context of every
turn. The turn builds a `ToolManager` from its toolsets and applies the
default there when no screen policy was supplied.

**A turn config option overrides the default.** An empty array means no
screens:

```ts
import { MockLLMProvider, runAgent } from '@namzu/sdk'

await runAgent({
  provider: new MockLLMProvider({ responseText: 'ready' }),
  model: 'mock-model',
  prompt: 'start',
  toolResultGuardrails: [], // no screens; omit for the default
})
```

The same option exists on `BaseAgentConfig`, so it reaches the agents a turn
delegates to — a delegated child is a fresh turn with its own executor, and a
switch that reached the parent and not its children would leave the default on
in exactly the half a host was trying to change. `AgentManager` stamps it onto
the child config after the child's `configBuilder` runs, the way it stamps
`parentSpan`, `resumeHandler` and `env`, because a builder written by whoever
registered the agent cannot be expected to forward a field it was never told
about. A spawn that supplies `configOverrides.toolResultGuardrails` replaces
the inherited value — including with `[]`.

A duplex session builds its own manager from `BidiTurnParams.toolsets`. Its
`toolResultGuardrails` option chooses the screens for that session; it has no
separately constructed registry policy to override.

**The CLI names screens in `namzu.config.json`:**

```json
{ "toolResultScreens": ["injection", "correspondence"] }
```

Absent means the kernel's default, `[]` means none, and the names are
`correspondence` and `injection`. An entry may also be an object carrying that
screen's options — `{ "name": "correspondence", "passthroughTools": [...] }` —
which is how the shipped application exposes the exception this page documents.
See [tool-result screens](../cli/tool-result-screens.md).
