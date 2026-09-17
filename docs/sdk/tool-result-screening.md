---
type: Reference
title: Tool-result screening
description: Where a tool result is judged before anything reads it, what the four verdicts mean, and the two screens namzu ships.
resource: packages/sdk/src/registry/tool/screen.ts
tags: [sdk, tools, guardrails, security]
status: stable
generated: { by: process:claude-code, at: 2026-09-18T00:00:00Z }
---

# Tool-result screening

A tool result is the one thing a run reads that no input gate has seen. The
prompt was screened before the run started; the tool's arguments were validated,
authorized and reviewed before it ran; what came back was not examined at all.
That is the shape of an indirect injection — the run is legitimate, the call is
legitimate, and the payload arrives riding on an answer the model asked for.

`ToolRegistryConfig.resultGuardrails` runs a list of screens against every
result at that boundary.

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
| `provenance` | Who produced it, when it was not this process. A screen reading only the value cannot tell a connected server's words from a first-party tool's. |

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

A screen that throws fails closed as `refuse`, matching the run-level
guardrails: one broken screen means this result's safety is unknown, not that
the run is unsalvageable.

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
request inside a larger answer is an answer.

A connector's result reaches a screen already wrapped by `wrapUntrusted`, so the
comparison runs on the body inside that frame as well as on the whole output.
Without that it would never match the case it is most worth having.

Three things it deliberately does not touch, each for a reason rather than for
lack of time:

- **An empty result for a non-empty request.** Real, and not a signal: a search
  that matched nothing and a file with nothing in it both return nothing, and
  refusing either tells the model to stop looking when there was nothing to
  find.
- **A shape contradicting `ToolDefinition.outputSchema`.** The schema is not on
  the context and is documented as shown to the model, never validated.
  Carrying it and enforcing it are changes to that contract.
- **A failed call.** On `success: false` the text is a diagnostic, and a
  refusal replaces the output — so screening it would trade an echo nobody needs
  caught for the error message the model needs to read.

The mismatch the issue that asked for this screen named first — a lookup for one
subject answering about another — is **not decidable here**, and this screen
does not guess at it. It needs a declaration of which argument names the
subject, and the framework cannot infer one: for a file read the answer is the
file's contents, which do not name the path, so the natural rule — an answer
mentions its subject — would refuse every ordinary read. A host that knows a
tool's subject can write that screen in a few lines against the same context.

A tool whose answer legitimately IS the request — a validator returning what it
validated, a normaliser returning the normalised form, a dry run echoing what it
would have done — is named in `passthroughTools`. Nothing on the context
distinguishes those from a tool that answered nothing, so the host that knows
says so.

## Turning one on

```ts
import { ToolRegistry, toolResultCorrespondenceGuardrail } from '@namzu/sdk'

const tools = new ToolRegistry({
  resultGuardrails: [toolResultCorrespondenceGuardrail()],
})
```

**The default is nothing.** `new ToolRegistry()` and
`runAgent({ tools: new ToolRegistry() })` screen no results at all, and the
screens above ship as presets to configure rather than as defaults that arrive
with the version. Adding a control must not change an existing host's behaviour
on upgrade; both presets are opt-in, and a test pins that a run with no
`resultGuardrails` returns a result exactly as the tool produced it.

Reachability is asymmetric with `inputGuardrails` and `outputGuardrails`, which
are run-config options. `resultGuardrails` is a registry-construction option,
so a host looking for it beside the other two will not find it, and the CLI
builds its registry with no screens and has no flag for them. Reaching the run
config means the run config reaching a registry it did not construct, which is a
separate change.
