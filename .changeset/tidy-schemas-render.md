---
'@namzu/sdk': patch
---

Normalize and memoize the tool schema that goes on the wire, and stop
losing MCP schemas in translation.

- `$schema` (`http://json-schema.org/draft-07/schema#`) was stamped on
  every tool's parameters and sent on every request. No provider reads it,
  and it rides in the tools block — position 0, inside the cached prefix.
  Stripped.
- `toLLMTools` re-walked every registered tool's Zod tree once per
  iteration. Rendering is now memoized on the schema object and deeply
  frozen, so it is both free and byte-identical across iterations — the
  tools block heads the prompt-cache prefix, and a single reordered key
  invalidates the whole run's cache.
- `mcpJsonSchemaToZod` collapsed `array` to `z.array(z.unknown())` and
  `object` to `z.record(z.unknown())`. Because a bridged tool's schema
  round-trips (server JSON Schema → Zod → JSON Schema on the wire), every
  MCP tool taking a structured argument was shown to the model as "an
  array of anything" or "an object with any keys" — nested properties,
  item types, enums and descriptions all gone. It is now recursive and
  faithful: nested objects, array items, enums, `const`, `anyOf`/`oneOf`,
  nullable (`type: ['string','null']`), descriptions and defaults survive.
- MCP objects default to closed (`additionalProperties: false`) instead of
  `.passthrough()`, so the model is no longer told it may invent arguments
  the server never declared. A server that explicitly sets
  `additionalProperties: true` is still honored.
