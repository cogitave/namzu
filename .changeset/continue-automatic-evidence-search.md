---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add optional `EvidenceRecallBatch.continuations` with exported
`EvidenceRecallContinuation` hints for bounded, host-mounted read-only tools.
Incomplete recall now reports its status even when no new passage is selected,
so missing context cannot silently look like an exhaustive negative search.
Hint arguments and output are bounded within the existing context allowance.

CLI `search_conversation` accepts `cursor` alone to restore the original query,
case setting and excluded invocation. Automatic recall supplies these handles
when live or earlier-run traversal has more pages. The model can continue from
that position without replaying an action or starting the same scan again.
New searches still require a literal query. Scope, expiry, source-integrity
checks and read limits remain enforced; live handles require the same active
writer and never downgrade to another source. Automatic recall remains opt-in.
