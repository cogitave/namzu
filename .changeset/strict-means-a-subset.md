---
'@namzu/sdk': minor
'@namzu/anthropic': patch
---

the edit tool's schema could not be sent under strict validation

Strict tool input is not "JSON Schema, enforced" — it is a **subset** of JSON
Schema, and a keyword outside that subset is not degraded. The vendor rejects
the whole request, so one unexpressible field in one tool takes every other
tool down with it and the turn dies before producing a token.

The `edit` tool declared its integer-or-`"end"` field with `oneOf`, which is
outside the subset while the equivalent `anyOf` is inside it. Measured against
the live API:

| body | result |
|---|---|
| `strict: true` + `oneOf` | **400** — `Schema type 'oneOf' is not supported` |
| `strict: false` + `oneOf` | accepted |
| `strict: true` + `anyOf` | accepted |

The middle row is why nothing caught it. Neither half is wrong on its own — the
schema is valid JSON Schema, and marking the tool strict is correct policy — so
no test of either one failed. Only the pairing did, and the pairing had no
owner. Every agent using the built-in `edit` tool on a model at or above the
strict gate lost its first tool-carrying turn to a 400.

`oneOf` is now `anyOf` (equivalent here — the branches are disjoint), and
`minimum` is gone from the model-facing schema for the same reason: numeric
bounds are outside the subset too. The bound is not lost, the execution schema
still enforces it.

**The general fix is the second half.** `assertStrictSchema` and
`findStrictSchemaViolations` are exported from `@namzu/sdk`, and the driver now
checks every schema it is about to mark strict — refusing with the exact path
and the remedy rather than letting the request go and getting back an error
that names the keyword but not where it lives:

```
Tool "edit" is marked for strict input validation, but its model-facing schema
uses 1 construct(s) the strict subset does not accept…
  edit.properties.insertLine.oneOf — use `anyOf` — for disjoint branches the two are equivalent
```

A test sweeps every built-in tool that asks for strict validation, so the next
one is caught in the suite rather than in production.
