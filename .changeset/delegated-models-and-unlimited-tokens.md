---
"@namzu/cli": major
"@namzu/sdk": major
---

CLI runs and their children no longer default to finite cumulative token limits. Set limits.tokenBudget to 1000000 to retain the previous CLI tree limit. Iteration and cancellation limits remain active; token usage is still recorded.

Agent accepts model, provider and effort selections for a child without changing the parent conversation. Use agent_models to discover connected model IDs and published capabilities.

SDK AgentManager now honors explicit configOverrides.tokenBudget: 0 under an unlimited parent instead of substituting 200000. Specify 200000 to retain that previous behavior. TokenBudget.reserve(0) supports unlimited child accounts; finite ancestor budgets remain binding. Omitted SDK child budgets retain their existing fallback.
