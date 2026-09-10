---
"@namzu/sdk": major
"@namzu/cli": major
---

Enabled compaction now deduplicates long, identical read-only text observations
in model requests by default. The first full result remains; later identical
results reference it. This changes the content seen by providers and model-call
hooks, while leaving tool execution and canonical conversation history intact.

To keep the previous request representation, set `deduplicateObservations: false`
in SDK compaction configuration, or `compaction.deduplicateObservations: false`
in CLI configuration. SDK runs without compaction configuration or with the
`disabled` strategy remain unchanged. Distinct outputs, partial ranges, errors,
retained results and results of tools not explicitly read-only are not merged.
