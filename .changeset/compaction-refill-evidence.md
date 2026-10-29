---
"@namzu/sdk": patch
---

Fix false rapid-refill stops when useful compaction leaves the context above its trigger. The opt-in breaker now requires the history to regain the space shed by the previous compaction, using comparable before/after estimates, instead of treating closely spaced reductions alone as refills. Actual refill loops still stop, and provider-overflow recovery keeps its two-rung limit.
