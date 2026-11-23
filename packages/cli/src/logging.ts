/**
 * Log level + format resolution for the CLI's five entry points that used
 * to force the SDK logger's level to `silent` via `configureLogger` and
 * never turn it back on: `tui/index.tsx`, `commands/exec.ts`,
 * `commands/drain.ts` and `commands/exec-json.ts` (twice — `exec --json`
 * itself and `providers list --json`). LOG-05.
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

import { createWriteStream, mkdirSync, openSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { LevelFilter, LogRecord, LogSink, Logger } from '@namzu/sdk'
import {
	NOOP_LOGGER,
	createLogger,
	getProcessSinkCounters,
	installProcessSink,
	jsonLinesSink,
	prettySink,
} from '@namzu/sdk'

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
 * The sink `exec`/`drain` install, chosen by `--log-format`/
 * `NAMZU_LOG_FORMAT`. `exec --json` does NOT use this — its stderr is a
 * machine-read NDJSON channel regardless of the format flag, the same way
 * its stdout protocol is unaffected by anything the operator passes. See
 * `commands/exec-json.ts`.
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

/**
 * The CLI's own process logger, and the reason it lives here.
 *
 * The kernel used to expose `getRootLogger()`, a process-wide global that
 * resolved to whatever sink was installed. LOG-20 removed it: a library
 * handing out an ambient logger means every consumer shares one destination
 * and one level, decided by whoever called last, and the kernel is not the
 * process owner.
 *
 * The CLI **is** the process owner, so the global belongs here. This is the
 * same bridge, scoped to one binary: `installCliLogging` installs the sink
 * and builds the logger from it in one step, so the two cannot drift, and
 * `cliLogger()` hands it to the call sites that used to reach for the
 * kernel's.
 *
 * Before installation it answers `NOOP_LOGGER` rather than writing to
 * stderr. A record produced before the destination is chosen has nowhere
 * correct to go, and silently defaulting to stderr is what made the old
 * global impossible to reason about — `exec --json` publishes NDJSON on
 * stdout and a stray line on the wrong stream corrupts a host's parse.
 */
let _cliLogger: Logger = NOOP_LOGGER

export function installCliLogging(chosenSink: LogSink, chosenLevel: LevelFilter): Logger {
	// With a debug file, every record down to debug goes to it; the sink the
	// entry point chose still sees only what its own level lets through.
	const sink = debugFileSink ? teeToDebugFile(chosenSink, chosenLevel, debugFileSink) : chosenSink
	const level: LevelFilter = debugFileSink ? 'debug' : chosenLevel
	installProcessSink(sink, level, { replace: true })
	_cliLogger = createLogger(
		{
			sink,
			// A mutable holder, read per record: the level is fixed for an
			// invocation, but `createLogger` reads it per record by design and
			// passing a literal would freeze it in a way the sink's does not.
			level: { current: level },
			resource: { 'service.name': 'namzu-cli' },
			scope: 'cli',
		},
		// The PROCESS's counter set, not a private one. `getLogCounters()` and
		// `namzu doctor`'s `logging.pipeline` check read that set; a logger
		// counting into its own would leave both reporting zeros while records
		// flowed.
		getProcessSinkCounters(),
	)
	return _cliLogger
}

const SEVERITY_RANK: Readonly<Record<string, number>> = { debug: 0, info: 1, warn: 2, error: 3 }

function teeToDebugFile(primary: LogSink, level: LevelFilter, file: LogSink): LogSink {
	return {
		emit(record: LogRecord) {
			file.emit(record)
			if (level === 'silent') return
			if ((SEVERITY_RANK[record.severityText] ?? 0) >= (SEVERITY_RANK[level] ?? 0))
				primary.emit(record)
		},
	}
}

let debugFileSink: LogSink | undefined

/**
 * `--debug-file <path>`: from now on every log record, debug level included,
 * is also written to this file as one JSON object per line. Only the folders
 * of the path given are created. A path that cannot be opened throws, with a
 * sentence for the person.
 */
export function openDebugFile(path: string): void {
	const target = resolve(path)
	try {
		mkdirSync(dirname(target), { recursive: true })
		const stream = createWriteStream(target, { fd: openSync(target, 'a', 0o600) })
		stream.on('error', () => undefined)
		debugFileSink = jsonLinesSink(stream)
	} catch (error) {
		throw new Error(
			`--debug-file could not open ${target}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
}

/** Test seam: stop writing to the debug file. */
export function __closeDebugFileForTests(): void {
	debugFileSink = undefined
}

/** The logger `installCliLogging` built, or a no-op if boot has not run. */
export function cliLogger(): Logger {
	return _cliLogger
}

/** Test seam: forget the installed logger. */
export function __resetCliLoggerForTests(): void {
	_cliLogger = NOOP_LOGGER
}
