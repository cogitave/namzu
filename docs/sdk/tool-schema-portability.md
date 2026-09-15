---
type: Reference
title: Portable tool schemas
description: One rendering valid in draft-07 and 2020-12, the profile that defines it and the normaliser that enforces it.
resource: packages/sdk/src/registry/tool/portable.ts
tags: [sdk, tools, providers, json-schema]
status: stable
---

# Portable tool schemas

A tool has one Zod schema. `renderToolSchema` turns it into the JSON Schema that
rides in the `tools` block of every request. What differs between providers is
the JSON Schema dialect the receiving wire parses, and the two dialects in play
disagree about exactly one construct a tool schema is likely to contain: the
positional array.

| construct | draft-07 | 2020-12 |
|---|---|---|
| `items: [a, b]` | a tuple | not a schema — the request is refused |
| `prefixItems: [a, b]` | unknown keyword — ignored, silently | a tuple |
| `items: { a }` | every element | every element |

Only the third row means the same thing on both. The kernel therefore renders
the **intersection**: a schema that is valid, and says the same thing, whichever
dialect reads it.

## The profile

`findPortableSchemaViolations(schema)` returns every place a schema leaves that
intersection, each with its dotted path, the keyword and the remedy. It is a
deny-list, and every entry names a wire that reads the construct wrong rather
than a style preference:

- **`items` holding an array**, `prefixItems`, `additionalItems` — the two
  spellings of a tuple and the draft-07 tail rule. One is refused outright; the
  other is dropped without complaint, which turns a constrained array into an
  unconstrained one.
- **`$ref`, `$defs`, `definitions`, `$id`, `$anchor`, `$dynamicRef`,
  `$dynamicAnchor`** — a tool schema has to stand alone. A wire that does not
  resolve references sees an empty constraint or refuses the document.
- **`unevaluatedItems`, `unevaluatedProperties`** — post-draft-07 vocabulary,
  with the same silent-drop hazard as `prefixItems`.
- **`$schema`** — nothing on any wire reads it, it rides inside the prompt-cache
  prefix, and asserting a dialect is the one thing a schema that must work on
  every wire must not do.
- **`type` holding an array** — valid in both dialects, but the OpenAPI-3.0
  shaped wires take a single type name. Write `anyOf` of single-typed schemas.

## The normaliser

`toPortableToolSchema(schema)` rewrites what can be rewritten and returns the
input unchanged — the same reference — when there is nothing to rewrite, so the
common case costs one walk and no allocation.

It rewrites the tuple spellings and drops `$schema`. A tuple becomes a uniform
array: one `items` schema (the members deduplicated, or their `anyOf` when they
differ) plus the arity as `minItems`/`maxItems`. A tuple closed only by
`additionalItems: false` gains the `maxItems` that keeps it closed, because a
uniform `items` says nothing about length.

It does **not** repair the rest of the deny-list. Inlining a `$ref`, or choosing
which member of a `type` list the author meant, is a guess about intent, and a
guess that silently changes what a tool accepts is worse than the 400 it avoids.
Those are reported and fixed at the source.

`normalizeToolSchema` runs it inside `renderToolSchema`, and `toolWireSchema`
runs it over a tool's hand-written `modelInputSchema` — the two paths by which a
schema reaches a provider's `tools` block.

### What the collapse costs

Which member sits where. The uniform array accepts `[1, "a"]` for a schema whose
members are `[string, number]`.

That loss is confined to the wire. The tool's Zod schema still parses the call
and still refuses a wrongly-ordered one with a message the model can act on, so
the wire schema is a weaker HINT, not a weaker contract. Where the positions
matter to the model — a bridged tool whose server declared them — they are
stated in the description instead, which every wire carries intact.

## `read`'s line range

`read`'s `readRange` is `[start, end]`, 1-indexed and inclusive, exactly as
before. It is declared as a length-2 array of positive integers rather than a
`z.tuple`, which renders as

```json
{ "type": "array", "items": { "type": "integer", "minimum": 1 }, "minItems": 2, "maxItems": 2 }
```

Both members always carried the identical constraint, so the tuple bought
nothing and cost the whole request on a wire that validates against the 2020-12
metaschema. What a model writes, and what the parser accepts, is unchanged.

## Relationship to dialect conversion

[`toSchemaDialect`](../../packages/sdk/src/registry/tool/dialect.ts) is not
replaced by this and does not become dead. A driver may be handed a `parameters`
object the kernel never rendered — a host passing `ChatCompletionParams` straight
in — and converting at the boundary remains the right answer there. What changes
is that the kernel's own tools no longer depend on a driver having made that
measurement: three of the ten driver packages convert, and the other seven are
now safe anyway.
