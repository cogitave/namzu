---
"@namzu/sdk": major
---

Tool schemas now go on the wire in a shape every provider reads the same way, instead of a draft-07 rendering each driver was expected to translate.

**What broke, and why this is the fix.** `read`'s `readRange` was a `z.tuple`, which renders as the draft-07 tuple `items: [a, b]`. A wire that validates a tool's `parameters` against the JSON Schema 2020-12 metaschema does not read that as a tuple — it reads it as "not a schema" and refuses the entire request, so one field in one tool killed every other tool in the call and the turn produced nothing. Three of the ten driver packages convert dialects at their boundary; the other seven forward the rendering verbatim, because their wires had never been measured. Converting in seven more places would need seven more measurements, including for endpoints a user configures and nobody here can probe. So the schema is fixed where it is made: the renderer now emits the intersection of draft-07 and 2020-12, which needs no conversion anywhere.

**Take this upgrade if you talk to any provider that is not Claude-backed.** Nothing you write changes; what changes is which requests come back 400.

Breaking:

- **`renderToolSchema` no longer emits a tuple.** A `z.tuple([a, b])` now renders as `{"type":"array","items":{…},"minItems":2,"maxItems":2}` — members deduplicated, or `anyOf` of them when they differ — rather than `items: [a, b]`. If you pinned the rendered bytes of a tuple-shaped tool, or built a driver that depends on receiving the draft-07 spelling in order to convert it, update the expectation. `toSchemaDialect` still exists and still converts; it is simply no longer needed for schemas this kernel rendered.
- **`ReadWindowRequest.readRange` is `readonly number[]`, not `readonly [number, number]`.** `z.infer` over `read`'s input schema changes with it. Passing a pair still type-checks; reading one out now needs an undefined check. `resolveReadWindow` already does that and ignores a range that is not two numbers, which the tool's own parser rejects before it ever gets there.
- **A bridged MCP tool's positional array reaches the model as a uniform array plus a description naming each position**, where a server that pinned the arity and closed the tail previously produced `prefixItems`. The Zod parser is unchanged and still enforces the order and the member types; only the hint the model is shown is now portable.

`read`'s parameter did NOT change for the model. It is still `readRange: [start, end]`, 1-indexed and inclusive, and the same calls parse to the same values — both members already carried the identical `integer, minimum 1` constraint, so nothing was expressible in the tuple that the array cannot say.

Added:

- `findPortableSchemaViolations(schema)` — every place a schema leaves the intersection, each with its dotted path, keyword and remedy. Use it as a gate over your own tools; the kernel sweeps all of its own with it.
- `toPortableToolSchema(schema)` — the normaliser, returning the input unchanged when there is nothing to rewrite.
- `toolWireSchema(tool)` — the schema a tool actually sends: its hand-written `modelInputSchema` when it has one, else its rendering, portable either way.
- `PortableSchemaViolation`.
