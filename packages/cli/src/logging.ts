/**
 * Log level + format resolution for the CLI's five entry points that used
 * to force the SDK logger's level to `silent` via `configureLogger` and
 * never turn it back on: `tui/index.tsx`, `commands/run.ts`,
 * `commands/drain.ts` and `commands/run-stream.ts` (twice — `run-stream`
 * itself and `providers-json`). LOG-05.
 *
 * Kept out of `config/load.ts`'s cascade on purpose. That system merges
 * four sources for `format`/`quiet`/`permissions`/`sandbox`, all of them
 * either boolean or a closed enum with a config-file counterpart.
 * `NAMZU_LOG_LEVEL` has no config-file counterpart in this increment and is
 * not boolean-shaped — it names a level directly, string-valued, the same
 * way `--verbose`/`--quiet` do. Precedence here is exactly what the design
 * specifies and nothing more: an explicit flag beats the environment beats
 * the default that used to be silence.
 */

import type { LevelFilter, LogSink } from '@namzu/sdk'
import { jsonLinesSink, prettySink } from '@namzu/sdk'

export type LogFormat = 'pretty' | 'json'

/** What every entry point installs as its process sink, resolved once per
 *  invocation in `cli.ts#getContext()` and threaded through
 *  `CommandContext`/`TuiContext`. */
export interface ResolvedLogging {
	readonly level: LevelFilter
	readonly format: LogFormat
}

const LEVEL_FILTERS = new Set<string>(['debug', 'info', 'warn', 'error', 'silent'])

function isLevelFilter(value: string | undefined): value is LevelFilter {
	return value !== undefined && LEVEL_FILTERS.has(value)
}

export interface LogLevelFlags {
	/** `-v, --verbose` as Commander parsed it — `undefined` unless given. */
	readonly verbose?: boolean
	/**
	 * `-q, --quiet` as Commander parsed it — `undefined` unless given.
	 * Reuses the CLI's existing global flag rather than minting a second
	 * "quiet" that means something different depending which one you typed.
	 */
	readonly quiet?: boolean
}

/**
 * `--verbose` -> `debug`, `--quiet` -> `warn`, otherwise `NAMZU_LOG_LEVEL`
 * if it names a real level, otherwise `info` — the floor that used to be
 * silence.
 *
 * `cli.ts` declares `--verbose` and `--quiet` as a `.conflicts()`-paired
 * pair of Commander options, so through the CLI itself at most one of
 * `flags.verbose` / `flags.quiet` is ever true at once. The `verbose`-first
 * check below is what a caller that builds `LogLevelFlags` by hand — every
 * test in `logging.test.ts` — gets instead of relying on that invariant.
 */
export function resolveLogLevel(
	flags: LogLevelFlags,
	env: NodeJS.ProcessEnv = process.env,
): LevelFilter {
	if (flags.verbose) return 'debug'
	if (flags.quiet) return 'warn'
	return isLevelFilter(env.NAMZU_LOG_LEVEL) ? env.NAMZU_LOG_LEVEL : 'info'
}

export interface LogFormatFlags {
	/**
	 * `--log-format <pretty|json>`. Commander's `.choices(['pretty','json'])`
	 * already rejects anything else at parse time, so `undefined` is the
	 * only other value `cli.ts` can hand this. Re-checked below anyway
	 * because a caller building this by hand (every test in
	 * `logging.test.ts`) is not bound by what Commander would have refused.
	 */
	readonly logFormat?: string
}

export function resolveLogFormat(
	flags: LogFormatFlags,
	env: NodeJS.ProcessEnv = process.env,
): LogFormat {
	if (flags.logFormat === 'pretty' || flags.logFormat === 'json') return flags.logFormat
	return env.NAMZU_LOG_FORMAT === 'json' ? 'json' : 'pretty'
}

/**
 * The sink `run`/`drain` install, chosen by `--log-format`/
 * `NAMZU_LOG_FORMAT`. `run-stream` does NOT use this — its stderr is a
 * machine-read NDJSON channel regardless of the format flag, the same way
 * its stdout protocol is unaffected by anything the operator passes. See
 * `commands/run-stream.ts`.
 */
export function createStderrSink(format: LogFormat): LogSink {
	return format === 'json' ? jsonLinesSink(process.stderr) : prettySink(process.stderr)
}

/**
 * Falls back to the same resolution `cli.ts#getContext()` would have
 * produced with no flags and the live environment, for a `ctx`/`TuiContext`
 * a test built by hand without a `logging` field — a fixture omitting a
 * field it does not care about must not crash the handler it exercises.
 * Every production `ctx` carries `logging`; only a test double hits the
 * fallback, and `test-setup.ts` defaults `NAMZU_LOG_LEVEL` to `silent` so
 * that fallback stays quiet unless a test deliberately overrides it.
 */
export function contextLogging(ctx: { readonly logging?: ResolvedLogging }): ResolvedLogging {
	return ctx.logging ?? { level: resolveLogLevel({}), format: resolveLogFormat({}) }
}
