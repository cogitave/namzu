---
"@namzu/cli": minor
---

Agent rows in the delegated-work rail, the agent cockpit and a child's transcript header now show the resolved child model and live token/tool-call counters when a host reported them: cumulative spend compacted to `42.1k`/`1.38M` and a `· N tools` count. Spend is the child's cumulative `token_usage_updated` usage, never its current context size — a different, shrinking number that would otherwise make a long-running child look like it was spending far more than it was. A child that has not yet reported usage shows an em dash rather than `0`, since "unknown" and "spent nothing" are different facts. On a narrow terminal the counters are dropped first, then the model name; the description is never truncated to make room for either, and a resolved model id long enough to threaten that (a self-hosted or gateway-style id can run well past a typical short name) is itself capped to a short label with an ellipsis rather than left to crowd the description out.

Minor, not patch: this is new operator-visible capability, not a fix. `SubagentActivity` (the type these fields were added to) is internal to `@namzu/cli`'s own TUI and is not exported from the package's public entry, so no published type changed shape for a consumer.
