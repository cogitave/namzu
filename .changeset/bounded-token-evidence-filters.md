---
"@namzu/sdk": patch
---

Reduce unnecessary retained-output reads during whole-token evidence search,
including the case-insensitive mode used by CLI automatic recall. New manifests
and disposable indexes carry small token-key Bloom filters. A negative skips
payload I/O; every potential match is still authenticated and matched against
original text. Literal search, scope, cancellation, query limits and exact-read
addresses retain their existing contracts.

Filters add storage and write work. Existing manifests without them or with a different runtime tag still scan
normally, and the writer omits this optional metadata when it would exceed the
existing manifest size ceiling. No data migration or configuration change is
required. The optimization can reach sparse matches within the existing I/O
budget; it does not guarantee exhaustive automatic recall.
