---
'@namzu/sdk': patch
---

Test-side hardening from ses_006 pre-freeze fix.

- **New test: `runtime/query/iteration/phases/advisory.test.ts`** — pins the advisory-phase mutation boundary where fired advisories inject user messages via `runMgr.pushMessage(createUserMessage(...))`. 13 assertions covering early-return paths, happy-path exactly-once calls, envelope format, warnings + decisions rendering, and trigger-selection semantics. Before this test a regression removing the `pushMessage` call at `advisory.ts:154` would pass typecheck, lint, the coverage gate, and every existing `src/advisory/*` test. It now fails deterministically.
- **`LogLevel` gains `'silent'`** — purely additive; the value short-circuits every `log()` call. Used by the SDK's vitest setup to suppress unmocked `getRootLogger()` stderr writes so GitHub Actions stops annotating `[ERROR]`-level log lines as workflow errors. Consumer impact: zero unless you pass `'silent'` to `configureLogger()` yourself.
- No runtime behavior change. No public surface additions beyond the one `LogLevel` union member.
