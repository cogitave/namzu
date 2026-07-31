---
'@namzu/sdk': minor
---

Add structured final output — and fix two bugs it uncovered on the tool-result
wire path.

**Structured output.** Both leaf pieces already shipped and neither was
reachable: `createStructuredOutputTool` is excluded from `getBuiltinTools()`
because it needs a schema, and `StructuredOutputConfig` was referenced by
exactly one non-test line — the barrel re-export. A host needing
`{verdict, findings}` from an agent that also uses tools had to register the
tool by hand and hope: nothing forced the call, nothing stopped the loop when
it came, and a schema mismatch surfaced as a `ZodError` *after* the run had
paid for itself.

`query({ structuredOutput: { schema } })` registers the tool **from iteration
zero** — tools render at prefix position 0, so late injection would invalidate
the prompt cache for the rest of the run — validates the call, lands the parsed
value on `Run.structuredOutput`, and ends the run there rather than paying for
another turn that would only restate it. A model that answers in prose is
re-prompted, bounded by `maxRetries` (default 2), after which the run settles
with the new `StopReason: 'structured_output_failed'` instead of grinding
against `maxIterations`.

**Two bugs found while testing it**, both on the path between what a tool
returns and what reaches the provider, and both introduced by the content-block
migration:

- `ToolExecutor`'s final return omitted `isError`, so a failed tool was never
  marked as failed on the message and `is_error` could not reach the wire.
- The executor's local `result` was typed as a narrowed literal that dropped
  `content`, so a tool returning an image block had it discarded before the
  mapper built to carry it ever saw it.

The mapper tests passed throughout because they set those fields by hand. A new
suite covers the executor→message seam directly, which is where both lived.
