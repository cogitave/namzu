---
'@namzu/sdk': minor
'@namzu/http': patch
---

a tool whose schema cannot carry the guarantee it asks for is refused at registration

The previous release fixed the `edit` tool's schema and added a check in the
Anthropic driver. That caught the bug, but in the wrong place: per request, in
one of the **two** drivers that mark tools strict, and only once something
actually ran.

`ToolRegistry` already refused `enforceModelInput` without a
`modelInputSchema`, and the comment above that check states the principle
exactly — *"Refusing at registration puts the error where the author can fix it
rather than at the first request."* The rule was written down; the new check was
somewhere else.

It is now beside its sibling. One asks whether a model schema **exists**; the
other asks whether it can **carry the guarantee the tool just requested**. A
tool that asks for constrained generation and supplies a schema the constrained
dialect cannot express is wrong at the moment it is declared, whichever model it
later meets — so it never registers, and can never reach a request.

```
Tool "edit" is marked for strict input validation, but its model-facing schema
uses 1 construct(s) the strict subset does not accept…
  edit.properties.insertLine.oneOf — use `anyOf` — for disjoint branches the two are equivalent
```

This is the only path that matters in practice: the kernel builds its tool list
with `ToolRegistry.toLLMTools()`, so every tool reaching a driver through the
normal loop passed the gate.

**A tool that never asked for the guarantee is untouched.** Without
`enforceModelInput` nothing is marked strict, the schema is sent as ordinary
JSON Schema, and `oneOf` is perfectly legal there. Refusing it would break
working setups for no reason.

`@namzu/http` also marks tools strict and had no check at all — the same bug
was reachable through it. It now has the driver-level check the Anthropic driver
already carried. Both remain as a second boundary for a host that hand-builds
`ChatCompletionParams` and calls a provider directly, bypassing the registry.

**If you author a tool with `enforceModelInput: true`,** a schema using `oneOf`,
`not`, `if`/`then`/`else`, numeric or length bounds, `patternProperties`, or an
`additionalProperties` other than `false` now throws at registration instead of
failing the first request that carries it. The message names the path and the
replacement.
