---
"@namzu/sdk": major
"@namzu/cli": major
---

Enforce one token allowance across a parent run and its delegated descendants.
Previously the parent and delegation pool each received the full configured
budget. Parent, child and SDK auxiliary model requests now share measured usage
and finite child reservations. Unknown provider spend blocks further admission.

Replace `AgentTaskContext.budgetTracker` with a shared `TokenBudget` account at
`budget`. Custom schedulers must expose that same account, and custom agents must
use the supplied provider/account for model work. Run and agent usage describe
own-run counters; the new `budget` summary reports
subtree usage separately. `RouterAgent.usage` previously included its delegate;
read `budget.treeTokens` for that aggregate and `delegateResult.cost` for child
pricing. Router and Pipeline report unpriced own tokens when their own calls
have no price attribution, instead of pairing own usage with a child cost or
a misleading zero.
Update consumers that assumed a parent and every child could independently spend
the full configured token budget. Foreign dispatch without metering is refused.

Durable run-state version 4 and checkpoint schema 2 reference an independent
canonical ledger. Old checkpoint readers must be upgraded before resuming these
runs. Missing ledgers, conflicting scopes/caps and unresolved provider receipts
are refused rather than resetting available tokens. In-memory accounts require
their authoritative handle on resume; moving a durable tree between processes
requires exclusive root ownership.
An explicitly recovered final provider receipt can be applied through
`reconcileRequest`; automatic recovery never clears unknown spend.

Fix the CLI's scheduler parameter forwarding so delegated work uses the parent
query's authority. Streaming usage includes the separate budget summary.
