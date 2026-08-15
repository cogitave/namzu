import { createLogger } from './log/create-logger.js'
import { getProcessSink } from './log/process-sink.js'
import { type LevelFilter, type LogSink, SCOPE_ATTRIBUTE } from './log/types.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

export type LogContext = Record<string, unknown>

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
	// `silent` sits above every emit level so the `level < minLevelNum`
	// guard in `log()` always short-circuits when configured. Used by
	// test harnesses to suppress unmocked `getRootLogger()` stderr
	// writes; see packages/sdk/src/test-setup.ts.
	silent: 4,
}

export interface Logger {
	debug(message: string, data?: LogContext): void
	info(message: string, data?: LogContext): void
	warn(message: string, data?: LogContext): void
	error(message: string, data?: LogContext): void
	child(context: LogContext): Logger
}

function createLoggerImpl(name: string, minLevel: LogLevel, parentContext: LogContext): Logger {
	const minLevelNum = LOG_LEVELS[minLevel]

	function log(level: LogLevel, message: string, data?: LogContext): void {
		if (LOG_LEVELS[level] < minLevelNum) return

		const timestamp = new Date().toISOString()
		const prefix = `[${timestamp}] [${level.toUpperCase()}] [${name}]`
		const merged = { ...parentContext, ...data }
		const hasContext = Object.keys(merged).length > 0

		if (hasContext) {
			process.stderr.write(`${prefix} ${message} ${JSON.stringify(merged)}\n`)
		} else {
			process.stderr.write(`${prefix} ${message}\n`)
		}
	}

	function child(context: LogContext): Logger {
		const { [SCOPE_ATTRIBUTE]: scopeOverride, ...rest } = context
		return createLoggerImpl(typeof scopeOverride === 'string' ? scopeOverride : name, minLevel, {
			...parentContext,
			...rest,
		})
	}

	return {
		debug: (msg, data) => log('debug', msg, data),
		info: (msg, data) => log('info', msg, data),
		warn: (msg, data) => log('warn', msg, data),
		error: (msg, data) => log('error', msg, data),
		child,
	}
}

let _rootLogger: Logger | null = null

/**
 * @deprecated Prefer `installProcessSink` (own the process's log
 * destination) or `createLogger` (build a logger scoped to a run, tenant or
 * subsystem) from `packages/sdk/src/utils/log/`. `getRootLogger` and
 * `configureLogger` read and write one process-wide global with no
 * destination lever beyond a level threshold — the reason every CLI entry
 * point historically had only one option: switch it off entirely.
 * Unchanged behaviour; this JSDoc is the only edit.
 */
export function getRootLogger(): Logger {
	// A process sink, when one is installed, wins over both the cached logger
	// and the stderr default. Resolved per CALL rather than cached, for the
	// same reason the new pipeline reads its level per record: a logger handed
	// out before `installProcessSink` ran would otherwise keep writing to
	// stderr forever, which is the exact shape of the three frozen loaders
	// this migration just fixed.
	//
	// This bridge is what lets the ~39 existing `getRootLogger()` call sites
	// reach a host's sink without being rewritten in one commit. They keep the
	// old interface and gain the new destination.
	const installed = getProcessSink()
	if (installed) return fromSink(installed.sink, installed.level)

	if (!_rootLogger) {
		_rootLogger = createLoggerImpl('namzu', 'info', {})
	}
	return _rootLogger
}

/**
 * Fall back to the process root only when nobody supplied their own. Kept
 * here rather than inlined at each call site so a boundary that threads a
 * host-supplied logger can stay entirely free of `getRootLogger()` itself.
 * `RunContextFactory.buildLogger` was the first caller (LOG-07); LOG-10
 * moved every remaining constructor across `packages/sdk/src` onto this
 * same seam, so this function's own fallback is now the ONLY place in the
 * package that reads the process-wide global outside a host's direct call
 * to `getRootLogger()` itself. `getRootLoggerCount` in
 * `scripts/log-standard.json` measures exactly that: it cannot reach zero
 * while an optional, non-breaking fallback exists at all — removing the
 * fallback (flipping the default to `NOOP_LOGGER`) is LOG-20's major, not
 * this seam's.
 */
export function resolveLogger(logger: Logger | undefined): Logger {
	return logger ?? getRootLogger()
}

/**
 * Adapts the record pipeline back to the legacy `Logger` shape. `scope`
 * threads through recursive `child()` calls the same way `bound` does.
 * Previously fixed at `'namzu'` on every recursive call regardless of what
 * a caller bound — meaning every `getRootLogger()`-derived child logger
 * (the majority of call sites in this package) reported the SAME
 * `scope.name` no matter what `SCOPE_ATTRIBUTE` it was given. This is the
 * single highest-leverage line in the LOG-09 migration: see the direct
 * regression test in `runtime/query/__tests__/context.test.ts` and
 * `utils/__tests__/log-scope-attribute.test.ts`.
 */
function fromSink(
	sink: LogSink,
	level: LevelFilter,
	bound: LogContext = {},
	scope = 'namzu',
): Logger {
	const created = createLogger({
		sink,
		level: { current: level },
		resource: { 'service.name': 'namzu' },
		scope,
	})
	const write =
		(severity: 'debug' | 'info' | 'warn' | 'error') => (message: string, data?: LogContext) => {
			created[severity](message, { ...bound, ...data })
		}
	return {
		debug: write('debug'),
		info: write('info'),
		warn: write('warn'),
		error: write('error'),
		child: (context: LogContext) => {
			const { [SCOPE_ATTRIBUTE]: scopeOverride, ...rest } = context
			return fromSink(
				sink,
				level,
				{ ...bound, ...rest },
				typeof scopeOverride === 'string' ? scopeOverride : scope,
			)
		},
	}
}

/**
 * @deprecated See `getRootLogger`'s deprecation note. `installProcessSink`
 * is the strictly more capable replacement — it picks a destination, not
 * only a threshold. Unchanged behaviour; this JSDoc is the only edit.
 */
export function configureLogger(options: { level?: LogLevel }): void {
	_rootLogger = createLoggerImpl('namzu', options.level ?? 'info', {})
}
