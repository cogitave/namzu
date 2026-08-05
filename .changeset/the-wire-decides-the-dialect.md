---
'@namzu/sdk': minor
'@namzu/anthropic': major
'@namzu/bedrock': major
'@namzu/http': major
---

tool schemas are rendered in the dialect each wire actually parses

A tool with a tuple-shaped field took down every request that offered it. The
kernel renders one canonical JSON Schema in draft-07, where a tuple is
`items: [a, b]`; one of the wires namzu speaks validates tool input as JSON
Schema 2020-12, where that spelling is invalid and a tuple must be
`prefixItems`. Every driver forwarded the rendering verbatim, so the built-in
`read` tool — whose `readRange` is a Zod tuple — produced a 400 that rejected
the **whole** request, taking every other tool in the call down with it. The
turn died before generating a token.

The failure had nothing to do with strict tool use, which is why the guard
added for the previous schema outage never saw it: it fires with strict
validation unset, and with strict on the dialect error arrives *first*.

Which dialect a wire parses is a property of the wire, so the conversion now
happens at each driver's boundary rather than in the renderer:

```ts
import { toSchemaDialect, findDraft07Only } from '@namzu/sdk'

toSchemaDialect(schema, '2020-12') // items: [a, b]  ->  prefixItems: [a, b]
findDraft07Only(schema) // paths that no 2020-12 parser will accept
```

`renderToolSchema` is exported now too, so a caller assembling its own tool
payload gets the same memoized, `$schema`-stripped, deep-frozen rendering the
kernel puts on the wire — byte-identical across iterations, which matters
because the tools block sits at position 0 of the prompt-cache prefix.

`ToolCatalog` used to convert schemas through its own inline call with the same
options. Same output, none of the guarantees: no `$schema` stripping, no
memoization, no freeze. It goes through `renderToolSchema` now.

**Breaking, for the three drivers.** Their `@namzu/sdk` peer range was
`>=1.3.0` and is now `>=6.0.0`. That range was already wrong — the drivers call
kernel functions added well after 1.3.0 — and it would now let a package
manager install a combination that throws on every request carrying a tool.
Upgrade the kernel alongside the driver.

The conversion follows the model on multi-vendor wires. Bedrock's Converse API
carries several vendors through one request shape, and the 2020-12 requirement
was measured on one of them, so schemas bound for the others are left in the
dialect they were rendered in. Guessing there would trade a known break for an
unmeasured one.
