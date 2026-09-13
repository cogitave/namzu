---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add bounded resident activity inspection and a reusable consumption projection in the SDK. The CLI's new `namzu resident inspect` command reports retained admissions, settlements, archived pursuits, historical verification receipts and known versus missing usage across process restarts.

Root usage and descendant-inclusive token totals remain separate. Missing or interrupted receipts are explicitly incomplete; unpriced tokens do not imply free work. Cost reports cover the root invocation, not descendant prices or a provider bill. Inspection does not impose a new lifetime spending limit or change existing execution defaults. Use `--max-revisions` or the returned `--cursor` to inspect histories beyond the default bounded range.
