---
type: Reference
title: Strict tool input schemas
description: The strict-decoding subset, the two different questions a schema can be asked, and why a driver stops vouching for a guarantee the wire cannot carry.
resource: packages/sdk/src/provider/strict-schema.ts
tags: [sdk, tools, providers, json-schema]
status: stable
---

# Strict tool input schemas

Strict generation is constrained decoding: the model may only emit the fields
the schema names, so it cannot invent a parameter that does not exist. A provider
offers it as `strict: true` on a function tool, and the guarantee is only as
good as the schema's fitness for the dialect — a schema the wire cannot carry
does not degrade, it is refused, and a tool schema rides alongside three others
in one `tools` array, so it takes them down with it.

Namzu renders one schema per tool (`renderToolSchema`, see
[Portable tool schemas](tool-schema-portability.md)) and asks two different
questions of it. They are not redundant, and they have different owners.

## Can the schema be said in the dialect

`findStrictSchemaViolations(schema)` returns every place a schema leaves the
strict subset, each with its dotted path, the keyword and the remedy. It is a
deny-list of constructs the dialect has no spelling for:

- `oneOf`, and `anyOf`/`allOf` branches that never state what kind of value they
  are — a union is how Namzu says "a find-and-replace **or** an insertion", and
  a branch the model cannot tell apart from a bare `any` cannot be constrained.
- `additionalProperties` set to anything but `false`.
- `items` holding an array (a tuple), `prefixItems`, `definitions`/`$ref` and
  friends, and `minItems` outside the values the dialect admits.

`assertStrictSchema(toolName, schema)` wraps it in a refusal naming the tool, the
path and the fix. `ToolManager`'s admission runs it for any tool that sets
`enforceModelInput` — a caller who asked for the guarantee does not get it
quietly, because the vendor's 400 arrives with the tool name and not the path.

That is a registration-time question: *can this schema be SAID here at all?*

## Would the wire take it

`acceptsStrictSchema(schema)` is the wider question, and it is what a driver asks
before putting `strict: true` on one request. It first runs the deny-list, then
adds the dialect's **structural** rules — the ones a deny-list of keywords cannot
see, because nothing in the schema is wrong, only incomplete:

- **every object that declares `properties` must list all of them in
  `required`.**

The free-tier Zen gateway says so in as many words:

> `In context=('properties', 'edits', 'items'), 'required' is required to be
> supplied and to be an array including every key in properties. Missing
> 'replace_all'.`

It refuses the whole request, so one optional field in one tool takes every
other tool in the call down with it.

A schema can pass the deny-list and fail this: `edit` declares six properties and
requires one, because it accepts a find-and-replace **or** an insertion, and
writing `required` over both would be a worse schema rather than a stricter one.
The schema stays as it is. `acceptsStrictSchema` returns `false`, and the driver
stops vouching.

A tool that declared no schema at all is refused too — the deny-list walks
nothing in `undefined` and finds nothing, so the guard is what stops a driver
claiming strict for a schema it never received.

## What the drivers do with the answer

Zen sends `strict: false` for every tool on the **Responses** wire, which cannot
represent the contract at all, and on the chat-class wires claims it only where
`acceptsStrictSchema` says the schema would survive — `write` requires both of
its fields and keeps the guarantee, `edit` does not. The reference client,
OpenCode, sends `strict: false` on every tool to this same gateway.

In all of those cases the schema is retained unchanged and Namzu validates tool
inputs at execution. `strict` is a capability-dependent hint about how the model
generates, not a second contract: a tool rejected under non-strict generation
costs a turn the model can retry, while a request refused wholesale costs every
tool in it.

## Related

- [Portable tool schemas](tool-schema-portability.md) — the dialect intersection
  every schema is rendered into before it reaches a provider.
- [Zen and Zen Go](zen.md) — where the chat-class wire decides the flag.
