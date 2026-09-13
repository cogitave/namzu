---
"@namzu/sdk": patch
"@namzu/cli": patch
---

Report unavailable automatic historical evidence in temporary model context instead of silently dropping every sign of a failed query plan or read. The short status distinguishes planning failure, retrieval failure, timeout and an earlier read still pending; it does not imply that the requested history is absent.

Raw error bodies, malformed plans and rejected source data stay out of the note. Existing error diagnostics and direct callback rejections remain, parent cancellation stops work, and context/read bounds still apply. Explicit archive tools remain available, and a failed cached query plan does not trigger an extra model call each iteration. No status note is stored as operator conversation history.
