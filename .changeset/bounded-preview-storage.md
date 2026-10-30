---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Prevent bounded tool previews and delegated-agent activity rows from retaining the backing storage of much larger source strings. Visible text, output limits and retained full-output recovery are unchanged; copied previews preserve all UTF-16 code units.

Explain that repeated compaction refills can result from little reclaimed space even with small outputs. Suggest checking the model context window instead of diagnosing an oversized file from the refill count alone. The compaction safety limits remain unchanged.
