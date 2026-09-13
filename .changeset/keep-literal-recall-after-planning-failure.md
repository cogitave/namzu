---
"@namzu/sdk": patch
---

Keep bounded evidence retrieval available when optional query planning fails.
Recall can search the unchanged current-query tokens and deliver validated
records together with the planning failure status, without importing terms from
an invalid plan. The existing read, candidate, context and cancellation limits
still apply. Failed planning remains diagnostic and is not retried every step;
retrieved evidence is freshly validated. Explicit archive tools remain available
when literal retrieval cannot resolve the question.
