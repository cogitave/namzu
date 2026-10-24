---
'@namzu/sdk': minor
---

Workflow scripts: `parallel()` and `pipeline()` no longer reject. A thunk that throws now resolves to `null` in its place, and a pipeline stage that throws drops that item to `null` (the other items go on); the reason is written through `log()`. Before, one throwing thunk failed the whole run with the siblings' work lost. A script that relied on the old rejection to stop the run must check for `null` itself (`.filter(Boolean)` or an explicit test). Nothing else in the public API changes.
