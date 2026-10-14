---
'@namzu/sdk': minor
'@namzu/zen': patch
---

Refuse to claim strict tool input generation where the wire would refuse the request.

`edit` and `write` set `enforceModelInput`, and the Zen driver answered that with
`strict: true` for both on the chat-class wires. The Zen free-tier gateway
enforces the strict subset's structural rule itself — every object that declares
`properties` must list all of them in `required` — and refuses the WHOLE request
when one tool fails, so `edit`'s optional fields (a find-and-replace OR an
insertion) took every other tool in the call down with it. `cat-jam-free` is the
model that enforces; the symptom was `Invalid schema for function 'edit'`.

- `@namzu/sdk` gains `acceptsStrictSchema(schema)`, the wider question a driver
  asks before claiming `strict: true` on one request: the keyword deny-list that
  `findStrictSchemaViolations` already runs, plus the structural rules, plus a
  guard for a tool that declared no schema at all (the deny-list walks nothing in
  `undefined` and finds nothing). It is additive; `findStrictSchemaViolations`
  and `assertStrictSchema` keep the registration-time job they had.
- `@namzu/zen` now sends `strict: acceptsStrictSchema(...)` for a tool named in
  `enforceToolInputSchema`, so `write` keeps the guarantee and `edit` sends
  `strict: false`. Responses still sends `strict: false` for every tool, as it
  did. Nothing about a schema changes, and Namzu validates tool inputs before
  execution either way.
- `edit`'s `insertLine` union branch `{ const: 'end' }` states no `type`, which
  the strict dialect has no spelling for; it is now `{ type: 'string', const:
  'end' }`. The validator reports any union branch that never states a type.

**What breaks.** A caller that relied on Zen sending `strict: true` for `edit`
loses constrained decoding for that one tool on the chat-class wires. To keep it,
the schema would have to require every field and make the optional ones nullable,
which changes what `edit` accepts on every provider.
