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
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.env.NAMZU_LOG_LEVEL === undefined) {
	process.env.NAMZU_LOG_LEVEL = 'silent'
}

// Production now routes generated state through NAMZU_HOME. Give every test
// worker an owned application home so a command-level test can never inspect
// or mutate the developer's real sessions merely because it exercises the
// production entry point. Preserve an explicit value for tests that launch
// this suite under a deliberately chosen state root.
if (process.env.NAMZU_HOME === undefined) {
	process.env.NAMZU_HOME = mkdtempSync(join(tmpdir(), 'namzu-cli-tests-'))
}
