---
"@namzu/sdk": major
"@namzu/cli": minor
---

An unresolved provider receipt no longer blocks healthy sibling accounts whose shared ancestors are unlimited. Finite shared allowances remain blocked, as does the account owning the unresolved receipt. To retain tree-wide blocking on unknown spend, configure a finite root token budget. Invalid accounting and failed persistence still block the entire tree.

Snapshots retain uncertainty on individual request records via unresolved; only explicit final-receipt reconciliation clears it. Cold restore marks pending requests unresolved. TokenBudgetSummary adds unresolvedRequests; poisoned now reports whether the observed account is blocked. CLI usage identifies incomplete measured totals instead of implying that unknown usage was free.
