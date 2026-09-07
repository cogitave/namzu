---
"@namzu/sdk": minor
---

Add `buildRunCodeTool({ toolResultMode: 'structured' })` so successful nested
calls return `{ output, data? }` and programs can filter tool data without parsing
display text. The default remains the output string. Failed calls still reject,
and all requests retain the run's authorization, lineage and cancellation rules.
