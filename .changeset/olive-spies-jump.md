---
'@namzu/sdk': minor
---

Let `MockLLMProvider` declare capabilities and fail mid-tool-arguments.

Two small additions that let the scriptable mock absorb the last of the
hand-rolled test providers:

- `capabilities` overrides the declaration for one instance. Capability
  negotiation degrades a run when a driver says it cannot do something, and
  testing that path means being able to *say* it — a fixed registry-level
  declaration cannot express "a driver with no vision".
- `rawArguments` emits a raw string instead of serializing `args`, and
  `throwAfterArguments` throws mid-tool-block. Together they script a provider
  going idle while streaming tool JSON, which is precisely the failure the
  truncated-tool-input recovery path exists for — otherwise that path can only
  be tested by hand-rolling a provider, which is what everyone was doing.

Six of the eight `implements LLMProvider` fakes across the test suite are now
gone. The two that remain are in `registry.test.ts`, which checks that the
registry accepts arbitrary provider *constructors*; collapsing those would
defeat what they test.
