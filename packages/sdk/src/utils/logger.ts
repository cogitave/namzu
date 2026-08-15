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
		return createLoggerImpl(context.component ? String(context.component) : name, minLevel, {
			...parentContext,
			...context,
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
	if (!_rootLogger) {
		_rootLogger = createLoggerImpl('namzu', 'info', {})
	}
	return _rootLogger
}

/**
 * @deprecated See `getRootLogger`'s deprecation note. `installProcessSink`
 * is the strictly more capable replacement — it picks a destination, not
 * only a threshold. Unchanged behaviour; this JSDoc is the only edit.
 */
export function configureLogger(options: { level?: LogLevel }): void {
	_rootLogger = createLoggerImpl('namzu', options.level ?? 'info', {})
}
