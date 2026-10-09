---
"@namzu/sdk": minor
---

A failed model request on a turn that has no token limit anywhere above it no longer blocks that turn's next request. Before, an unanswered request (a 502, a dropped stream) left the account "in flight" and unresolved, so the same turn could never ask again and a host could only abandon it. The request still stays recorded as unknown spend, never as zero, and a late usage frame for it is still added.

A turn with any finite limit (its own, or on an account above it) behaves exactly as before: unknown spend still refuses the next request, because the unknown amount may already exceed the limit. `SessionTokenBudget.bounded` reports which of the two an account is. If you depend on the old refusal for an unlimited turn, check `summary().unresolvedRequests` yourself; nothing else changes for limited turns.
