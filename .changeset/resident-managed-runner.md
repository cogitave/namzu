---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Add opt-in `ResidentHostRunOptions.keepAlive` while preserving the default idle-return behavior. A keep-alive invocation retains its original finite step budget and performs no model calls when no work is due; it requires a positive `maxIdleMs`.

Add `namzu resident start --max-steps <n>` for managed background execution, `stop` for exact-runner drainage, and `release <runner-id> --executor-stopped` for inspected crash recovery. Foreground and background CLI runners share exclusive immutable ownership. Status distinguishes live control replies from unresponsive retained state; failed cleanup does not establish drainage. No OS service or automatic replay is installed. Existing interrupted pursuit claims still require explicit reconciliation.
