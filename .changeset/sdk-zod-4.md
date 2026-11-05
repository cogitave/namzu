---
'@namzu/sdk': major
---

The SDK now builds, validates and describes tool input with Zod 4. The `zod` peer range moves from `^3.23.0` to `^4.1.0`, and `zod-to-json-schema` is no longer a peer dependency: the kernel renders JSON Schema with Zod's own `z.toJSONSchema`, and that package cannot read a Zod 4 schema.

What breaks, and what to do:

- A tool, connector or config schema written with Zod 3 is refused. Upgrade `zod` to 4 in your project and, if you annotate a schema as `z.ZodType<Out, z.ZodTypeDef, In>`, write `z.ZodType<Out, In>`. A Zod 3 schema handed to `defineTool` fails when the kernel first describes it to a model, with a message that names the cause.
- Your own `z.record(valueSchema)` calls need two arguments in Zod 4: `z.record(z.string(), valueSchema)`.
- A `z.unknown()` or `z.any()` field in an object schema is now required, where Zod 3 let the key be absent. Add `.optional()` to keep a field optional. The built-in webhook connector's `payload` keeps accepting a send without one.
- `RuntimeConfigSchema.compaction` still defaults to the full set of compaction defaults when absent.
- `z.string().uuid()` is stricter in Zod 4: it checks the version and variant digits, so an id such as `11111111-1111-1111-1111-111111111111` no longer passes. Ids the kernel mints are unaffected. Use `z.guid()` to accept any UUID-shaped string.
- The text of a validation failure that the model reads (`Invalid arguments for "tool": ...`) is Zod 4's wording, for example `Invalid input: expected string, received undefined` where Zod 3 said `Required`.
