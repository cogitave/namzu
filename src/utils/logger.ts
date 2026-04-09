export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogContext = Record<string, unknown>

const LOG_LEVELS: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
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

export function getRootLogger(): Logger {
	if (!_rootLogger) {
		_rootLogger = createLoggerImpl('namzu', 'info', {})
	}
	return _rootLogger
}

export function configureLogger(options: { level?: LogLevel }): void {
	_rootLogger = createLoggerImpl('namzu', options.level ?? 'info', {})
}
