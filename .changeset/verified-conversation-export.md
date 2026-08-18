---
'@namzu/cli': minor
'@namzu/sdk': minor
---

Add `/export [path]` to write a no-clobber Markdown conversation from durable CLI turn bindings and event-head-verified SDK run evidence. Legacy conversations and unresolved fork prefixes refuse instead of producing a partial file.

Add `ReadRunEventsOptions.integrity`. The default `tolerant` mode retains the existing damaged-line skip behavior; `strict` refuses torn, malformed, or discontinuously numbered event logs for callers that need a completeness proof.
