---
'@namzu/sdk': major
---

Make topic-state and objective revisions real compare-and-set commits across concurrent calls and processes.

The in-memory stores now keep each read/check/write in one JavaScript turn. The disk stores publish complete, immutable revision files through exclusive hard links, preserve the former single-file record as a forward-readable compatibility projection, reject damaged or mixed-version projection/head states, and encode opaque ids so they cannot escape the configured root. Cross-tenant mutations now reject with `TenantIsolationError` instead of treating a hidden record as absent, and objective `maxRounds` must be a positive safe integer.

**What breaks:** disk-backed topic stores now require hard-link support and refuse unsupported filesystems instead of degrading to a racy read-check-replace write. Stop every process using an older SDK before opening a shared store root with this version; mixed-version rolling writers are unsupported because the old implementation cannot see immutable revision commits. Callers that passed fractional, infinite, `NaN`, or unsafe `maxRounds` values must pass a positive safe integer, and callers performing cross-tenant mutations must handle `TenantIsolationError`.
