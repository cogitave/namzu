/**
 * Vitest `setupFiles` entry for `@namzu/cli`.
 *
 * Before LOG-05, every one of `run`/`drain`/`run-stream`/the TUI forced the
 * SDK logger's level to `silent` via `configureLogger` on its way into a
 * real session, so the CLI's own test suite got a quiet stderr for free —
 * a side effect of the exact bug LOG-05 exists to fix. Now that each entry
 * point installs a REAL sink at a level it resolves from
 * `--verbose`/`--quiet`/`NAMZU_LOG_LEVEL` (`../logging.ts`), a test whose
 * fixture `ctx` omits `logging` falls back to that same resolution — which
 * reads the live environment. Defaulting `NAMZU_LOG_LEVEL` to `silent`
 * here keeps that fallback quiet, matching pre-LOG-05 test output, without
 * touching the dozen-plus test files across this package that build a
 * `ctx` by hand and have never had reason to care what level logging runs
 * at.
 *
 * Only set when unset, so a contributor debugging a specific test with
 * `NAMZU_LOG_LEVEL=debug pnpm test` gets what they asked for.
 */
if (process.env.NAMZU_LOG_LEVEL === undefined) {
	process.env.NAMZU_LOG_LEVEL = 'silent'
}
